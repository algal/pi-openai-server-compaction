/**
 * Provider override entrypoint.
 *
 * Chooses between Pi's normal HTTP Responses streaming path and this package's
 * custom WebSocket-backed continuation path for direct OpenAI Responses models.
 */
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  streamSimpleOpenAIResponses,
  type SimpleStreamOptions,
  type Context,
  type Model,
} from "@mariozechner/pi-ai";
import { createOpenAIWebSocketStreamFn } from "./openai-ws-stream.ts";
import { loadConfig } from "./config.ts";
import { isDirectOpenAIResponsesModel } from "./openai.ts";

const websocketStream = createOpenAIWebSocketStreamFn();

export const streamOpenAIResponsesWithPhase2B: StreamFn = (
  model,
  context,
  options,
) => {
  const cfg = loadConfig(process.cwd());
  if (!cfg.enabled || !isDirectOpenAIResponsesModel(model)) {
    return streamSimpleOpenAIResponses(
      model as Model<"openai-responses">,
      context as Context,
      options as SimpleStreamOptions | undefined,
    );
  }
  return websocketStream(model, context, options);
};
