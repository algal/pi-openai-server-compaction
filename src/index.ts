/**
 * Main extension entrypoint.
 *
 * Wires together request patching, remote compaction, runtime state
 * reconstruction, session lifecycle cleanup, and provider override registration.
 */
import { buildSessionContext, convertToLlm, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isRecord, loadConfig } from "./config.ts";
import { streamOpenAIResponsesWithPhase2B } from "./custom-stream.ts";
import {
  applyPayloadPatch,
  applyRemoteHistoryPayloadPatch,
  extractAssistantResponseId,
  extractResponsesReasoningConfig,
  extractResponsesTextConfig,
  messageMatchesModel,
  modelKey,
  supportsPreviousResponseId,
  supportsRemoteCompactionModel,
  thinkingLevelToResponsesReasoning,
  usesExplicitRemoteCompactionHistory,
} from "./openai.ts";
import { releaseAllWsSessions, releaseWsSession } from "./openai-ws-stream.ts";
import {
  buildCompactionSummaryText,
  buildRemoteCompactionDetails,
  buildToolsPayload,
  callRemoteCompactionEndpoint,
  generateBestEffortLocalSummary,
  messagesToResponseItems,
  normalizeResponseItemsForPrompt,
  reconstructRemoteCompactionStateFromBranch,
} from "./remote-compaction.ts";
import { resolvePhysicalModel, resolveRequestModel } from "./routed-model.ts";
import {
  clearAllContinuationState,
  clearContinuationState,
  clearRemoteCompactionState,
  clearResponsesRequestShapeState,
  getContinuationState,
  getRemoteCompactionState,
  getResponsesRequestShapeState,
  setContinuationState,
  setRemoteCompactionState,
  setResponsesRequestShapeState,
} from "./state.ts";

type TargetModel = Parameters<typeof modelKey>[0];

type BranchEntry = {
  type: string;
  id: string;
  details?: unknown;
  message?: unknown;
  thinkingLevel?: unknown;
};

type SessionContextLike = {
  sessionManager: {
    getSessionId(): string;
    getBranch(): BranchEntry[];
  };
};

function getSessionId(ctx: SessionContextLike): string {
  return ctx.sessionManager.getSessionId();
}

function getBranchMessages(branchEntries: BranchEntry[]): AgentMessage[] {
  // Raw branches include history already replaced by compaction and recovery
  // edits. A new remote checkpoint must summarize only finalized context.
  return buildSessionContext(branchEntries as SessionEntry[]).messages;
}

function getBranchThinkingLevel(branchEntries: BranchEntry[]): string | undefined {
  for (let index = branchEntries.length - 1; index >= 0; index--) {
    const entry = branchEntries[index];
    if (entry?.type !== "thinking_level_change") continue;
    return typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : undefined;
  }
  return undefined;
}

function clearLiveContinuation(sessionId: string | undefined): void {
  clearContinuationState(sessionId);
  releaseWsSession(sessionId);
}

function clearSessionRuntimeState(sessionId: string | undefined): void {
  clearLiveContinuation(sessionId);
  clearRemoteCompactionState(sessionId);
  clearResponsesRequestShapeState(sessionId);
}

function syncRemoteState(ctx: SessionContextLike): void {
  const sessionId = getSessionId(ctx);
  const branchEntries = ctx.sessionManager.getBranch() as Array<{
    type: string;
    id: string;
    details?: unknown;
    message?: AgentMessage;
  }>;
  const state = reconstructRemoteCompactionStateFromBranch({ branchEntries });
  if (state) {
    setRemoteCompactionState(sessionId, state);
  } else {
    clearRemoteCompactionState(sessionId);
  }
}

function getMatchingRemoteState(
  sessionId: string,
  model: TargetModel | undefined,
): ReturnType<typeof getRemoteCompactionState> {
  if (!model) return undefined;
  const remoteState = getRemoteCompactionState(sessionId);
  return remoteState && remoteState.modelKey === modelKey(model) ? remoteState : undefined;
}

function maybeNotifyRequestFeatures(params: {
  notifiedModels: Set<string>;
  hasUI: boolean;
  notify: boolean;
  ui: { notify(message: string, level: "info" | "warning"): void };
  model: TargetModel;
  features: string[];
}): void {
  if (!params.notify || !params.hasUI || params.features.length === 0) return;

  const key = `${String(params.model.provider)}/${String(params.model.id)}`;
  const noticeKey = `${key}:${params.features.join(",")}`;
  if (params.notifiedModels.has(noticeKey)) return;

  params.notifiedModels.add(noticeKey);
  params.ui.notify(`OpenAI compaction active for ${key} (${params.features.join(", ")})`, "info");
}

export default function openaiServerCompactionExtension(pi: ExtensionAPI) {
  const notifiedModels = new Set<string>();

  pi.registerProvider("openai", {
    api: "openai-responses",
    streamSimple: streamOpenAIResponsesWithPhase2B,
  });

  pi.on("session_start", (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    clearLiveContinuation(sessionId);
    clearResponsesRequestShapeState(sessionId);
    syncRemoteState(ctx);
  });

  const clearBeforeSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearSessionRuntimeState(getSessionId(ctx));
  };
  pi.on("session_before_switch", clearBeforeSessionChange);
  pi.on("session_before_fork", clearBeforeSessionChange);
  pi.on("session_before_tree", clearBeforeSessionChange);

  const syncAfterSessionChange = (_event: unknown, ctx: SessionContextLike): void => {
    clearLiveContinuation(getSessionId(ctx));
    syncRemoteState(ctx);
  };
  pi.on("session_tree", syncAfterSessionChange);
  pi.on("session_compact", syncAfterSessionChange);

  pi.on("model_select", (_event, ctx) => {
    clearLiveContinuation(getSessionId(ctx));
  });

  pi.on("session_shutdown", () => {
    clearAllContinuationState();
    releaseAllWsSessions();
  });

  // Direct OpenAI's custom transport reads replay state before its payload
  // hook. Refresh it while Pi still has the full canonical request context.
  pi.on("context", (_event, ctx) => {
    const sessionId = getSessionId(ctx);
    // The 0.80.9 peer types predate context_edit entries.
    const branch = ctx.sessionManager.getBranch() as BranchEntry[];
    const continuation = getContinuationState(sessionId);
    if (continuation?.contextEntryId) {
      const anchor = branch.findIndex((entry) => entry.id === continuation.contextEntryId);
      if (anchor < 0 || branch.slice(anchor + 1).some((entry) => entry.type === "context_edit" || entry.type === "compaction")) {
        clearLiveContinuation(sessionId);
      }
    }
    syncRemoteState(ctx);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    const model = resolvePhysicalModel(ctx);
    if (!cfg.enabled || !model || !supportsRemoteCompactionModel(model)) return undefined;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return undefined;
    // Current Pi auth uses null to delete inherited headers.
    const headers = auth.headers
      ? Object.fromEntries(Object.entries(auth.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined;

    const tools = buildToolsPayload(pi.getAllTools(), pi.getActiveTools());
    const sessionId = getSessionId(ctx);
    const branchEntries = event.branchEntries as BranchEntry[];
    syncRemoteState(ctx);
    const remoteState = getMatchingRemoteState(sessionId, model);
    const observedRequestShape = getResponsesRequestShapeState(sessionId);
    const fullBranchMessages = getBranchMessages(branchEntries);
    const responseItems = remoteState
      ? remoteState.explicitHistory
      : messagesToResponseItems(convertToLlm(fullBranchMessages));
    const promptResponseItems = normalizeResponseItemsForPrompt(responseItems, model);
    const thinkingLevel = pi.getThinkingLevel();
    const fallbackReasoning = model.reasoning
      ? thinkingLevelToResponsesReasoning(thinkingLevel ?? getBranchThinkingLevel(branchEntries))
      : undefined;
    const matchingRequestShape = observedRequestShape?.modelKey === modelKey(model) ? observedRequestShape : undefined;
    const reasoning = matchingRequestShape?.reasoning ?? fallbackReasoning;
    const text = matchingRequestShape?.text;

    const [localResult, remoteResult] = await Promise.allSettled([
      generateBestEffortLocalSummary({
        preparation: event.preparation,
        messages: fullBranchMessages,
        model,
        apiKey: auth.apiKey,
        headers,
        customInstructions: event.customInstructions,
        signal: event.signal,
        thinkingLevel,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      }),
      callRemoteCompactionEndpoint({
        model,
        apiKey: auth.apiKey,
        headers,
        sessionId,
        input: promptResponseItems,
        instructions: ctx.getSystemPrompt(),
        tools,
        parallelToolCalls: true,
        reasoning,
        text,
        signal: event.signal,
      }),
    ]);

    if (remoteResult.status !== "fulfilled") {
      if (localResult.status === "fulfilled") {
        return { compaction: localResult.value };
      }
      if (!event.signal.aborted && ctx.hasUI) {
        const message = remoteResult.reason instanceof Error ? remoteResult.reason.message : String(remoteResult.reason);
        ctx.ui.notify(`OpenAI remote compaction failed; falling back to default compaction. ${message}`, "warning");
      }
      return undefined;
    }

    if (localResult.status !== "fulfilled" && !event.signal.aborted && ctx.hasUI) {
      ctx.ui.notify("OpenAI remote compaction succeeded, but its portable text summary failed. Switching to another model may lose summarized context.", "warning");
    }
    const remoteDetails = buildRemoteCompactionDetails(
      model,
      remoteResult.value.output,
      remoteResult.value.usage,
    );
    const localSummary =
      localResult.status === "fulfilled"
        ? localResult.value
        : {
            summary: buildCompactionSummaryText(model),
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          };

    return {
      compaction: {
        summary: localSummary.summary,
        firstKeptEntryId: localSummary.firstKeptEntryId,
        tokensBefore: localSummary.tokensBefore,
        details: {
          ...(localSummary.details !== undefined ? { localSummaryDetails: localSummary.details } : {}),
          remoteCompaction: remoteDetails,
        },
      },
    };
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    const sessionId = getSessionId(ctx);
    const model = resolvePhysicalModel(ctx, event.message);
    const continuation = getContinuationState(sessionId);
    if (continuation && (!model || !messageMatchesModel(event.message, model) || continuation.modelKey !== modelKey(model))) {
      clearLiveContinuation(sessionId);
    }

    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled || !supportsPreviousResponseId(model, cfg)) return;
    if (!messageMatchesModel(event.message, model)) return;

    const responseId = extractAssistantResponseId(event.message);
    if (!responseId) return;

    const branch = ctx.sessionManager.getBranch();
    setContinuationState(sessionId, {
      responseId,
      modelKey: modelKey(model),
      updatedAt: Date.now(),
      // message_end runs before this assistant is appended to the branch.
      contextLength: convertToLlm([...getBranchMessages(branch), event.message]).length,
      contextEntryId: branch.at(-1)?.id,
    });
  });

  pi.on("before_provider_request", (event, ctx) => {
    const cfg = loadConfig(ctx.cwd);
    if (!cfg.enabled) return undefined;

    const sessionId = getSessionId(ctx);
    // Rebuild before resolving duplicate model IDs: only a validated native
    // checkpoint can identify its provider. Include pending tool/user messages.
    syncRemoteState(ctx);
    const model = resolveRequestModel(ctx, event.payload, getRemoteCompactionState(sessionId)?.modelKey);
    if (!model || !isRecord(event.payload)) return undefined;

    setResponsesRequestShapeState(sessionId, {
      modelKey: modelKey(model),
      updatedAt: Date.now(),
      reasoning: extractResponsesReasoningConfig(event.payload),
      text: extractResponsesTextConfig(event.payload),
    });
    const remoteState = getMatchingRemoteState(sessionId, model);

    if (usesExplicitRemoteCompactionHistory(model)) {
      if (!remoteState) return undefined;
      const payload = applyRemoteHistoryPayloadPatch({
        payload: event.payload,
        explicitHistory: normalizeResponseItemsForPrompt(remoteState.explicitHistory, model) as unknown[],
      });
      maybeNotifyRequestFeatures({
        notifiedModels,
        hasUI: ctx.hasUI,
        notify: cfg.notify,
        ui: ctx.ui,
        model,
        features: ["remote_compaction_history"],
      });
      return payload;
    }

    if (!supportsPreviousResponseId(model, cfg)) return undefined;

    // Only the transport knows whether it sent incremental input. The legacy
    // WebSocket path sets its own previous_response_id; adding one here to a
    // full HTTP transcript would send the previous conversation twice.
    const previousResponseId = typeof event.payload.previous_response_id === "string"
      ? event.payload.previous_response_id
      : undefined;
    const payload = applyPayloadPatch({
      payload: event.payload,
      model,
      cfg,
    });

    const features = ["store=true", "context_management"];
    if (remoteState !== undefined) {
      features.push("remote_compaction_history");
    } else if (previousResponseId) {
      features.push("previous_response_id");
    }

    maybeNotifyRequestFeatures({
      notifiedModels,
      hasUI: ctx.hasUI,
      notify: cfg.notify,
      ui: ctx.ui,
      model,
      features,
    });

    return payload;
  });
}
