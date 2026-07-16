/**
 * Provider override entrypoint.
 *
 * Chooses between Pi's normal HTTP Responses streaming path and this package's
 * custom WebSocket-backed continuation path for direct OpenAI Responses models.
 */
import type {
  SimpleStreamOptions,
  Context,
  Model,
  StreamFunction,
} from "@earendil-works/pi-ai";
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai/compat";
import { createOpenAIWebSocketStreamFn } from "./openai-ws-stream.ts";
import { loadConfig } from "./config.ts";
import { isDirectOpenAIResponsesModel } from "./openai.ts";

const websocketStream = createOpenAIWebSocketStreamFn();

export const streamOpenAIResponsesWithPhase2B: StreamFunction = (
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
