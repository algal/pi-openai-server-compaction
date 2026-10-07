#!/usr/bin/env node
/**
 * Regression: Pi 1.x hands providers a TranscriptContext whose only field is
 * `messages`. The system prompt and tool declarations live in system messages
 * (`content`, named `sections`, `toolsAdded`) and `context.systemPrompt` /
 * `context.tools` are unset. The WebSocket transport read those two fields
 * directly, so warm-ups and `response.create` payloads went out with no
 * `instructions` and no `tools` while the HTTP fallback carried both.
 *
 * Run: node --experimental-strip-types scripts/test-transcript-context.mjs
 */
import assert from "node:assert/strict";
import { resolveSystemPrompt, resolveTools } from "../src/transcript-context.ts";
import {
  buildResponseCreatePayload,
  buildWsRequestKey,
  convertTools,
} from "../src/openai-ws-stream.ts";

const readTool = {
  name: "read",
  description: "Read file contents",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const bashTool = {
  name: "bash",
  description: "Execute bash commands",
  parameters: { type: "object", properties: { command: { type: "string" } } },
};

// Pi 1.x shape: system message carries content, sections, and the tool set.
const transcriptContext = {
  messages: [
    {
      role: "system",
      content: "",
      sections: {
        preamble: "You are an expert coding assistant.",
        rules: "<rules>\n- Be concise\n</rules>",
      },
      toolsAdded: [readTool, bashTool],
      timestamp: 0,
    },
    {
      role: "system",
      toolsRemoved: [{ name: "bash" }],
      timestamp: 1,
    },
    { role: "user", content: "hi", timestamp: 2 },
  ],
};

assert.equal(
  resolveSystemPrompt(transcriptContext),
  "You are an expert coding assistant.\n\n<rules>\n- Be concise\n</rules>",
  "transcript replay must emit content then sections",
);
assert.deepEqual(
  resolveTools(transcriptContext)?.map((tool) => tool.name),
  ["read"],
  "transcript replay must apply toolsAdded and toolsRemoved in order",
);

// The WebSocket cache key must now carry the prompt.
const key = buildWsRequestKey({
  model: { id: "gpt-5.4-nano" },
  context: transcriptContext,
  tools: [],
  options: undefined,
});
assert.ok(
  key.includes("You are an expert coding assistant."),
  `request key lost the instructions: ${key.slice(0, 200)}`,
);
assert.ok(!key.includes('"instructions":undefined'), "instructions must serialize when present");
console.log("PASS: transcript prompt and tools reach the WebSocket request key");

// The response.create payload is what the model actually receives: it must
// carry both the instructions and the tool definitions.
const payload = buildResponseCreatePayload({
  model: { id: "gpt-5.4-nano" },
  context: transcriptContext,
  inputItems: [{ type: "message", role: "user", content: "hi" }],
  tools: convertTools(resolveTools(transcriptContext)),
  options: undefined,
});
assert.equal(
  payload.instructions,
  "You are an expert coding assistant.\n\n<rules>\n- Be concise\n</rules>",
  "response.create lost the instructions",
);
assert.deepEqual(
  (payload.tools ?? []).map((tool) => tool.name),
  ["read"],
  "response.create lost the tools",
);
console.log("PASS: response.create payload carries instructions and tools");

// Legacy Pi still sets both fields, and they win.
const legacyContext = {
  systemPrompt: "Legacy prompt.",
  tools: [readTool],
  messages: transcriptContext.messages,
};
assert.equal(resolveSystemPrompt(legacyContext), "Legacy prompt.");
assert.deepEqual(
  resolveTools(legacyContext)?.map((tool) => tool.name),
  ["read"],
  "legacy context.tools must win over the transcript replay",
);
console.log("PASS: legacy context fields still win");

// Nothing to replay means no prompt and no tools, not a crash.
const empty = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
assert.equal(resolveSystemPrompt(empty), undefined);
assert.equal(resolveTools(empty), undefined);
console.log("PASS: transcript without system messages stays empty");

console.log("transcript-context: all cases passed");
