/**
 * Codex-style remote compaction helpers.
 *
 * Converts Pi messages into OpenAI Responses items, requests remote compaction
 * through the Responses API's `compaction_trigger`, stores the returned opaque
 * replacement history, and reconstructs replayable state from persisted Pi
 * session entries.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionBeforeCompactEvent, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  compact,
  convertToLlm,
  serializeConversation,
  type CompactionResult,
} from "@earendil-works/pi-coding-agent";
import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import { isRecord } from "./config.ts";
import {
  hostnameFromBaseUrl,
  isDirectOpenAIResponsesModel,
  isOpenAICodexResponsesModel,
  supportsRemoteCompactionModel,
  modelKey,
} from "./openai.ts";

type CompactionPreparation = SessionBeforeCompactEvent["preparation"];
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
  | { type: "compaction_trigger" }
  | { type: string; [key: string]: unknown };

export type ResponsesReasoningConfig = {
  effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  summary?: "auto" | "concise" | "detailed" | null;
};

export type ResponsesTextConfig = Record<string, unknown>;

export type RemoteCompactionUsageSnapshot = Usage;

const IMAGE_CONTENT_OMITTED_PLACEHOLDER = "image content omitted because you do not support image input";
const REMOTE_COMPACTION_V2_FEATURE = "remote_compaction_v2";
const RETAINED_MESSAGE_TOKEN_BUDGET = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RemoteCompactionDetails = {
  version: 1 | 2;
  provider: "openai-responses-compact" | "openai-responses-compaction";
  implementation?: "responses_compact_v1" | "responses_compaction_v2";
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

function resolveDirectOpenAIResponsesEndpoint(model: Model<any>): string {
  const baseUrl = normalizeBaseUrl(typeof model.baseUrl === "string" ? model.baseUrl : undefined, "https://api.openai.com/v1");
  if (baseUrl.endsWith("/responses")) return baseUrl;
  return baseUrl.endsWith("/v1") ? `${baseUrl}/responses` : `${baseUrl}/v1/responses`;
}

function resolveCodexResponsesEndpoint(model: Model<any>): string {
  const baseUrl = normalizeBaseUrl(typeof model.baseUrl === "string" ? model.baseUrl : undefined, "https://chatgpt.com/backend-api");
  if (baseUrl.endsWith("/codex/responses")) return baseUrl;
  if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
  return `${baseUrl}/codex/responses`;
}

export function remoteCompactionV2EndpointUrl(model: Model<any>): string {
  if (isDirectOpenAIResponsesModel(model)) {
    return resolveDirectOpenAIResponsesEndpoint(model);
  }
  if (isOpenAICodexResponsesModel(model)) {
    return resolveCodexResponsesEndpoint(model);
  }
  throw new Error("Remote compaction v2 is not supported for this model.");
}

function resolveCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : join(homedir(), ".codex");
}

function resolveCodexInstallationId(): string {
  const path = join(resolveCodexHome(), "installation_id");
  try {
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8").trim();
      if (UUID_RE.test(existing)) return existing.toLowerCase();
    }
  } catch {
    // Fall through and regenerate below, matching Codex's invalid-file behavior.
  }

  const installationId = randomUUID();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, installationId);
  } catch {
    // Header is a parity hint, not a reason to fail compaction.
  }
  return installationId;
}

export function buildCodexIdentityHeaders(sessionId?: string): Record<string, string> {
  if (!sessionId) {
    return {
      "x-codex-installation-id": resolveCodexInstallationId(),
    };
  }
  return {
    "x-codex-installation-id": resolveCodexInstallationId(),
    "x-codex-window-id": `${sessionId}:0`,
    session_id: sessionId,
  };
}

export function buildCodexWebSocketHeaders(sessionId: string): Record<string, string> {
  return {
    "x-client-request-id": sessionId,
    ...buildCodexIdentityHeaders(sessionId),
  };
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

function withRemoteCompactionV2Feature(headers: Record<string, string>): Record<string, string> {
  const configuredFeatures = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "x-codex-beta-features")?.[1]
    ?.split(",")
    .map((feature) => feature.trim())
    .filter(Boolean) ?? [];
  const headersWithoutFeature = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== "x-codex-beta-features"),
  );
  const features = [...new Set([...configuredFeatures, REMOTE_COMPACTION_V2_FEATURE])];
  return {
    ...headersWithoutFeature,
    "x-codex-beta-features": features.join(","),
  };
}

export function buildRemoteCompactionHeaders(params: {
  model: Model<any>;
  apiKey: string;
  headers?: Record<string, string>;
  sessionId?: string;
}): Record<string, string> {
  const codexIdentityHeaders = buildCodexIdentityHeaders(params.sessionId);
  const commonHeaders = withRemoteCompactionV2Feature({
    authorization: `Bearer ${params.apiKey}`,
    ...codexIdentityHeaders,
    ...(params.headers ?? {}),
    accept: "text/event-stream",
    "content-type": "application/json",
  });
  if (isDirectOpenAIResponsesModel(params.model)) {
    return commonHeaders;
  }
  if (isOpenAICodexResponsesModel(params.model)) {
    return {
      ...commonHeaders,
      "chatgpt-account-id": extractCodexAccountId(params.apiKey),
      originator: "pi",
      "user-agent": `pi-openai-server-compaction (${platform()} ${release()}; ${arch()})`,
      "OpenAI-Beta": "responses=experimental",
    };
  }
  throw new Error("Remote compaction v2 headers are not supported for this model.");
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

  const output: ToolResultOutputItem[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const part = item as ContentPartLike;
    if (part.type === "text" && typeof part.text === "string") {
      output.push({ type: "input_text", text: part.text });
    } else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      output.push({ type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` });
    }
  }
  return output;
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

function cloneResponseItem(item: ResponseItem): ResponseItem {
  return JSON.parse(JSON.stringify(item)) as ResponseItem;
}

function responseItemCallId(item: ResponseItem): string | undefined {
  const callId = (item as Record<string, unknown>).call_id;
  return typeof callId === "string" && callId ? callId : undefined;
}

function responseItemOutput(item: ResponseItem): unknown {
  return (item as Record<string, unknown>).output;
}

function syntheticOutputForCall(item: ResponseItem): ResponseItem | undefined {
  const callId = responseItemCallId(item);
  if (!callId) return undefined;

  if (item.type === "function_call" || item.type === "local_shell_call") {
    return { type: "function_call_output", call_id: callId, output: "aborted" };
  }
  if (item.type === "tool_search_call") {
    return {
      type: "tool_search_output",
      call_id: callId,
      status: "completed",
      execution: "client",
      tools: [],
    };
  }
  if (item.type === "custom_tool_call") {
    return { type: "custom_tool_call_output", call_id: callId, output: "aborted" };
  }
  return undefined;
}

function outputTypeForCallType(type: string): string | undefined {
  if (type === "function_call" || type === "local_shell_call") return "function_call_output";
  if (type === "tool_search_call") return "tool_search_output";
  if (type === "custom_tool_call") return "custom_tool_call_output";
  return undefined;
}

function ensureCallOutputsPresent(items: ResponseItem[]): ResponseItem[] {
  const normalized: ResponseItem[] = [];
  for (const item of items) {
    normalized.push(item);
    const outputType = outputTypeForCallType(item.type);
    const callId = responseItemCallId(item);
    if (!outputType || !callId) continue;

    const hasOutput = items.some((candidate) => (
      candidate.type === outputType &&
      responseItemCallId(candidate) === callId
    ));
    if (!hasOutput) {
      const synthetic = syntheticOutputForCall(item);
      if (synthetic) normalized.push(synthetic);
    }
  }
  return normalized;
}

function removeOrphanOutputs(items: ResponseItem[]): ResponseItem[] {
  const functionCallIds = new Set<string>();
  const toolSearchCallIds = new Set<string>();
  const customToolCallIds = new Set<string>();

  for (const item of items) {
    const callId = responseItemCallId(item);
    if (!callId) continue;
    if (item.type === "function_call" || item.type === "local_shell_call") {
      functionCallIds.add(callId);
    } else if (item.type === "tool_search_call") {
      toolSearchCallIds.add(callId);
    } else if (item.type === "custom_tool_call") {
      customToolCallIds.add(callId);
    }
  }

  return items.filter((item) => {
    const callId = responseItemCallId(item);
    if (item.type === "function_call_output") {
      return Boolean(callId && functionCallIds.has(callId));
    }
    if (item.type === "custom_tool_call_output") {
      return Boolean(callId && customToolCallIds.has(callId));
    }
    if (item.type === "tool_search_output") {
      if (item.execution === "server" || callId === undefined) return true;
      return toolSearchCallIds.has(callId);
    }
    return true;
  });
}

function modelSupportsImageInput(model: { input?: readonly unknown[] }): boolean {
  return Array.isArray(model.input) && model.input.includes("image");
}

function stripUnsupportedImageContentItems(items: ResponseContentItem[]): ResponseContentItem[] {
  return items.map((item) => (
    item.type === "input_image"
      ? { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER }
      : item
  ));
}

function stripUnsupportedFunctionOutputImages(output: unknown): unknown {
  if (Array.isArray(output)) {
    return output.map((item) => (
      isRecord(item) && item.type === "input_image"
        ? { type: "input_text", text: IMAGE_CONTENT_OMITTED_PLACEHOLDER }
        : item
    ));
  }
  if (isRecord(output) && Array.isArray(output.content)) {
    return {
      ...output,
      content: stripUnsupportedFunctionOutputImages(output.content),
    };
  }
  return output;
}

function stripImagesWhenUnsupported(items: ResponseItem[], model: { input?: readonly unknown[] }): ResponseItem[] {
  if (modelSupportsImageInput(model)) return items;

  return items.map((item) => {
    const next = cloneResponseItem(item);
    if (next.type === "message" && Array.isArray(next.content)) {
      next.content = stripUnsupportedImageContentItems(next.content);
    } else if (
      (next.type === "function_call_output" || next.type === "custom_tool_call_output") &&
      "output" in next
    ) {
      next.output = stripUnsupportedFunctionOutputImages(responseItemOutput(next));
    } else if (next.type === "image_generation_call" && typeof next.result === "string") {
      next.result = "";
    }
    return next;
  });
}

export function normalizeResponseItemsForPrompt(
  items: ResponseItem[],
  model: { input?: readonly unknown[] },
): ResponseItem[] {
  const withoutGhostSnapshots = items
    .filter((item) => item.type !== "ghost_snapshot")
    .map(cloneResponseItem);
  const withCallOutputs = ensureCallOutputsPresent(withoutGhostSnapshots);
  const withoutOrphanOutputs = removeOrphanOutputs(withCallOutputs);
  return stripImagesWhenUnsupported(withoutOrphanOutputs, model);
}

function isRealUserMessage(item: ResponseItem): boolean {
  if (item.type !== "message" || item.role !== "user") return false;
  if (typeof item.content === "string") return item.content.trim().length > 0;
  return Array.isArray(item.content) && item.content.length > 0;
}

function shouldKeepCompactedHistoryItem(item: ResponseItem): boolean {
  if (item.type === "message" && item.role === "developer") return false;
  if (item.type === "message" && item.role === "user") return isRealUserMessage(item);
  if (item.type === "message" && item.role === "assistant") return true;
  if (item.type === "compaction" || item.type === "compaction_summary") return true;
  return false;
}

export function processCompactedHistory(items: ResponseItem[]): ResponseItem[] {
  return items.filter(shouldKeepCompactedHistoryItem).map(cloneResponseItem);
}

function responseMessageText(item: ResponseItem): string {
  if (item.type !== "message" || !Array.isArray(item.content)) return "";
  return item.content
    .filter((content): content is Extract<ResponseContentItem, { type: "input_text" | "output_text" }> =>
      content.type === "input_text" || content.type === "output_text",
    )
    .map((content) => content.text)
    .join("");
}

function approximateMessageTokens(item: ResponseItem): number {
  return Math.max(1, Math.ceil(responseMessageText(item).length / 4));
}

function truncateMessageToTokenBudget(item: ResponseItem, maxTokens: number): ResponseItem | undefined {
  if (item.type !== "message" || !Array.isArray(item.content)) return cloneResponseItem(item);
  let remainingCharacters = Math.max(0, maxTokens * 4);
  const content = item.content.flatMap((part) => {
    if (part.type === "input_image") return [part];
    if (remainingCharacters === 0) return [];
    const text = part.text.slice(0, remainingCharacters);
    remainingCharacters -= text.length;
    return text ? [{ ...part, text }] : [];
  });
  return content.length > 0 ? { ...cloneResponseItem(item), content } : undefined;
}

function truncateRetainedMessages(items: ResponseItem[], maxTokens: number): ResponseItem[] {
  let remainingTokens = maxTokens;
  const retainedReversed: ResponseItem[] = [];
  for (const item of [...items].reverse()) {
    if (remainingTokens === 0) break;
    const tokenCount = approximateMessageTokens(item);
    if (tokenCount <= remainingTokens) {
      retainedReversed.push(cloneResponseItem(item));
      remainingTokens -= tokenCount;
      continue;
    }
    const truncated = truncateMessageToTokenBudget(item, remainingTokens);
    if (truncated) retainedReversed.push(truncated);
    remainingTokens = 0;
  }
  return retainedReversed.reverse();
}

export function buildRemoteCompactionV2History(
  input: ResponseItem[],
  compactionItem: ResponseItem,
): ResponseItem[] {
  if (compactionItem.type !== "compaction") {
    throw new Error("OpenAI remote compaction v2 did not return a compaction item.");
  }
  const retainedUserMessages = input.filter(
    (item) => item.type === "message" && item.role === "user" && isRealUserMessage(item),
  );
  return [
    ...truncateRetainedMessages(retainedUserMessages, RETAINED_MESSAGE_TOKEN_BUDGET),
    cloneResponseItem(compactionItem),
  ];
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
  thinkingLevel?: ThinkingLevel;
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
      params.thinkingLevel,
    );
  }
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
  sessionId?: string;
}): Record<string, unknown> {
  return {
    model: params.model.id,
    input: [...params.input, { type: "compaction_trigger" }],
    instructions: params.instructions,
    tools: params.tools,
    parallel_tool_calls: params.parallelToolCalls,
    tool_choice: "auto",
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    ...(params.sessionId ? { prompt_cache_key: params.sessionId } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    ...(params.text ? { text: params.text } : {}),
  };
}

type RemoteCompactionV2Events = {
  compactionItem: ResponseItem;
  usage?: unknown;
};

function parseSseData(text: string): unknown[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .flatMap((block) => {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data || data === "[DONE]") return [];
      try {
        return [JSON.parse(data) as unknown];
      } catch {
        return [];
      }
    });
}

export function parseRemoteCompactionV2Events(events: unknown[]): RemoteCompactionV2Events {
  let completed = false;
  let usage: unknown;
  const compactionItems: ResponseItem[] = [];

  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "error") {
      const message = typeof event.message === "string" ? event.message : "Unknown Responses API error";
      throw new Error(`OpenAI remote compaction v2 failed: ${message}`);
    }
    if (event.type === "response.failed") {
      const response = isRecord(event.response) ? event.response : undefined;
      const error = response && isRecord(response.error) ? response.error : undefined;
      const message = typeof error?.message === "string" ? error.message : "Response failed";
      throw new Error(`OpenAI remote compaction v2 failed: ${message}`);
    }
    if (event.type === "response.output_item.done" && isResponseItem(event.item)) {
      if (event.item.type === "compaction") compactionItems.push(event.item);
      continue;
    }
    if (event.type === "response.completed") {
      completed = true;
      const response = isRecord(event.response) ? event.response : undefined;
      usage = response?.usage;
    }
  }

  if (!completed) {
    throw new Error("OpenAI remote compaction v2 stream ended before response.completed.");
  }
  if (compactionItems.length !== 1) {
    throw new Error(
      `OpenAI remote compaction v2 expected exactly one compaction item, got ${compactionItems.length}.`,
    );
  }
  return { compactionItem: compactionItems[0], usage };
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
    throw new Error("Remote compaction v2 is currently only enabled for supported OpenAI-compatible Responses models.");
  }

  const response = await fetch(remoteCompactionV2EndpointUrl(params.model), {
    method: "POST",
    headers: buildRemoteCompactionHeaders({
      model: params.model,
      apiKey: params.apiKey,
      headers: params.headers,
      sessionId: params.sessionId,
    }),
    body: JSON.stringify(buildRemoteCompactionRequestBody({
      model: params.model,
      input: params.input,
      instructions: params.instructions,
      tools: params.tools,
      parallelToolCalls: params.parallelToolCalls,
      reasoning: params.reasoning,
      text: params.text,
      sessionId: params.sessionId,
    })),
    signal: params.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI remote compaction v2 failed (${response.status}): ${text || response.statusText}`);
  }

  const responseText = await response.text();
  const parsed = parseRemoteCompactionV2Events(parseSseData(responseText));
  return {
    output: buildRemoteCompactionV2History(params.input, parsed.compactionItem),
    usage: extractRemoteCompactionUsage(params.model, parsed.usage),
  };
}

export function buildRemoteCompactionDetails(
  model: Model<any>,
  replacementHistory: ResponseItem[],
  usage?: RemoteCompactionUsageSnapshot,
): RemoteCompactionDetails {
  return {
    version: 2,
    provider: "openai-responses-compaction",
    implementation: "responses_compaction_v2",
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
  const isLegacy = remote.provider === "openai-responses-compact" && remote.version === 1;
  const isV2 = remote.provider === "openai-responses-compaction" && remote.version === 2;
  if (!isLegacy && !isV2) return undefined;
  if (!Array.isArray(remote.replacementHistory)) return undefined;

  const replacementHistory = remote.replacementHistory.filter(isResponseItem);
  if (replacementHistory.length === 0) return undefined;

  const usage = parseRemoteCompactionUsageSnapshot(remote.usage);

  return {
    version: isV2 ? 2 : 1,
    provider: isV2 ? "openai-responses-compaction" : "openai-responses-compact",
    implementation: isV2 ? "responses_compaction_v2" : "responses_compact_v1",
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
