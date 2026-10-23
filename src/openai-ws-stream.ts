/**
 * Custom OpenAI Responses streaming implementation.
 *
 * Bridges Pi's stream API to OpenAI's Responses WebSocket transport, while also
 * handling HTTP fallback, incremental continuation, and remote-compaction-aware
 * input replay.
 */
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  getDeclaredTools,
  normalizeContext,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type Usage,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai/compat";
import { createGrammarToolInputProperties } from "@earendil-works/pi-ai/api/constrained-sampling";
import { convertResponsesTools, processResponsesStream, type OpenAIResponsesStreamOptions } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { EventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { loadConfig } from "./config.ts";
import {
  applyRemoteHistoryPayloadPatch,
  isDirectOpenAIResponsesModel,
  modelKey,
  thinkingLevelToResponsesReasoning,
} from "./openai.ts";
import {
  type ResponseToolDefinition,
  type InputItem,
  isResponseObject,
  OpenAIWebSocketManager,
  type OpenAIWebSocketEvent,
  type OpenAIWebSocketManagerOptions,
  type ResponseObject,
} from "./openai-ws-connection.ts";
import {
  buildAssistantMessageWithZeroUsage,
  buildStreamErrorAssistantMessage,
} from "./stream-message-shared.ts";
import {
  buildCodexWebSocketHeaders,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
} from "./remote-compaction.ts";
import {
  getContinuationState,
  getRemoteCompactionState,
  setContinuationState,
} from "./state.ts";

type WsSession = {
  manager: OpenAIWebSocketManager;
  modelKey: string;
  lastContextLength: number;
  lastRequestKey?: string;
  warmUpAttempted: boolean;
  broken: boolean;
};

const wsRegistry = new Map<string, WsSession>();
const WARM_UP_TIMEOUT_MS = 8000;

type ReplayModelInfo = { input?: ReadonlyArray<string> };
type WsTransport = "sse" | "websocket" | "auto";
type ResponsesModel = Model<"openai-responses">;
type ModelDescriptor = { api: string; provider: string; id: string };
type WsOptions = SimpleStreamOptions & {
  openaiWsWarmup?: unknown;
  topP?: number;
  toolChoice?: unknown;
  serviceTier?: "auto" | "default" | "flex" | "priority";
  reasoningSummary?: "auto" | "concise" | "detailed" | null;
  text?: Record<string, unknown>;
};

function applyServiceTierPricing(
  usage: Usage,
  modelInfo: ModelDescriptor,
  serviceTier: OpenAIResponsesStreamOptions["serviceTier"],
): void {
  const priorityMultiplier = modelInfo.id === "gpt-5.5" ? 2.5 : 2;
  const multiplier = serviceTier === "flex" ? 0.5 : serviceTier === "priority" ? priorityMultiplier : 1;
  if (multiplier === 1) return;
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

function extractCacheWriteTokens(response: ResponseObject): number {
  const details = response.usage?.input_tokens_details as
    | { cache_creation_tokens?: unknown; cache_write_tokens?: unknown }
    | undefined;
  if (typeof details?.cache_creation_tokens === "number" && Number.isFinite(details.cache_creation_tokens)) {
    return details.cache_creation_tokens;
  }
  return typeof details?.cache_write_tokens === "number" && Number.isFinite(details.cache_write_tokens)
    ? details.cache_write_tokens
    : 0;
}

function resolveResponsesReasoning(
  model: Model<any>,
  options: WsOptions | undefined,
): { effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"; summary?: "auto" | "concise" | "detailed" | null } | undefined {
  if (!model.reasoning) return undefined;
  const configured = thinkingLevelToResponsesReasoning(options?.reasoning);
  if (!configured) {
    return model.provider !== "github-copilot" ? { effort: "none" } : undefined;
  }
  return {
    effort: configured.effort,
    summary: options?.reasoningSummary ?? configured.summary ?? "auto",
  };
}

function asResponsesModel(model: Model<any>): ResponsesModel {
  return model as ResponsesModel;
}

function getModelDescriptor(model: { api: string; provider: string; id: string }): ModelDescriptor {
  return { api: model.api, provider: model.provider, id: model.id };
}

export function releaseWsSession(sessionId: string | undefined): void {
  if (!sessionId) return;
  const session = wsRegistry.get(sessionId);
  if (!session) return;
  try {
    session.manager.close();
  } catch {
    // ignore
  }
  wsRegistry.delete(sessionId);
}

export function releaseAllWsSessions(): void {
  for (const sessionId of wsRegistry.keys()) {
    releaseWsSession(sessionId);
  }
}

function responseFromEvent(event: OpenAIWebSocketEvent): ResponseObject | undefined {
  const response = (event as { response?: unknown }).response;
  return isResponseObject(response) ? response : undefined;
}

function eventString(event: OpenAIWebSocketEvent, key: string): string | undefined {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function resolveWsTransport(options: SimpleStreamOptions | undefined): WsTransport {
  const transport = (options as { transport?: unknown } | undefined)?.transport;
  return transport === "sse" || transport === "websocket" || transport === "auto"
    ? transport
    : "auto";
}

function resolveWsWarmup(options: SimpleStreamOptions | undefined): boolean {
  const warmup = (options as WsOptions | undefined)?.openaiWsWarmup;
  return warmup === true;
}

function buildWsRequestKey(params: {
  model: Model<any>;
  context: Context;
  tools: ResponseToolDefinition[];
  options: WsOptions | undefined;
}): string {
  return JSON.stringify({
    model: params.model.id,
    instructions: getCurrentSystemPrompt(params.context.messages) || undefined,
    tools: params.tools.length > 0 ? params.tools : undefined,
    temperature: params.options?.temperature,
    max_output_tokens: params.options?.maxTokens,
    top_p: params.options?.topP,
    tool_choice: params.options?.toolChoice,
    service_tier: params.options?.serviceTier,
    reasoning: resolveResponsesReasoning(params.model, params.options),
    text: params.options?.text,
    metadata: params.options?.metadata,
  });
}

export function selectInputItemsForContinuation(params: {
  context: Context;
  model: ReplayModelInfo;
  session: Pick<WsSession, "lastContextLength">;
  currentModelKey: string;
  remoteCompactionState: ReturnType<typeof getRemoteCompactionState>;
  previousResponseId?: string | null;
}): Array<InputItem | Record<string, unknown>> {
  const { context, model, session, currentModelKey, remoteCompactionState, previousResponseId } = params;

  if (remoteCompactionState && remoteCompactionState.modelKey === currentModelKey) {
    return normalizeResponseItemsForPrompt(
      remoteCompactionState.explicitHistory,
      model,
    ) as Array<InputItem | Record<string, unknown>>;
  }

  if (previousResponseId && session.lastContextLength > 0) {
    const newMessages = context.messages.slice(session.lastContextLength);
    if (newMessages.length > 0) {
      return messagesToResponseItems(newMessages, model);
    }
  }

  return messagesToResponseItems(context.messages, model);
}

function buildResponseCreatePayload(params: {
  model: Model<any>;
  context: Context;
  inputItems: Array<InputItem | Record<string, unknown>>;
  tools: ResponseToolDefinition[];
  previousResponseId?: string | null;
  options: WsOptions | undefined;
}): Record<string, unknown> {
  const reasoning = resolveResponsesReasoning(params.model, params.options);
  return {
    type: "response.create",
    model: params.model.id,
    store: false,
    input: params.inputItems,
    instructions: getCurrentSystemPrompt(params.context.messages) || undefined,
    tools: params.tools.length > 0 ? params.tools : undefined,
    ...(params.previousResponseId ? { previous_response_id: params.previousResponseId } : {}),
    ...(params.options?.temperature !== undefined ? { temperature: params.options.temperature } : {}),
    ...(params.options?.maxTokens !== undefined ? { max_output_tokens: params.options.maxTokens } : {}),
    ...(params.options?.topP !== undefined ? { top_p: params.options.topP } : {}),
    ...(params.options?.toolChoice !== undefined ? { tool_choice: params.options.toolChoice } : {}),
    ...(params.options?.serviceTier !== undefined ? { service_tier: params.options.serviceTier } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(reasoning && reasoning.effort && reasoning.effort !== "none"
      ? { include: ["reasoning.encrypted_content"] }
      : {}),
    ...(params.options?.text ? { text: params.options.text } : {}),
    ...(params.options?.metadata ? { metadata: params.options.metadata as Record<string, string> } : {}),
  };
}

async function runWarmUp(params: {
  manager: OpenAIWebSocketManager;
  modelId: string;
  tools: ResponseToolDefinition[];
  instructions?: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (params.signal?.aborted) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`warm-up timed out after ${WARM_UP_TIMEOUT_MS}ms`));
    }, WARM_UP_TIMEOUT_MS);

    const abortHandler = () => {
      cleanup();
      reject(new Error("aborted"));
    };
    const closeHandler = (code: number, reason: string) => {
      cleanup();
      reject(new Error(`warm-up closed (code=${code}, reason=${reason || "unknown"})`));
    };
    const unsubscribe = params.manager.onMessage((event) => {
      if (event.type === "response.completed") {
        cleanup();
        resolve();
      } else if (event.type === "response.failed") {
        cleanup();
        reject(new Error(`warm-up failed: ${responseFromEvent(event)?.error?.message ?? "Response failed"}`));
      } else if (event.type === "error") {
        cleanup();
        reject(
          new Error(
            `warm-up error: ${eventString(event, "message") ?? "Unknown error"} ` +
              `(code=${eventString(event, "code") ?? "unknown"})`,
          ),
        );
      }
    });

    const cleanup = () => {
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", abortHandler);
      params.manager.off("close", closeHandler);
      unsubscribe();
    };

    params.signal?.addEventListener("abort", abortHandler, { once: true });
    params.manager.on("close", closeHandler);
    params.manager.warmUp({
      model: params.modelId,
      tools: params.tools.length > 0 ? params.tools : undefined,
      instructions: params.instructions,
    });
  });
}

async function fallbackToHttp(
  model: ResponsesModel,
  context: Context,
  options: SimpleStreamOptions | undefined,
  eventStream: AssistantMessageEventStream,
  signal?: AbortSignal,
): Promise<void> {
  const sessionId = options?.sessionId;
  const remoteCompactionState = sessionId ? getRemoteCompactionState(sessionId) : undefined;
  const continuationState = sessionId ? getContinuationState(sessionId) : undefined;
  const originalOnPayload = options?.onPayload;
  const mergedOptions = {
    ...(signal ? { ...options, signal } : options),
    onPayload: async (payload: unknown, payloadModel: Model<any>) => {
      let nextPayload = payload;
      if (payload && typeof payload === "object") {
        const payloadObj = { ...(payload as Record<string, unknown>) };
        if (remoteCompactionState && remoteCompactionState.modelKey === modelKey(model)) {
          nextPayload = applyRemoteHistoryPayloadPatch({
            payload: payloadObj,
            explicitHistory: normalizeResponseItemsForPrompt(remoteCompactionState.explicitHistory, model),
          });
        } else if (
          typeof payloadObj.previous_response_id === "string" &&
          continuationState?.modelKey === modelKey(model) &&
          typeof continuationState.contextLength === "number" &&
          continuationState.contextLength > 0
        ) {
          const newMessages = context.messages.slice(continuationState.contextLength);
          if (newMessages.length > 0) {
            payloadObj.input = messagesToResponseItems(newMessages, model);
            nextPayload = payloadObj;
          }
        }
      }
      const chained = await originalOnPayload?.(nextPayload, payloadModel);
      return chained ?? nextPayload;
    },
  } satisfies SimpleStreamOptions | undefined;
  const httpStream = streamSimpleOpenAIResponses(model, normalizeContext(context), mergedOptions);
  for await (const event of httpStream) {
    eventStream.push(event);
  }
}

async function fallbackToHttpResponses(
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  eventStream: AssistantMessageEventStream,
  signal?: AbortSignal,
): Promise<void> {
  return await fallbackToHttp(asResponsesModel(model), context, options, eventStream, signal);
}

export function createOpenAIWebSocketStreamFn(
  managerOptions: OpenAIWebSocketManagerOptions = {},
): StreamFunction {
  return (model, context, options) => {
    const eventStream = createAssistantMessageEventStream();

    queueMicrotask(() => {
      const run = async () => {
        const cfg = loadConfig(process.cwd());
        const modelInfo = getModelDescriptor(model);
        if (!cfg.enabled || !cfg.usePreviousResponseId || !isDirectOpenAIResponsesModel(model)) {
          return await fallbackToHttpResponses(model, context, options, eventStream);
        }

        const sessionId = options?.sessionId;
        const apiKey = options?.apiKey;
        const transport = resolveWsTransport(options);
        if (transport === "sse" || !sessionId || !apiKey) {
          return await fallbackToHttpResponses(model, context, options, eventStream);
        }

        let session = wsRegistry.get(sessionId);
        const currentModelKey = modelKey(model);
        if (session && session.modelKey !== currentModelKey) {
          releaseWsSession(sessionId);
          session = undefined;
        }
        if (!session) {
          const headers = {
            ...(managerOptions?.headers ?? {}),
            ...buildCodexWebSocketHeaders(sessionId),
          };
          session = {
            manager: new OpenAIWebSocketManager({ ...managerOptions, headers }),
            modelKey: currentModelKey,
            lastContextLength: 0,
            lastRequestKey: undefined,
            warmUpAttempted: false,
            broken: false,
          };
          wsRegistry.set(sessionId, session);
        }

        if (!session.manager.isConnected() && !session.broken) {
          try {
            await session.manager.connect(apiKey);
          } catch (error) {
            try {
              session.manager.close();
            } catch {
              // ignore
            }
            session.broken = true;
            wsRegistry.delete(sessionId);
            if (transport === "websocket") throw error;
            return await fallbackToHttpResponses(model, context, options, eventStream);
          }
        }

        if (session.broken || !session.manager.isConnected()) {
          if (transport === "websocket") {
            throw new Error("WebSocket session disconnected");
          }
          releaseWsSession(sessionId);
          return await fallbackToHttpResponses(model, context, options, eventStream);
        }

        const signal = options?.signal;
        const currentTools = getCurrentTools(context.messages);
        const compat = asResponsesModel(model).compat;
        const supportsOpenAIGrammarTools = compat?.supportsOpenAIGrammarTools ?? false;
        const tools = convertResponsesTools(currentTools, {
          supportsOpenAIGrammarTools,
          supportsStrictMode: compat?.supportsStrictMode ?? false,
        });
        const grammarToolInputProperties = createGrammarToolInputProperties(
          getDeclaredTools(context.messages),
          supportsOpenAIGrammarTools,
        );
        if (signal?.aborted) throw new Error("aborted");
        if (resolveWsWarmup(options) && !session.warmUpAttempted) {
          session.warmUpAttempted = true;
          try {
            await runWarmUp({
              manager: session.manager,
              modelId: model.id,
              tools,
              instructions: getCurrentSystemPrompt(context.messages) || undefined,
              signal,
            });
          } catch {
            // best effort only
          }
        }

        const remoteCompactionState = getRemoteCompactionState(sessionId);
        const continuationState = getContinuationState(sessionId);
        const typedOptions = options as WsOptions | undefined;
        const requestKey = buildWsRequestKey({
          model,
          context,
          tools,
          options: typedOptions,
        });
        const incrementalAllowed = session.lastRequestKey === undefined || session.lastRequestKey === requestKey;
        const prevResponseId =
          remoteCompactionState && remoteCompactionState.modelKey === currentModelKey
            ? undefined
            : incrementalAllowed
              ? session.manager.previousResponseId ??
                (continuationState?.modelKey === currentModelKey ? continuationState.responseId : undefined)
              : undefined;
        const baselineContextLength =
          continuationState?.modelKey === currentModelKey && typeof continuationState.contextLength === "number"
            ? continuationState.contextLength
            : session.lastContextLength;
        const inputItems = selectInputItemsForContinuation({
          context,
          model,
          session: { lastContextLength: baselineContextLength },
          currentModelKey,
          remoteCompactionState,
          previousResponseId: prevResponseId,
        });

        const payload = buildResponseCreatePayload({
          model,
          context,
          inputItems,
          tools,
          previousResponseId: prevResponseId,
          options: typedOptions,
        });

        const nextPayload = (await options?.onPayload?.(payload, model)) ?? payload;
        const providerEvents = new EventStream<ResponseStreamEvent, void>(
          (event) => ["response.completed", "response.incomplete", "response.failed", "error"].includes(event.type),
          () => {},
        );
        const unsubscribe = session.manager.onMessage((event) => {
          const response = responseFromEvent(event);
          if (response?.usage) {
            providerEvents.push({
              ...event,
              response: {
                ...response,
                usage: {
                  ...response.usage,
                  input_tokens_details: {
                    ...response.usage.input_tokens_details,
                    cache_write_tokens: extractCacheWriteTokens(response),
                  },
                },
              },
            } as ResponseStreamEvent);
          } else {
            providerEvents.push(event as ResponseStreamEvent);
          }
        });
        const abortHandler = () => providerEvents.end();
        const closeHandler = (code: number, reason: string) => {
          providerEvents.push({
            type: "error", code: "websocket_closed", param: null, sequence_number: 0,
            message: `WebSocket closed mid-request (code=${code}, reason=${reason || "unknown"})`,
          });
        };
        signal?.addEventListener("abort", abortHandler, { once: true });
        session.manager.on("close", closeHandler);
        try {
          if (signal?.aborted) throw new Error("aborted");
          try {
            session.manager.send(nextPayload as Parameters<OpenAIWebSocketManager["send"]>[0]);
            session.lastRequestKey = requestKey;
          } catch (error) {
            releaseWsSession(sessionId);
            if (transport === "websocket") throw error;
            return await fallbackToHttpResponses(model, context, options, eventStream, signal);
          }

          const capturedContextLength = context.messages.length;
          const assistantMsg = buildAssistantMessageWithZeroUsage({
            model: modelInfo,
            content: [],
            stopReason: "pending",
          });
          eventStream.push({ type: "start", partial: assistantMsg });
          await processResponsesStream(providerEvents, assistantMsg, eventStream, model, {
            grammarToolInputProperties,
            serviceTier: typedOptions?.serviceTier,
            onProviderStreamEvent: options?.onProviderStreamEvent,
            applyServiceTierPricing: (usage, tier) => applyServiceTierPricing(usage, modelInfo, tier),
          });
          if (signal?.aborted) throw new Error("aborted");
          const reason = assistantMsg.stopReason;
          if (reason !== "stop" && reason !== "length" && reason !== "toolUse") {
            throw new Error(assistantMsg.errorMessage ?? "OpenAI WebSocket response did not complete successfully");
          }
          if (!assistantMsg.responseId) throw new Error("OpenAI WebSocket completed event had no response ID");
          session.lastContextLength = capturedContextLength;
          setContinuationState(sessionId, {
            responseId: assistantMsg.responseId,
            modelKey: currentModelKey,
            updatedAt: Date.now(),
            contextLength: capturedContextLength,
          });
          eventStream.push({ type: "done", reason, message: assistantMsg });
        } finally {
          signal?.removeEventListener("abort", abortHandler);
          session.manager.off("close", closeHandler);
          unsubscribe();
          providerEvents.end();
        }
      };

      run().catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const sessionId = options?.sessionId;
        if (sessionId) releaseWsSession(sessionId);
        const reason = options?.signal?.aborted ? "aborted" : "error";
        eventStream.push({
          type: "error",
          reason,
          error: {
            ...buildStreamErrorAssistantMessage({
              model: getModelDescriptor(model),
              errorMessage,
            }),
            stopReason: reason,
          },
        });
        eventStream.end();
      });
    });

    return eventStream;
  };
}
