/**
 * Pi 1.x context resolvers.
 *
 * Pi 1.0 hands providers a TranscriptContext: `context.systemPrompt` and
 * `context.tools` are unset, and the prompt plus the tool declarations live in
 * transcript system messages (`content`, named `sections`, `toolsAdded`).
 * Older Pi versions set the two fields directly, so prefer them and replay the
 * transcript only when they are absent. The replay mirrors pi-ai's
 * `getCurrentSystemPrompt` and `getCurrentTools`, which is what Pi's own HTTP
 * and WebSocket API implementations call.
 *
 * The WebSocket transport in this package reads `instructions` and `tools`
 * from these helpers, so without them a warm-up and a `response.create` go out
 * with no prompt and no tools while the HTTP fallback carries both.
 */
import type { Context, Tool } from "@earendil-works/pi-ai";

type SystemMessageLike = {
  role?: string;
  content?: unknown;
  sections?: Record<string, string | null>;
  toolsAdded?: readonly Tool[];
  toolsRemoved?: readonly { readonly name?: string }[];
};

function systemMessages(context: Context): SystemMessageLike[] {
  const messages = (context.messages ?? []) as readonly SystemMessageLike[];
  return messages.filter((message) => message.role === "system");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

/** Current system prompt, or the legacy field when Pi still sets it. */
export function resolveSystemPrompt(context: Context): string | undefined {
  if (context.systemPrompt) return context.systemPrompt;
  const messages = systemMessages(context);
  if (messages.length === 0) return undefined;

  const content: string[] = [];
  const sections = new Map<string, string>();
  for (const message of messages) {
    const text = contentText(message.content);
    if (text.length > 0) content.push(text);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  const prompt = [content.join("\n\n"), ...sections.values()]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return prompt.length > 0 ? prompt : undefined;
}

/** Current tool set, or the legacy field when Pi still sets it. */
export function resolveTools(context: Context): Tool[] | undefined {
  if (context.tools?.length) return context.tools;
  const messages = systemMessages(context);
  if (messages.length === 0) return undefined;

  const tools = new Map<string, Tool>();
  for (const message of messages) {
    for (const reference of message.toolsRemoved ?? []) {
      if (reference?.name) tools.delete(reference.name);
    }
    for (const tool of message.toolsAdded ?? []) {
      if (tool?.name) tools.set(tool.name, tool);
    }
  }
  const resolved = [...tools.values()];
  return resolved.length > 0 ? resolved : undefined;
}
