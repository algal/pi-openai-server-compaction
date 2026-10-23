import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { stream as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { WebSocketServer } from "ws";
import extensionFactory from "../src/index.ts";
import { applyRemoteHistoryPayloadPatch } from "../src/openai.ts";
import { messageToResponseItems, messagesToResponseItems } from "../src/remote-compaction.ts";
import { createOpenAIWebSocketStreamFn, releaseAllWsSessions } from "../src/openai-ws-stream.ts";
import { clearAllContinuationState, setRemoteCompactionState } from "../src/state.ts";

const read = {
  name: "read",
  description: "Read a test file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
};
const bash = { ...read, name: "bash", description: "Run a test command" };
const lateTool = { ...read, name: "late_tool", description: "Loaded after compaction" };
const system = { role: "system", content: "Use tools to inspect files.", toolsAdded: [read, bash], timestamp: 0 };
const user = { role: "user", content: "Inspect the test file.", timestamp: 1 };
const model = {
  id: "gpt-6.1-sol", name: "GPT test", api: "openai-codex-responses", provider: "openai-codex",
  baseUrl: "https://chatgpt.com/backend-api", reasoning: true, input: ["text", "image"],
  contextWindow: 500000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsAdditionalTools: true, supportsToolSearch: true, supportsMidConvoSystemMessages: true },
};
const fakeToken = `e30.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "offline-test" },
})).toString("base64url")}.fake`;
const compacted = [{ type: "compaction", encrypted_content: "SYNTHETIC_CHECKPOINT" }];

async function captureRequest(messages, compat = model.compat) {
  let captured;
  const response = await streamCodex({ ...model, compat }, normalizeContext({ messages }), {
    apiKey: fakeToken,
    onPayload(payload) {
      captured = payload;
      // Stop before the provider can make any network request.
      throw new Error("OFFLINE_CAPTURE_COMPLETE");
    },
  }).result();
  assert.equal(response.errorMessage, "OFFLINE_CAPTURE_COMPLETE");
  assert.ok(captured);
  return captured;
}

function controls(input) {
  return input.filter((item) => item.type === "additional_tools" || item.type === "configuration_update" ||
    item.type === "tool_search_call" || item.type === "tool_search_output" ||
    item.role === "developer" || item.role === "system");
}

function wireExtension() {
  const handlers = new Map();
  extensionFactory({ on: (name, handler) => handlers.set(name, handler), registerProvider() {} });
  let branch = [];
  const ctx = {
    cwd: process.cwd(), model, hasUI: false,
    sessionManager: { getSessionId: () => "offline-session", getBranch: () => branch },
  };
  return {
    handlers, ctx,
    async compact(history) {
      branch = [{ type: "compaction", id: randomUUID(), details: { remoteCompaction: {
        version: 2, provider: "openai-responses-compaction", implementation: "responses_compaction_v2",
        modelKey: "openai-codex:openai-codex-responses:gpt-6.1-sol", replacementHistory: history,
      } } }];
      await handlers.get("session_compact")({}, ctx);
    },
  };
}

afterEach(() => { releaseAllWsSessions(); clearAllContinuationState(); });

// [itest->req~remote-history.request-configuration~1]
test("Pi 1.4 tool declarations survive the actual post-compaction request hook", async () => {
  const request = await captureRequest([system, user]);
  assert.equal(request.tools, undefined, "Pi declares these tools in input, not top-level tools");
  assert.deepEqual(request.input[0].tools.map((tool) => tool.name), ["read", "bash"]);
  const extension = wireExtension();
  await extension.compact(compacted);
  const patched = await extension.handlers.get("before_provider_request")({ payload: request }, extension.ctx);
  assert.deepEqual(controls(patched.input), controls(request.input));
  assert.deepEqual(patched.input.at(-1), compacted[0]);
});

// [itest->req~remote-history.request-configuration~1]
test("resume and repeated compaction retain newly loaded tools and removal instructions", async () => {
  const extension = wireExtension();
  await extension.compact(compacted);
  await extension.handlers.get("session_start")({}, extension.ctx);
  const update = { role: "system", content: "Use the newly loaded tool.", toolsAdded: [lateTool], toolsRemoved: [{ name: "bash" }], timestamp: 2 };
  const request = await captureRequest([system, user, update, { ...user, timestamp: 3 }]);
  for (const history of [compacted, [{ type: "compaction", encrypted_content: "SECOND_CHECKPOINT" }]]) {
    await extension.compact(history);
    const patched = await extension.handlers.get("before_provider_request")({ payload: request }, extension.ctx);
    assert.deepEqual(controls(patched.input), controls(request.input));
    assert.equal(patched.input.filter((item) => item.type === "additional_tools").length, 2);
    assert.match(JSON.stringify(patched.input), /no longer available[\s\S]*bash/);
    assert.deepEqual(patched.input.at(-1), history[0]);
  }
});

// [itest->req~remote-history.request-configuration~1]
test("synthetic tool-search declarations stay paired on addition-only backends", async () => {
  const request = await captureRequest([system, user, { role: "system", content: "", toolsAdded: [lateTool], timestamp: 2 }], {
    ...model.compat, supportsAdditionalTools: false,
  });
  assert.ok(request.input.some((item) => item.type === "tool_search_output"));
  const patched = applyRemoteHistoryPayloadPatch({ payload: request, explicitHistory: compacted });
  assert.deepEqual(controls(patched.input), controls(request.input));
  assert.deepEqual(patched.tools, request.tools);
});

// [utest->req~remote-history.request-configuration~1]
// [utest->req~remote-history.nonmutating-replacement~1]
test("replacement preserves configuration and request fields without replaying discarded conversation or mutating inputs", () => {
  const configuration = [
    { type: "additional_tools", role: "developer", tools: [{ type: "custom", name: "code", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } }] },
    { role: "developer", content: "Current permission boundary" },
    { type: "configuration_update", reasoning: { effort: "high" } },
  ];
  const payload = { input: [...configuration, { role: "user", content: "DISCARDED_OLD_INPUT" }], tools: [{ type: "function", name: "legacy" }], instructions: "Keep instructions", previous_response_id: "stale", messages: ["stale"], text: { verbosity: "low" } };
  const original = structuredClone(payload);
  const history = structuredClone(compacted);
  const patched = applyRemoteHistoryPayloadPatch({ payload, explicitHistory: history });
  assert.deepEqual(patched.input, [...configuration, ...history]);
  assert.deepEqual(patched.tools, original.tools);
  assert.equal(patched.instructions, "Keep instructions");
  assert.deepEqual(patched.text, { verbosity: "low" });
  assert.equal("previous_response_id" in patched, false);
  assert.equal("messages" in patched, false);
  assert.deepEqual(payload, original);
  assert.deepEqual(history, compacted);
  assert.deepEqual(applyRemoteHistoryPayloadPatch({ payload: patched, explicitHistory: history }), patched,
    "HTTP fallback and provider hooks can both apply the patch without duplicating declarations");
});

// [utest->req~remote-history.nonmutating-replacement~1]
test("legacy top-level tools survive absent, string, or empty conversation inputs", () => {
  for (const input of [undefined, "old input", []]) {
    const payload = { input, tools: [{ type: "function", name: "read" }], instructions: "Keep prompt" };
    const patched = applyRemoteHistoryPayloadPatch({ payload, explicitHistory: compacted });
    assert.deepEqual(patched.input, compacted);
    assert.deepEqual(patched.tools, [{ type: "function", name: "read" }]);
    assert.equal(patched.instructions, "Keep prompt");
  }
});

// [utest->req~remote-history.tool-replay~1]
test("custom tools and namespaced function calls retain their native replay shape", () => {
  const call = { role: "assistant", provider: model.provider, api: model.api, model: model.id, content: [
    { type: "toolCall", id: "call_code|ctc_code", name: "codemode", namespace: "functions", arguments: { code: "text(42)" } },
    { type: "toolCall", id: "call_read|fc_read", name: "read", namespace: "files", arguments: { path: "test.txt" } },
  ] };
  assert.deepEqual(messageToResponseItems(call), [
    { type: "custom_tool_call", name: "codemode", call_id: "call_code", namespace: "functions", input: "text(42)" },
    { type: "function_call", name: "read", call_id: "call_read", namespace: "files", arguments: '{"path":"test.txt"}' },
  ]);
  assert.deepEqual(messageToResponseItems({ role: "toolResult", toolCallId: "call_code|ctc_code", toolName: "codemode", content: [{ type: "text", text: "42" }] }), [
    { type: "custom_tool_call_output", call_id: "call_code", output: [{ type: "input_text", text: "42" }] },
  ]);
  assert.throws(() => messageToResponseItems({ ...call, content: [
    { ...call.content[0], arguments: { code: 42 } },
  ] }), /expected one string property/);
});

// [utest->req~remote-history.tool-replay~1]
test("shared transport replay preserves result-only continuation and replaces unsupported images", () => {
  assert.deepEqual(messagesToResponseItems([
    { role: "toolResult", toolCallId: "call_previous|fc_previous", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
  ], { input: ["text"] }), [
    { type: "function_call_output", call_id: "call_previous", output: [{ type: "input_text", text: "image content omitted because you do not support image input" }] },
  ]);
});

// [itest->req~remote-history.request-configuration~1]
test("direct OpenAI HTTP fallback preserves native inline tool declarations", async () => {
  const directModel = { ...model, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1" };
  const sessionId = randomUUID();
  setRemoteCompactionState(sessionId, { compactionEntryId: "c", modelKey: "openai:openai-responses:gpt-6.1-sol", replacementHistory: compacted, explicitHistory: compacted });
  let captured;
  await createOpenAIWebSocketStreamFn()(directModel, normalizeContext({ messages: [system, user] }), {
    apiKey: "offline-test", sessionId, transport: "sse",
    onPayload(payload) { captured = payload; throw new Error("OFFLINE_CAPTURE_COMPLETE"); },
  }).result();
  assert.ok(captured);
  assert.deepEqual(captured.input.filter((item) => item.type === "additional_tools").flatMap((item) => item.tools).map((tool) => tool.name), ["read", "bash"]);
  assert.ok(captured.input.some((item) => item.type === "compaction"));
});

// [itest->req~remote-history.request-configuration~1]
test("direct OpenAI WebSocket requests obtain current tools and instructions from Pi transcript messages", async () => {
  await withWebSocket((socket) => {
    const item = { type: "function_call", id: "fc_test", call_id: "call_test", name: "read", arguments: '{"path":"test.txt"}' };
    socket.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
    complete(socket, [item]);
  }, async (streamFn, requests) => {
    const response = await streamFn(directModel, normalizeContext({ messages: [system, user] }), {
      apiKey: "offline-test", sessionId: randomUUID(), transport: "websocket",
    }).result();
    assert.deepEqual(requests[0].tools?.map((tool) => tool.name), ["read", "bash"]);
    assert.equal(requests[0].instructions, system.content);
    assert.equal(response.stopReason, "toolUse");
    assert.equal(response.content[0].id, "call_test|fc_test");
    assert.deepEqual(response.content[0].arguments, { path: "test.txt" });
  });
});

const directModel = { ...model, provider: "openai", api: "openai-responses", baseUrl: "https://api.openai.com/v1",
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 } };

function complete(socket, output, extra = {}) {
  socket.send(JSON.stringify({ type: "response.completed", response: {
    id: "resp_test", object: "response", created_at: 0, status: "completed", model: model.id,
    output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }, ...extra,
  } }));
}

async function withWebSocket(respond, run) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const requests = [];
  server.on("connection", (socket) => socket.on("message", (data) => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    respond(socket, request);
  }));
  try {
    await run(createOpenAIWebSocketStreamFn({ url: `ws://127.0.0.1:${server.address().port}`, maxRetries: 0 }), requests);
  } finally {
    releaseAllWsSessions();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

for (const warmup of [false, true]) {
  // [itest->req~remote-history.tool-replay~1]
  // [itest->req~remote-history.request-configuration~1]
  test(`WebSocket native grammar/JSON tools survive warmup=${warmup}, continuation, updates, and restored compaction`, async () => {
    const grammar = {
      name: "code", description: "Execute synthetic code",
      parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"], additionalProperties: false },
      constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /.+/" } },
    };
    const regex = { ...grammar, name: "regex", constrainedSampling: { type: "grammar", variants: { openai_regex: ".+" } } };
    const strict = { ...read, constrainedSampling: { type: "json_schema", strict: "require" } };
    const nativeModel = { ...directModel, compat: { ...directModel.compat, supportsOpenAIGrammarTools: true, supportsStrictMode: true } };
    const head = { ...system, toolsAdded: [grammar, regex, strict] };
    const customInput = 'text("quoted")\ntext(42)';
    const items = [
      { type: "custom_tool_call", id: "ctc_code", call_id: "call_code", name: "code", namespace: "functions", input: customInput },
      { type: "custom_tool_call", id: "ctc_regex", call_id: "call_regex", name: "regex", input: "test" },
      { type: "function_call", id: "fc_read", call_id: "call_read", name: "read", namespace: "files", arguments: '{"path":"test.txt"}' },
    ];
    let turn = 0;
    await withWebSocket((socket, request) => {
      if (request.generate === false) return complete(socket, []);
      if (++turn === 1) {
        items.forEach((item, output_index) => {
          const custom = item.type === "custom_tool_call";
          socket.send(JSON.stringify({ type: "response.output_item.added", output_index,
            item: { ...item, ...(custom ? { input: "" } : { arguments: "" }) } }));
          const raw = custom ? item.input : item.arguments;
          for (const delta of [raw.slice(0, 5), raw.slice(5)]) {
            socket.send(JSON.stringify({ type: custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta",
              output_index, item_id: item.id, delta }));
          }
          socket.send(JSON.stringify({ type: "response.output_item.done", output_index, item }));
        });
        return complete(socket, items);
      }
      const item = { type: "message", id: "msg_receipt", role: "assistant", phase: "final_answer",
        content: [{ type: "output_text", text: "receipt" }] };
      socket.send(JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }));
      socket.send(JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "receipt" }));
      socket.send(JSON.stringify({ type: "response.output_item.done", output_index: 0, item }));
      complete(socket, [item], { service_tier: "priority",
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 } } });
    }, async (streamFn, requests) => {
      const sessionId = randomUUID();
      const options = { apiKey: "offline-test", sessionId, transport: "websocket", openaiWsWarmup: warmup };
      const messages = [head, user];
      const events = [];
      const stream = streamFn(nativeModel, normalizeContext({ messages }), options);
      for await (const event of stream) events.push(event);
      const response = await stream.result();
      assert.equal(response.stopReason, "toolUse");
      assert.deepEqual(response.content, [
        { type: "toolCall", id: "call_code|ctc_code", name: "code", namespace: "functions", arguments: { source: customInput } },
        { type: "toolCall", id: "call_regex|ctc_regex", name: "regex", arguments: { source: "test" } },
        { type: "toolCall", id: "call_read|fc_read", name: "read", namespace: "files", arguments: { path: "test.txt" } },
      ]);
      assert.deepEqual(events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall), response.content);
      assert.equal(events.filter((event) => event.type === "toolcall_start").length, 3);
      for (const request of requests) {
        assert.deepEqual(request.tools, [
          { type: "custom", name: "code", description: grammar.description, format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
          { type: "custom", name: "regex", description: grammar.description, format: { type: "grammar", syntax: "regex", definition: ".+" } },
          { type: "function", name: "read", description: read.description, parameters: read.parameters, strict: true },
        ]);
      }
      assert.equal(requests.filter((request) => request.generate === false).length, warmup ? 1 : 0);
      const results = response.content.map((call) => ({ role: "toolResult", toolCallId: call.id, toolName: call.name,
        content: [{ type: "text", text: "42" }], timestamp: 2 }));
      const nextMessages = [...messages, response, ...results];
      const textEvents = [];
      const next = streamFn(nativeModel, normalizeContext({ messages: nextMessages }), options);
      for await (const event of next) textEvents.push(event);
      const text = await next.result();
      assert.equal(requests.at(-1).previous_response_id, "resp_test");
      const replayedCalls = [
        { type: "custom_tool_call", name: "code", call_id: "call_code", namespace: "functions", input: customInput },
        { type: "custom_tool_call", name: "regex", call_id: "call_regex", input: "test" },
        { type: "function_call", name: "read", call_id: "call_read", namespace: "files", arguments: '{"path":"test.txt"}' },
      ];
      assert.deepEqual(requests.at(-1).input.filter((item) => item.type.endsWith("_call")), replayedCalls);
      assert.deepEqual(requests.at(-1).input.filter((item) => item.type.endsWith("_output")), [
        { type: "custom_tool_call_output", call_id: "call_code", output: [{ type: "input_text", text: "42" }] },
        { type: "custom_tool_call_output", call_id: "call_regex", output: [{ type: "input_text", text: "42" }] },
        { type: "function_call_output", call_id: "call_read", output: [{ type: "input_text", text: "42" }] },
      ]);
      assert.equal(text.content[0].text, "receipt");
      assert.deepEqual(JSON.parse(text.content[0].textSignature), { v: 1, id: "msg_receipt", phase: "final_answer" });
      assert.deepEqual(textEvents.filter((event) => event.type.startsWith("text_")).map((event) => event.type),
        ["text_start", "text_delta", "text_end"]);
      assert.equal(text.usage.input, 5);
      assert.equal(text.usage.cacheRead, 3);
      assert.equal(text.usage.cacheWrite, 2);
      assert.ok(Math.abs(text.usage.cost.total - 0.000025) < 1e-12);

      const update = { role: "system", content: "Use the late tool.", toolsAdded: [lateTool], toolsRemoved: [{ name: "regex" }], timestamp: 3 };
      const updated = [...nextMessages, text, update, user];
      await streamFn(nativeModel, normalizeContext({ messages: updated }), options).result();
      assert.equal(requests.at(-1).previous_response_id, undefined);
      assert.deepEqual(requests.at(-1).tools.map((tool) => tool.name), ["code", "read", "late_tool"]);
      assert.deepEqual(requests.at(-1).input.filter((item) => item.type.endsWith("_call")), replayedCalls);

      releaseAllWsSessions();
      clearAllContinuationState();
      const history = [...compacted, ...replayedCalls, ...messagesToResponseItems(results)];
      setRemoteCompactionState(sessionId, { compactionEntryId: "restored", modelKey: "openai:openai-responses:gpt-6.1-sol",
        replacementHistory: compacted, explicitHistory: history });
      await streamFn(nativeModel, normalizeContext({ messages: updated }), options).result();
      assert.equal(requests.at(-1).previous_response_id, undefined);
      assert.deepEqual(requests.at(-1).input, history);
      assert.equal(requests.at(-1).tools[0].type, "custom");
    });
  });
}

for (const terminal of ["failure", "close", "abort", "length"]) {
  test(`WebSocket shared decoding settles ${terminal}`, async () => {
    const controller = new AbortController();
    await withWebSocket((socket) => {
      if (terminal === "close") return socket.close(1011, "synthetic failure");
      if (terminal === "abort") return controller.abort();
      if (terminal === "failure") return socket.send(JSON.stringify({ type: "response.failed", response: {
        id: "resp_failure", output: [], status: "failed", error: { code: "synthetic", message: "synthetic failure" },
      } }));
      socket.send(JSON.stringify({ type: "response.incomplete", response: {
        id: "resp_length", output: [], status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      } }));
    }, async (streamFn) => {
      const response = await streamFn(directModel, normalizeContext({ messages: [system, user] }), {
        apiKey: "offline-test", sessionId: randomUUID(), transport: "websocket", signal: controller.signal,
      }).result();
      assert.equal(response.stopReason, terminal === "length" ? "length" : terminal === "abort" ? "aborted" : "error");
      assert.deepEqual(response.content, []);
      if (terminal === "failure" || terminal === "close") assert.match(response.errorMessage, /synthetic failure/);
    });
  });
}
