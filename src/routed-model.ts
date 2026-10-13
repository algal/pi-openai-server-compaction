/** Resolve physical models without treating a virtual selection as a provider. */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./config.ts";
import { isOpenAIResponsesModel, modelKey } from "./openai.ts";

type ModelContext = Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager">;

export function resolvePhysicalModel(ctx: ModelContext, message?: AgentMessage) {
  if (ctx.model?.api !== "pi-virtual") return ctx.model;

  // Compaction follows the latest successful physical response, just as Pi's
  // default direct routing does. Use finalized context so omitted recovery
  // attempts and messages from abandoned branches cannot select a model.
  const messages = message ? [message] : buildSessionContext(ctx.sessionManager.getBranch()).messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const response = messages[index];
    if (response.role !== "assistant") continue;
    if (!message && (response.stopReason === "error" || response.stopReason === "aborted")) continue;
    const model = ctx.modelRegistry.find(response.provider, response.model);
    // Do not walk back past an unresolved response to an older, different route.
    return model && model.api !== "pi-virtual" && model.api === response.api ? model : undefined;
  }
  return undefined;
}

export function resolveRequestModel(ctx: ModelContext, payload: unknown, checkpointModelKey?: string) {
  // Anthropic and Chat Completions use `messages`, not Responses `input`.
  if (!isRecord(payload) || !("input" in payload) || typeof payload.model !== "string") return undefined;
  if (ctx.model?.api !== "pi-virtual") {
    return ctx.model && isOpenAIResponsesModel(ctx.model) && ctx.model.id === payload.model ? ctx.model : undefined;
  }

  // The new request can route somewhere different from the last response.
  // Pi's request hook exposes a model ID but no provider. A validated native
  // checkpoint identifies its provider, even when both OpenAI and a gateway
  // advertise the same model ID. Without that evidence, do not guess.
  const candidates = ctx.modelRegistry.getAvailable().filter((model) =>
    model.id === payload.model && isOpenAIResponsesModel(model),
  );
  if (candidates.length === 1) return candidates[0];
  return checkpointModelKey
    ? candidates.find((model) => modelKey(model) === checkpointModelKey)
    : undefined;
}
