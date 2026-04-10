/**
 * Codex-style remote compaction helpers.
 *
 * Converts Pi messages into OpenAI Responses items, calls
 * `/v1/responses/compact`, stores the returned opaque replacement history, and
 * reconstructs replayable state from persisted Pi session entries.
 */
import { arch, platform, release } from "node:os";
import type { ToolInfo } from "@mariozechner/pi-coding-agent";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  compact,
  convertToLlm,
  serializeConversation,
  type CompactionPreparation,
  type CompactionResult,
} from "@mariozechner/pi-coding-agent";
import { calculateCost, complete, type Model, type Usage } from "@mariozechner/pi-ai";
import { isRecord } from "./config.ts";
import {
  hostnameFromBaseUrl,
  isDirectOpenAIResponsesModel,
  isOpenAICodexResponsesModel,
  supportsRemoteCompactionModel,
  modelKey,
} from "./openai.ts";

type AssistantPhase = "commentary" | "final_answer";
type ToolResultOutputItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string };

type ContentPartLike = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  source?: unknown;
};

export type ResponseContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "output_text"; text: string };

export type ResponseItem =
  | {
      type: "message";
      role: string;
      content: ResponseContentItem[];
      end_turn?: boolean;
      phase?: AssistantPhase;
    }
  | {
      type: "reasoning";
      summary: Array<{ type: "summary_text"; text: string }>;
      content?: Array<{ type: "reasoning_text" | "text"; text: string }>;
      encrypted_content: string | null;
    }
  | { type: "function_call"; name: string; arguments: string; call_id: string }
  | { type: "function_call_output"; call_id: string; output: string | ToolResultOutputItem[] }
  | { type: "compaction"; encrypted_content: string }
  | { type: "compaction_summary"; encrypted_content: string }
  | { type: string; [key: string]: unknown };

export type ResponsesReasoningConfig = {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "concise" | "detailed" | null;
};

export type ResponsesTextConfig = Record<string, unknown>;

export type RemoteCompactionUsageSnapshot = Usage;

export type RemoteCompactionDetails = {
  version: 1;
  provider: "openai-responses-compact";
  modelKey: string;
  replacementHistory: ResponseItem[];
  usage?: RemoteCompactionUsageSnapshot;
};

export type RemoteCompactionSessionState = {
  compactionEntryId: string;
  modelKey: string;
  replacementHistory: ResponseItem[];
  explicitHistory: ResponseItem[];
};

export type RemoteCompactionResult = {
  output: ResponseItem[];
  usage?: RemoteCompactionUsageSnapshot;
};

function normalizeBaseUrl(baseUrl: string | undefined, fallback: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return fallback;
  return trimmed.replace(/\/+$/, "");
}

function resolveDirectOpenAICompactEndpoint(model: Model<any>): string {
  const baseUrl = normalizeBaseUrl(typeof model.baseUrl === "string" ? model.baseUrl : undefined, "https://api.openai.com/v1");
  return baseUrl.endsWith("/v1") ? `${baseUrl}/responses/compact` : `${baseUrl}/v1/responses/compact`;
}

function resolveCodexResponsesEndpoint(model: Model<any>): string {
  const baseUrl = normalizeBaseUrl(typeof model.baseUrl === "string" ? model.baseUrl : undefined, "https://chatgpt.com/backend-api");
  if (baseUrl.endsWith("/codex/responses")) return baseUrl;
  if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
  return `${baseUrl}/codex/responses`;
}

function compactEndpointUrl(model: Model<any>): string {
  if (isDirectOpenAIResponsesModel(model)) {
    return resolveDirectOpenAICompactEndpoint(model);
  }
  if (isOpenAICodexResponsesModel(model)) {
    return `${resolveCodexResponsesEndpoint(model)}/compact`;
  }
  throw new Error("Remote compaction endpoint is not supported for this model.");
}

function extractCodexAccountId(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Failed to extract accountId from Codex token");
  }
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
    [key: string]: unknown;
  };
  const auth = isRecord(payload["https://api.openai.com/auth"])
    ? payload["https://api.openai.com/auth"]
    : undefined;
  const accountId = auth?.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("Failed to extract accountId from Codex token");
  }
  return accountId;
}

function buildRemoteCompactionHeaders(params: {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  sessionId?: string;
}): Record<string, string> {
  if (isDirectOpenAIResponsesModel(params.model)) {
    return {
      authorization: `Bearer ${params.apiKey}`,
      ...(params.sessionId ? { session_id: params.sessionId } : {}),
      ...(params.headers ?? {}),
    };
  }
  if (isOpenAICodexResponsesModel(params.model)) {
    return {
      authorization: `Bearer ${params.apiKey}`,
      "chatgpt-account-id": extractCodexAccountId(params.apiKey),
      ...(params.sessionId ? { session_id: params.sessionId } : {}),
      originator: "pi",
      "user-agent": `pi-openai-server-compaction (${platform()} ${release()}; ${arch()})`,
      "OpenAI-Beta": "responses=experimental",
      ...(params.headers ?? {}),
    };
  }
  throw new Error("Remote compaction headers are not supported for this model.");
}

function isAssistantPhase(value: unknown): value is AssistantPhase {
  return value === "commentary" || value === "final_answer";
}

function parseTextSignaturePhase(value: unknown): AssistantPhase | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as { phase?: unknown };
    return isAssistantPhase(parsed.phase) ? parsed.phase : undefined;
  } catch {
    return undefined;
  }
}

function contentToResponseContentItems(content: unknown): ResponseContentItem[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: ResponseContentItem[] = [];
  for (const part of content as ContentPartLike[]) {
    if (
      (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
      typeof part.text === "string"
    ) {
      items.push({ type: "input_text", text: part.text });
      continue;
    }
    if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      items.push({ type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` });
      continue;
    }
    if (
      part.type === "input_image" &&
      part.source &&
      typeof part.source === "object" &&
      (part.source as { type?: unknown }).type === "url" &&
      typeof (part.source as { url?: unknown }).url === "string"
    ) {
      items.push({ type: "input_image", image_url: (part.source as { url: string }).url });
    }
  }
  return items;
}

function toolResultContentToOutput(content: unknown): string | ToolResultOutputItem[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((item): item is ContentPartLike => Boolean(item) && typeof item === "object")
    .flatMap((item) => {
      if (item.type === "text" && typeof item.text === "string") {
        return [{ type: "input_text", text: item.text } as const];
      }
      if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
        return [{ type: "input_image", image_url: `data:${item.mimeType};base64,${item.data}` } as const];
      }
      return [];
    });
}

function parseThinkingSignature(value: unknown): ResponseItem | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!isRecord(parsed) || parsed.type !== "reasoning") return undefined;

    const summary = Array.isArray(parsed.summary)
      ? parsed.summary
          .map((item) =>
            isRecord(item) && typeof item.text === "string"
              ? { type: "summary_text" as const, text: item.text }
              : undefined,
          )
          .filter((item): item is { type: "summary_text"; text: string } => Boolean(item))
      : [];
    const content = Array.isArray(parsed.content)
      ? parsed.content
          .map((item) => {
            if (!isRecord(item) || typeof item.text !== "string") return undefined;
            return {
              type: item.type === "reasoning_text" ? "reasoning_text" : "text",
              text: item.text,
            } as const;
          })
          .filter((item): item is { type: "reasoning_text" | "text"; text: string } => Boolean(item))
      : undefined;

    return {
      type: "reasoning",
      summary,
      ...(content && content.length > 0 ? { content } : {}),
      encrypted_content: typeof parsed.encrypted_content === "string" ? parsed.encrypted_content : null,
    };
  } catch {
    return undefined;
  }
}

function isResponseItem(value: unknown): value is ResponseItem {
  return isRecord(value) && typeof value.type === "string";
}

function buildPortableSummaryPrompt(conversation: string, customInstructions?: string): string {
  const instructionSuffix = customInstructions
    ? `\n\nAdditional summarization instructions:\n${customInstructions}`
    : "";
  return `Summarize this conversation for future continuation in pi. Preserve goals, decisions, important facts, file paths, open questions, and next steps. Be concise but include information needed to continue work.${instructionSuffix}\n\n<conversation>\n${conversation}\n</conversation>`;
}

export function messageToResponseItems(message: AgentMessage): ResponseItem[] {
  const items: ResponseItem[] = [];

  if (message.role === "user") {
    const content = contentToResponseContentItems(message.content);
    if (content.length > 0) {
      items.push({ type: "message", role: "user", content });
    }
    return items;
  }

  if (message.role === "assistant") {
    let phase: AssistantPhase | undefined;
    const textBlocks: string[] = [];

    const flushText = () => {
      if (textBlocks.length === 0) return;
      items.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: textBlocks.join("") }],
        ...(phase ? { phase } : {}),
      });
      textBlocks.length = 0;
    };

    for (const block of message.content) {
      if (block.type === "text") {
        if (!phase) {
          phase = parseTextSignaturePhase(block.textSignature);
        }
        textBlocks.push(block.text);
        continue;
      }
      if (block.type === "thinking") {
        flushText();
        const reasoning = parseThinkingSignature(block.thinkingSignature);
        if (reasoning) items.push(reasoning);
        continue;
      }
      if (block.type !== "toolCall") continue;

      flushText();
      const callId = typeof block.id === "string" ? block.id.split("|", 1)[0] : block.id;
      items.push({
        type: "function_call",
        name: block.name,
        call_id: typeof callId === "string" ? callId : String(callId),
        arguments: JSON.stringify(block.arguments ?? {}),
      });
    }

    flushText();
    return items;
  }

  if (message.role === "toolResult") {
    items.push({
      type: "function_call_output",
      call_id: message.toolCallId.split("|", 1)[0],
      output: toolResultContentToOutput(message.content),
    });
  }

  return items;
}

export function messagesToResponseItems(messages: AgentMessage[]): ResponseItem[] {
  return messages.flatMap((message) => messageToResponseItems(message));
}

function toolInfoToResponseTool(tool: ToolInfo): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

export function buildToolsPayload(
  allTools: ToolInfo[],
  activeToolNames: string[],
): Record<string, unknown>[] {
  const active = new Set(activeToolNames);
  return allTools.filter((tool) => active.has(tool.name)).map(toolInfoToResponseTool);
}

export async function generatePortableSummary(params: {
  messages: AgentMessage[];
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  customInstructions?: string;
  signal?: AbortSignal;
  firstKeptEntryId: string;
  tokensBefore: number;
}): Promise<CompactionResult> {
  const conversation = serializeConversation(convertToLlm(params.messages));
  const response = await complete(
    params.model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildPortableSummaryPrompt(conversation, params.customInstructions) }],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: params.apiKey,
      headers: params.headers,
      maxTokens: 4096,
      signal: params.signal,
    },
  );

  const summary = response.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();

  return {
    summary: summary || buildCompactionSummaryText(params.model),
    firstKeptEntryId: params.firstKeptEntryId,
    tokensBefore: params.tokensBefore,
  };
}

export async function generateBestEffortLocalSummary(params: {
  preparation: CompactionPreparation;
  messages: AgentMessage[];
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  customInstructions?: string;
  signal?: AbortSignal;
  firstKeptEntryId: string;
  tokensBefore: number;
}): Promise<CompactionResult> {
  try {
    return await generatePortableSummary(params);
  } catch {
    return await compact(
      params.preparation,
      params.model,
      params.apiKey,
      params.headers,
      params.customInstructions,
      params.signal,
    );
  }
}

function sanitizeResponseItems(items: unknown): ResponseItem[] {
  if (!Array.isArray(items)) {
    throw new Error("OpenAI remote compaction returned no output array.");
  }
  const normalized = items.filter(isResponseItem);
  if (normalized.length === 0) {
    throw new Error("OpenAI remote compaction returned an empty output array.");
  }
  return normalized;
}

function extractCacheWriteTokens(value: unknown): number {
  if (!isRecord(value)) return 0;
  const cacheCreationTokens = value.cache_creation_tokens;
  if (typeof cacheCreationTokens === "number" && Number.isFinite(cacheCreationTokens)) {
    return cacheCreationTokens;
  }
  const cacheWriteTokens = value.cache_write_tokens;
  return typeof cacheWriteTokens === "number" && Number.isFinite(cacheWriteTokens)
    ? cacheWriteTokens
    : 0;
}

function extractRemoteCompactionUsage(model: Model<any>, value: unknown): RemoteCompactionUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;

  const inputTokens = typeof value.input_tokens === "number" && Number.isFinite(value.input_tokens)
    ? value.input_tokens
    : 0;
  const outputTokens = typeof value.output_tokens === "number" && Number.isFinite(value.output_tokens)
    ? value.output_tokens
    : 0;
  const totalTokens = typeof value.total_tokens === "number" && Number.isFinite(value.total_tokens)
    ? value.total_tokens
    : inputTokens + outputTokens;
  const inputTokenDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined;
  const cachedTokens = typeof inputTokenDetails?.cached_tokens === "number" && Number.isFinite(inputTokenDetails.cached_tokens)
    ? inputTokenDetails.cached_tokens
    : 0;
  const cacheWriteTokens = extractCacheWriteTokens(inputTokenDetails);

  const usage: RemoteCompactionUsageSnapshot = {
    input: Math.max(0, inputTokens - cachedTokens - cacheWriteTokens),
    output: outputTokens,
    cacheRead: cachedTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

function parseUsageCostSnapshot(value: unknown): RemoteCompactionUsageSnapshot["cost"] | undefined {
  if (!isRecord(value)) return undefined;
  const input = typeof value.input === "number" && Number.isFinite(value.input) ? value.input : 0;
  const output = typeof value.output === "number" && Number.isFinite(value.output) ? value.output : 0;
  const cacheRead = typeof value.cacheRead === "number" && Number.isFinite(value.cacheRead) ? value.cacheRead : 0;
  const cacheWrite = typeof value.cacheWrite === "number" && Number.isFinite(value.cacheWrite) ? value.cacheWrite : 0;
  const total = typeof value.total === "number" && Number.isFinite(value.total)
    ? value.total
    : input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

function parseRemoteCompactionUsageSnapshot(value: unknown): RemoteCompactionUsageSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const input = typeof value.input === "number" && Number.isFinite(value.input) ? value.input : 0;
  const output = typeof value.output === "number" && Number.isFinite(value.output) ? value.output : 0;
  const cacheRead = typeof value.cacheRead === "number" && Number.isFinite(value.cacheRead) ? value.cacheRead : 0;
  const cacheWrite = typeof value.cacheWrite === "number" && Number.isFinite(value.cacheWrite) ? value.cacheWrite : 0;
  const totalTokens = typeof value.totalTokens === "number" && Number.isFinite(value.totalTokens)
    ? value.totalTokens
    : input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: parseUsageCostSnapshot(value.cost) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function buildRemoteCompactionRequestBody(params: {
  model: Model<any>;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  parallelToolCalls: boolean;
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
}): Record<string, unknown> {
  return {
    model: params.model.id,
    input: params.input,
    instructions: params.instructions,
    tools: params.tools,
    parallel_tool_calls: params.parallelToolCalls,
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    ...(params.text ? { text: params.text } : {}),
  };
}

export async function callRemoteCompactionEndpoint(params: {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  sessionId?: string;
  input: ResponseItem[];
  instructions?: string;
  tools: Record<string, unknown>[];
  parallelToolCalls: boolean;
  reasoning?: ResponsesReasoningConfig;
  text?: ResponsesTextConfig;
  signal?: AbortSignal;
}): Promise<RemoteCompactionResult> {
  if (!supportsRemoteCompactionModel(params.model)) {
    throw new Error("Remote compaction endpoint is currently only enabled for supported OpenAI-compatible Responses models.");
  }

  const response = await fetch(compactEndpointUrl(params.model), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildRemoteCompactionHeaders({
        model: params.model,
        apiKey: params.apiKey,
        headers: params.headers,
        sessionId: params.sessionId,
      }),
    },
    body: JSON.stringify(buildRemoteCompactionRequestBody({
      model: params.model,
      input: params.input,
      instructions: params.instructions,
      tools: params.tools,
      parallelToolCalls: params.parallelToolCalls,
      reasoning: params.reasoning,
      text: params.text,
    })),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI remote compaction failed (${response.status}): ${text || response.statusText}`);
  }

  const json = (await response.json()) as { output?: unknown; usage?: unknown };
  return {
    output: sanitizeResponseItems(json.output),
    usage: extractRemoteCompactionUsage(params.model, json.usage),
  };
}

export function buildRemoteCompactionDetails(
  model: Model<any>,
  replacementHistory: ResponseItem[],
  usage?: RemoteCompactionUsageSnapshot,
): RemoteCompactionDetails {
  return {
    version: 1,
    provider: "openai-responses-compact",
    modelKey: modelKey(model),
    replacementHistory,
    ...(usage ? { usage } : {}),
  };
}

export function extractRemoteCompactionDetails(details: unknown):
  | RemoteCompactionDetails
  | undefined {
  if (!isRecord(details)) return undefined;

  const remote = isRecord(details.remoteCompaction) ? details.remoteCompaction : details;
  if (!isRecord(remote)) return undefined;
  if (remote.provider !== "openai-responses-compact" || remote.version !== 1) return undefined;
  if (!Array.isArray(remote.replacementHistory)) return undefined;

  const replacementHistory = remote.replacementHistory.filter(isResponseItem);
  if (replacementHistory.length === 0) return undefined;

  const usage = parseRemoteCompactionUsageSnapshot(remote.usage);

  return {
    version: 1,
    provider: "openai-responses-compact",
    modelKey: typeof remote.modelKey === "string" ? remote.modelKey : "",
    replacementHistory,
    ...(usage ? { usage } : {}),
  };
}

function parseModelKeyParts(
  value: string,
): { provider: string; api: string; id: string } | undefined {
  const [provider, api, id] = value.split(":", 3);
  if (!provider || !api || !id) return undefined;
  return { provider, api, id };
}

function assistantMessageMatchesModelKey(
  message: AgentMessage,
  targetModelKey: string,
): boolean {
  const target = parseModelKeyParts(targetModelKey);
  if (!target) return false;
  if (!isRecord(message)) return false;
  return message.provider === target.provider && message.model === target.id;
}

export function reconstructRemoteCompactionStateFromBranch(params: {
  branchEntries: Array<{ type: string; id: string; details?: unknown; message?: AgentMessage }>;
}): RemoteCompactionSessionState | undefined {
  let latestCompactionIndex = -1;
  let latestCompactionEntryId = "";
  let latestDetails: RemoteCompactionDetails | undefined;

  params.branchEntries.forEach((entry, index) => {
    if (entry.type !== "compaction") return;
    latestCompactionIndex = index;
    latestCompactionEntryId = entry.id;
    latestDetails = extractRemoteCompactionDetails(entry.details);
  });

  if (!latestDetails || latestCompactionIndex < 0) return undefined;

  const trailingMessages: ResponseItem[] = [];
  let pendingTurnItems: ResponseItem[] = [];

  for (const entry of params.branchEntries.slice(latestCompactionIndex + 1)) {
    if (entry.type !== "message" || !entry.message) continue;

    const items = messageToResponseItems(entry.message);
    if (items.length === 0) continue;

    if (entry.message.role === "assistant") {
      if (assistantMessageMatchesModelKey(entry.message, latestDetails.modelKey)) {
        trailingMessages.push(...pendingTurnItems, ...items);
      }
      pendingTurnItems = [];
      continue;
    }

    pendingTurnItems.push(...items);
  }

  return {
    compactionEntryId: latestCompactionEntryId,
    modelKey: latestDetails.modelKey,
    replacementHistory: latestDetails.replacementHistory,
    explicitHistory: [...latestDetails.replacementHistory, ...trailingMessages],
  };
}

export function buildCompactionSummaryText(model: Model<any>): string {
  const host = hostnameFromBaseUrl(model.baseUrl) ?? "api.openai.com";
  return `OpenAI remote compaction applied for ${model.provider}/${model.id} via ${host}. Pi keeps this textual summary for portability, while compatible future OpenAI turns can use provider-native replacement history stored in compaction details.`;
}
