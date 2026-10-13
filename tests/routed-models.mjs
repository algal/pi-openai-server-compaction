// Run directly with: node --experimental-strip-types tests/routed-models.mjs
// Exercise the real extension handlers without a Pi session, credentials, or network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as piAi from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../src/index.ts";
import { resolvePhysicalModel, resolveRequestModel } from "../src/routed-model.ts";
import { modelKey } from "../src/openai.ts";
import {
  buildRemoteCompactionDetails,
  reconstructRemoteCompactionStateFromBranch,
} from "../src/remote-compaction.ts";
import {
  clearAllContinuationState,
  getContinuationState,
  getRemoteCompactionState,
  getResponsesRequestShapeState,
} from "../src/state.ts";

const virtual = { provider: "model-switcher", api: "pi-virtual", id: "auto" };
const gpt = {
  provider: "regression-gateway",
  api: "openai-responses",
  id: "openai/gpt-5-regression",
  name: "Regression GPT",
  baseUrl: "https://models.example.test/v1",
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
};
const otherGpt = { ...gpt, id: "gpt-5-other", name: "Other regression GPT" };
const directGpt = {
  ...gpt,
  provider: "openai",
  id: "gpt-5-regression",
  baseUrl: "https://api.openai.com/v1",
};
const opus = {
  ...gpt,
  provider: "anthropic",
  api: "anthropic-messages",
  id: "claude-opus-regression",
  baseUrl: "https://anthropic.example.test",
};
const duplicateGpt = { ...gpt, provider: "second-gateway" };
const fakeApiKey = "sk-regression-not-a-real-credential";
const timestamp = "2026-01-01T00:00:00.000Z";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "pi-routed-models-"));
const environment = {
  CODEX_HOME: join(temporaryDirectory, "codex"),
  PI_OPENAI_SERVER_COMPACTION_ENABLED: "true",
  PI_OPENAI_SERVER_COMPACTION_AZURE: "false",
  PI_OPENAI_SERVER_COMPACTION_THRESHOLD: "1234",
  PI_OPENAI_SERVER_COMPACTION_RATIO: "0.7",
  PI_OPENAI_SERVER_COMPACTION_NOTIFY: "false",
  PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID: "true",
};
const previousEnvironment = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Unexpected network request in routed-model regression test"); };
let sequence = 0;

function user(text) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistant(model, text, extra = {}) {
  return {
    role: "assistant",
    provider: model.provider,
    api: model.api,
    model: model.id,
    content: [{ type: "text", text }],
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
    ...extra,
  };
}

function messageEntry(message, extra = {}) {
  return { type: "message", message, ...extra };
}

function appendEntry(branch, entry) {
  const persisted = {
    id: `entry-${++sequence}`,
    parentId: branch.at(-1)?.id ?? null,
    timestamp,
    ...entry,
  };
  branch.push(persisted);
  return persisted;
}

function checkpoint(model = gpt, extra = {}) {
  return {
    type: "compaction",
    summary: "Portable checkpoint summary",
    firstKeptEntryId: "summarized-history-end",
    tokensBefore: 1200,
    fromHook: true,
    details: {
      remoteCompaction: buildRemoteCompactionDetails(model, [
        { type: "compaction", encrypted_content: "NATIVE_CHECKPOINT" },
      ]),
    },
    ...extra,
  };
}

function harness({ selected = virtual, entries = [], available, thinkingLevel = "high" } = {}) {
  const handlers = new Map();
  const providers = new Map();
  const allModels = [virtual, gpt, otherGpt, directGpt, opus, duplicateGpt];
  const h = {
    sessionId: `routed-test-${++sequence}`,
    branch: [],
    available: available ?? [gpt, otherGpt, directGpt, opus],
    authRequests: [],
    notifications: [],
    handlers,
    providers,
    append(entry) { return appendEntry(h.branch, entry); },
    async emit(name, event = {}) {
      assert.ok(handlers.has(name), `extension must register ${name}`);
      return handlers.get(name)(event, h.ctx);
    },
  };
  for (const entry of entries) h.append(entry);
  h.ctx = {
    cwd: temporaryDirectory,
    model: selected,
    hasUI: false,
    ui: { notify: (...args) => h.notifications.push(args) },
    getSystemPrompt: () => "CURRENT_SYSTEM_PROMPT",
    modelRegistry: {
      find: (provider, id) => allModels.find((model) => model.provider === provider && model.id === id),
      getAvailable: () => h.available,
      getApiKeyAndHeaders: async (model) => {
        h.authRequests.push(model);
        return { ok: true, apiKey: fakeApiKey, headers: { "x-regression-auth": model.provider } };
      },
    },
    sessionManager: {
      getSessionId: () => h.sessionId,
      getBranch: () => h.branch,
    },
  };
  extensionFactory({
    on: (name, handler) => {
      assert.equal(handlers.has(name), false, `duplicate handler for ${name}`);
      handlers.set(name, handler);
    },
    registerProvider: (name, provider) => providers.set(name, provider),
    getThinkingLevel: () => thinkingLevel,
    getActiveTools: () => ["read"],
    getAllTools: () => [
      { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
      { name: "inactive", description: "Inactive tool", parameters: { type: "object" } },
    ],
  });
  return h;
}

function request(model = gpt, extra = {}) {
  return {
    model: model.id,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "CURRENT_REQUEST" }] }],
    ...extra,
  };
}

function compactEvent(h, overrides = {}) {
  return {
    branchEntries: h.branch,
    preparation: {
      firstKeptEntryId: h.branch.at(-1)?.id ?? "first-kept",
      tokensBefore: 1200,
      messagesToSummarize: h.branch.filter((entry) => entry.type === "message").map((entry) => entry.message),
      turnPrefixMessages: [],
      isSplitTurn: false,
      previousSummary: undefined,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 512 },
    },
    customInstructions: "Preserve important work",
    signal: new AbortController().signal,
    ...overrides,
  };
}

function sse(events) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function summarySse({ text = "LOCAL_PORTABLE_SUMMARY", status = "completed" } = {}) {
  const item = {
    type: "message", id: "msg-summary", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return sse([
    { type: "response.created", response: { id: "resp-summary" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: status === "incomplete" ? "response.incomplete" : "response.completed", response: {
      id: "resp-summary", status, output: [item],
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
      usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
    } },
  ]);
}

async function withCompactionFetch(run, { rejectLocal = false, localResponse } = {}) {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (resource, init = {}) => {
    const body = JSON.parse(typeof init.body === "string" ? init.body : await resource.text());
    const url = typeof resource === "string" ? resource : resource.url ?? String(resource);
    const headers = new Headers(init.headers ?? resource.headers);
    const remote = body.input?.some((item) => item.type === "compaction_trigger") ?? false;
    calls.push({ url, body, headers, remote, method: init.method ?? resource.method });
    if (!remote) {
      // HTTP 400 cannot trigger SDK retry backoff, unlike a rejected fetch.
      if (rejectLocal) return Response.json({ error: { message: "Injected local summary failure", type: "invalid_request_error" } }, { status: 400 });
      return localResponse?.(calls.filter((call) => !call.remote).length) ?? summarySse();
    }
    return sse([
      { type: "response.output_item.done", item: { type: "compaction", encrypted_content: "REMOTE_SSE_CHECKPOINT" } },
      { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } },
    ]);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

function requestContext(h, { modern = false } = {}) {
  const tools = [{ name: "read", description: "Read current files", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];
  const messages = convertToLlm(buildSessionContext(h.branch).messages);
  if (modern) {
    return { messages: [{ role: "system", content: "CURRENT_TRANSCRIPT_SYSTEM", toolsAdded: tools, timestamp: 1 }, ...messages] };
  }
  return { systemPrompt: "CURRENT_LEGACY_SYSTEM", messages, tools };
}

async function streamRegisteredProvider(h, context, { beforePayload, transport = "sse" } = {}) {
  // Pi 1.x normalizes legacy prompt/tool fields before calling providers.
  const providerContext = typeof piAi.normalizeContext === "function" ? piAi.normalizeContext(context) : context;
  // Pi emits context before constructing the provider stream. The provider can
  // capture replay state before it later invokes before_provider_request.
  assert.equal(await h.emit("context", { messages: providerContext.messages }), undefined);
  const payloads = [];
  const events = [];
  const stream = h.providers.get("openai").streamSimple(directGpt, providerContext, {
    apiKey: fakeApiKey,
    sessionId: h.sessionId,
    transport,
    maxRetries: 0,
    timeoutMs: 2000,
    signal: AbortSignal.timeout(5000),
    maxTokens: 777,
    temperature: 0.2,
    reasoning: "high",
    onPayload: async (payload, model) => {
      assert.strictEqual(model, directGpt);
      payloads.push(structuredClone(payload));
      await beforePayload?.(payload);
      return h.emit("before_provider_request", { payload });
    },
  });
  for await (const event of stream) events.push(event);
  const result = await stream.result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.content.filter((item) => item.type === "text").map((item) => item.text).join(""), "LOCAL_PORTABLE_SUMMARY");
  assert.equal(payloads.length, 1);
  assert.ok(events.some((event) => event.type === "done"));
  return { result, payloads };
}

try {
  await test("physical resolver follows the latest finalized assistant, not the virtual selection", async (t) => {
    await t.test("latest GPT and Opus routes", () => {
      const h = harness({ entries: [messageEntry(user("begin")), messageEntry(assistant(gpt, "GPT"))] });
      assert.strictEqual(resolvePhysicalModel(h.ctx), gpt);
      h.append(messageEntry(assistant(opus, "Opus")));
      assert.strictEqual(resolvePhysicalModel(h.ctx), opus);
      assert.strictEqual(resolvePhysicalModel(h.ctx, assistant(directGpt, "event not yet persisted")), directGpt);
    });
    await t.test("empty and unresolved routes fail closed", () => {
      const h = harness({ entries: [messageEntry(user("no assistant"))] });
      assert.equal(resolvePhysicalModel(h.ctx), undefined);
      h.append(messageEntry(assistant(gpt, "known route")));
      h.append(messageEntry(assistant({ ...gpt, id: "missing-model" }, "unknown latest route")));
      assert.equal(resolvePhysicalModel(h.ctx), undefined, "must not fall back past an unresolved assistant");
      h.branch.at(-1).message = assistant({ ...gpt, api: "openai-completions" }, "API mismatch");
      assert.equal(resolvePhysicalModel(h.ctx), undefined);
      h.branch.at(-1).message = assistant(virtual, "virtual assistant cannot be a physical route");
      assert.equal(resolvePhysicalModel(h.ctx), undefined);
    });
    await t.test("failed attempts do not replace the latest successful route", () => {
      const h = harness({ entries: [messageEntry(assistant(gpt, "successful"))] });
      h.append(messageEntry(assistant(opus, "failed", { stopReason: "error" })));
      h.append(messageEntry(assistant(opus, "cancelled", { stopReason: "aborted" })));
      assert.strictEqual(resolvePhysicalModel(h.ctx), gpt);
    });
    await t.test("summarized assistants cannot select an old route", () => {
      const h = harness({ entries: [messageEntry(assistant(gpt, "summarized GPT")), messageEntry(user("retained user"))] });
      h.append(checkpoint(gpt, { firstKeptEntryId: h.branch.at(-1).id }));
      assert.equal(resolvePhysicalModel(h.ctx), undefined);
    });
    await t.test("tree traversal ignores an abandoned response", () => {
      const h = harness({ entries: [messageEntry(user("root"))] });
      const rootId = h.branch[0].id;
      const active = h.append(messageEntry(assistant(opus, "active Opus")));
      h.append(messageEntry(assistant(gpt, "abandoned GPT"), { parentId: rootId }));
      h.append(messageEntry(user("active leaf"), { parentId: active.id }));
      assert.strictEqual(resolvePhysicalModel(h.ctx), opus);
    });
    await t.test("direct physical selection is unchanged", () => {
      const h = harness({ selected: directGpt, entries: [messageEntry(assistant(opus, "other route"))] });
      assert.strictEqual(resolvePhysicalModel(h.ctx), directGpt);
      assert.strictEqual(resolvePhysicalModel(h.ctx, assistant(opus, "event")), directGpt);
      h.ctx.model = undefined;
      assert.equal(resolvePhysicalModel(h.ctx), undefined);
    });
  });

  await test("request resolver uses the actual Responses payload and a unique available physical model", () => {
    const h = harness({ entries: [messageEntry(assistant(opus, "previous Opus response"))] });
    assert.strictEqual(resolveRequestModel(h.ctx, request()), gpt, "first GPT request must not follow the previous Opus response");
    for (const payload of [undefined, null, [], "invalid", {}, { model: gpt.id }, { model: gpt.id, messages: [] }, { input: [] }, { model: 1, input: [] }, { model: opus.id, messages: [] }]) {
      assert.equal(resolveRequestModel(h.ctx, payload), undefined);
    }
    h.available = [];
    assert.equal(resolveRequestModel(h.ctx, request()), undefined, "a registered but unavailable model cannot supply request auth");
    h.available = [gpt, duplicateGpt];
    assert.equal(resolveRequestModel(h.ctx, request()), undefined, "duplicate authenticated providers are ambiguous");
    h.available = [gpt, { ...opus, id: gpt.id }];
    assert.strictEqual(resolveRequestModel(h.ctx, request()), gpt, "non-Responses candidates do not create ambiguity");
    h.ctx.model = directGpt;
    h.available = [directGpt, { ...directGpt, provider: "duplicate-direct" }];
    assert.strictEqual(resolveRequestModel(h.ctx, request(directGpt)), directGpt, "direct selection does not depend on registry ambiguity");
    assert.equal(resolveRequestModel(h.ctx, request(gpt)), undefined, "a direct selection must exactly match the request model ID");
    h.ctx.model = opus;
    assert.equal(resolveRequestModel(h.ctx, request()), undefined);
  });

  await test("virtual GPT compaction uses the physical endpoint, auth, tools, and observed request settings", async () => {
    const h = harness({ entries: [messageEntry(user("USER_TO_KEEP")), messageEntry(assistant(gpt, "ASSISTANT_TO_SUMMARIZE"))] });
    assert.equal(h.providers.get("openai")?.api, "openai-responses");
    assert.equal(typeof h.providers.get("openai")?.streamSimple, "function");
    const observed = request(gpt, { reasoning: { effort: "medium", summary: "detailed" }, text: { verbosity: "low" } });
    assert.equal(await h.emit("before_provider_request", { payload: observed }), undefined);
    await withCompactionFetch(async (calls) => {
      const result = await h.emit("session_before_compact", compactEvent(h));
      assert.deepEqual(h.authRequests, [gpt], "virtual provider credentials must never be requested");
      const remoteCalls = calls.filter((call) => call.remote);
      assert.equal(remoteCalls.length, 1);
      const remote = remoteCalls[0];
      assert.equal(remote.url, "https://models.example.test/v1/responses");
      assert.equal(remote.method, "POST");
      assert.equal(remote.headers.get("authorization"), `Bearer ${fakeApiKey}`);
      assert.equal(remote.headers.get("x-regression-auth"), gpt.provider);
      assert.equal(remote.headers.get("session_id"), h.sessionId);
      assert.equal(remote.headers.get("x-codex-beta-features"), "remote_compaction_v2");
      assert.equal(remote.body.model, gpt.id);
      assert.equal(remote.body.instructions, "CURRENT_SYSTEM_PROMPT");
      assert.deepEqual(remote.body.tools.map((tool) => tool.name), ["read"]);
      assert.deepEqual(remote.body.reasoning, observed.reasoning);
      assert.deepEqual(remote.body.text, observed.text);
      assert.equal(remote.body.store, false);
      assert.equal(remote.body.stream, true);
      assert.deepEqual(remote.body.input.at(-1), { type: "compaction_trigger" });
      assert.match(JSON.stringify(remote.body.input), /USER_TO_KEEP/);
      assert.match(JSON.stringify(remote.body.input), /ASSISTANT_TO_SUMMARIZE/);
      const localCalls = calls.filter((call) => !call.remote);
      assert.equal(localCalls.length, 1, "portable summary must use the mocked transport too");
      assert.equal(localCalls[0].body.model, gpt.id);
      assert.equal(localCalls[0].headers.get("authorization"), `Bearer ${fakeApiKey}`);
      assert.equal(result.compaction.summary, "LOCAL_PORTABLE_SUMMARY");
      assert.equal(result.compaction.firstKeptEntryId, h.branch.at(-1).id);
      assert.equal(result.compaction.tokensBefore, 1200);
      const details = result.compaction.details.remoteCompaction;
      assert.equal(details.modelKey, modelKey(gpt));
      assert.equal(details.version, 2);
      assert.equal(details.usage.totalTokens, 105);
      assert.ok(details.replacementHistory.some((item) => item.encrypted_content === "REMOTE_SSE_CHECKPOINT"));
    });
  });

  await test("local summary failures do not block a native checkpoint and warn about reduced portability", async () => {
    const h = harness({ entries: [messageEntry(user("work")), messageEntry(assistant(gpt, "completed work"))] });
    h.ctx.hasUI = true;
    await withCompactionFetch(async (calls) => {
      const result = await h.emit("session_before_compact", compactEvent(h));
      assert.equal(calls.filter((call) => !call.remote).length, 2, "portable and standard summary requests must each fail without retries");
      assert.equal(calls.filter((call) => call.remote).length, 1);
      assert.match(result.compaction.summary, /OpenAI remote compaction applied/);
      assert.equal(result.compaction.details.remoteCompaction.modelKey, modelKey(gpt));
      assert.ok(result.compaction.details.remoteCompaction.replacementHistory.some((item) => item.type === "compaction"));
      assert.equal(h.notifications.length, 1);
      assert.match(h.notifications[0][0], /portable text summary failed/);
      assert.equal(h.notifications[0][1], "warning");
    }, { rejectLocal: true });
  });

  await test("empty and incomplete portable summaries fall back to Pi's standard summary", async (t) => {
    for (const initialReply of [{ text: "" }, { text: "TRUNCATED_PORTABLE_SUMMARY", status: "incomplete" }]) {
      await t.test(initialReply.status ?? "empty", async () => {
        const h = harness({ entries: [messageEntry(user("work")), messageEntry(assistant(gpt, "completed work"))] });
        h.ctx.hasUI = true;
        await withCompactionFetch(async (calls) => {
          const result = await h.emit("session_before_compact", compactEvent(h));
          assert.equal(calls.filter((call) => !call.remote).length, 2, "a rejected portable summary must trigger the standard summary");
          assert.equal(result.compaction.summary, "LOCAL_PORTABLE_SUMMARY");
          assert.ok(result.compaction.details.remoteCompaction);
          assert.deepEqual(h.notifications, []);
        }, { localResponse: (index) => summarySse(index === 1 ? initialReply : undefined) });
      });
    }
  });

  await test("direct GPT request patching and physical compaction stay unchanged", async () => {
    const h = harness({ selected: directGpt, entries: [messageEntry(user("direct work")), messageEntry(assistant(directGpt, "direct reply"))] });
    const payload = request(directGpt);
    const before = structuredClone(payload);
    const patched = await h.emit("before_provider_request", { payload });
    assert.equal(patched.store, true);
    assert.deepEqual(patched.context_management, [{ type: "compaction", compact_threshold: 1234 }]);
    assert.deepEqual(payload, before, "patching must not mutate the original request");
    assert.equal(await h.emit("before_provider_request", { payload: request(gpt) }), undefined);
    await withCompactionFetch(async (calls) => {
      const result = await h.emit("session_before_compact", compactEvent(h));
      assert.deepEqual(h.authRequests, [directGpt]);
      assert.equal(calls.find((call) => call.remote).url, "https://api.openai.com/v1/responses");
      assert.equal(result.compaction.details.remoteCompaction.modelKey, modelKey(directGpt));
    });
    const physicalOpus = harness({ selected: opus, entries: [messageEntry(assistant(gpt, "old GPT"))] });
    assert.equal(await physicalOpus.emit("session_before_compact", compactEvent(physicalOpus)), undefined);
    assert.deepEqual(physicalOpus.authRequests, []);
  });

  await test("switching a virtual request from GPT to Opus leaves the Opus payload untouched", async () => {
    const h = harness({ entries: [checkpoint(), messageEntry(assistant(gpt, "latest GPT"))] });
    await h.emit("session_start");
    assert.ok(await h.emit("before_provider_request", { payload: request() }));
    const payload = { model: opus.id, messages: [{ role: "user", content: "OPUS_WORK" }], max_tokens: 2048 };
    const before = structuredClone(payload);
    assert.equal(await h.emit("before_provider_request", { payload }), undefined);
    assert.deepEqual(payload, before);
    assert.equal(await h.emit("before_provider_request", { payload: { ...payload, input: [] } }), undefined, "an Opus ID must not inherit GPT request features");
    h.append(messageEntry(assistant(opus, "latest Opus")));
    assert.equal(await h.emit("session_before_compact", compactEvent(h)), undefined);
    assert.deepEqual(h.authRequests, []);
  });

  await test("the first GPT request after Opus follows its payload, while unavailable or ambiguous IDs fail closed", async () => {
    const h = harness({ entries: [messageEntry(assistant(opus, "previous Opus"))] });
    const payload = request(directGpt);
    assert.equal((await h.emit("before_provider_request", { payload })).store, true);
    assert.equal(getResponsesRequestShapeState(h.sessionId).modelKey, modelKey(directGpt));
    h.available = [];
    assert.equal(await h.emit("before_provider_request", { payload }), undefined);
    h.available = [directGpt, { ...directGpt, provider: "same-id-provider" }];
    assert.equal(await h.emit("before_provider_request", { payload }), undefined);
    assert.deepEqual(h.authRequests, []);
  });

  await test("an assistant event updates continuation before its message reaches the persisted branch", async () => {
    const h = harness({ entries: [messageEntry(user("pending reply"))] });
    const branchLength = h.branch.length;
    await h.emit("message_end", { message: assistant(directGpt, "unpersisted reply", { responseId: "resp-event-before-persist" }) });
    const continuation = getContinuationState(h.sessionId);
    assert.equal(continuation.responseId, "resp-event-before-persist");
    assert.equal(continuation.modelKey, modelKey(directGpt));
    assert.equal(h.branch.length, branchLength);
    const patched = await h.emit("before_provider_request", { payload: request(directGpt) });
    assert.equal("previous_response_id" in patched, false, "a full HTTP transcript must not acquire the cached response ID");
    const incremental = await h.emit("before_provider_request", { payload: request(directGpt, { previous_response_id: "resp-owned-by-ws-transport" }) });
    assert.equal(incremental.previous_response_id, "resp-owned-by-ws-transport", "the hook must preserve a pointer selected by the incremental transport");
    await h.emit("message_end", { message: assistant(directGpt, "failed", { responseId: "resp-error", stopReason: "error" }) });
    await h.emit("message_end", { message: assistant(directGpt, "aborted", { responseId: "resp-aborted", stopReason: "aborted" }) });
    await h.emit("message_end", { message: user("not an assistant") });
    assert.equal(getContinuationState(h.sessionId).responseId, "resp-event-before-persist");
    await h.emit("message_end", { message: assistant(opus, "Opus answered before persistence") });
    assert.equal(getContinuationState(h.sessionId), undefined, "an Opus reply must clear the previous GPT continuation");
    const afterOpus = await h.emit("before_provider_request", { payload: request(directGpt) });
    assert.equal("previous_response_id" in afterOpus, false, "returning to GPT must not reuse a response that omitted Opus work");
    await h.emit("message_end", { message: assistant(directGpt, "new GPT answer", { responseId: "resp-new-gpt" }) });
    assert.equal(getContinuationState(h.sessionId).responseId, "resp-new-gpt");
    await h.emit("message_end", { message: assistant({ ...directGpt, id: "unknown-physical-model" }, "unresolved physical reply") });
    assert.equal(getContinuationState(h.sessionId), undefined, "an unresolved route must clear the previous GPT continuation");
    await h.emit("message_end", { message: assistant(directGpt, "another GPT answer", { responseId: "resp-model-select" }) });
    await h.emit("model_select");
    assert.equal(getContinuationState(h.sessionId), undefined);
  });

  await test("registered OpenAI SSE transport refreshes pending history before the payload hook and preserves current instructions", async (t) => {
    for (const modern of [false, true]) {
      await t.test(modern ? "transcript system messages" : "legacy systemPrompt", async (t) => {
        if (modern && typeof piAi.normalizeContext !== "function") {
          t.skip("Installed Pi uses legacy Context.systemPrompt; transcript-system coverage requires Pi 1.x");
          return;
        }
        const h = harness({ entries: [checkpoint(directGpt), messageEntry(user("DIRECT_USER_AFTER_CHECKPOINT")), messageEntry(assistant(directGpt, "reading", {
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-pending|fc-pending", name: "read", arguments: { path: "current.txt" } }],
        }))] });
        await h.emit("session_start");
        assert.doesNotMatch(JSON.stringify(getRemoteCompactionState(h.sessionId).explicitHistory), /NEW_PENDING_TOOL_RESULT|NEW_PENDING_USER/);
        h.append(messageEntry({ role: "toolResult", toolCallId: "call-pending|fc-pending", toolName: "read", content: [{ type: "text", text: "NEW_PENDING_TOOL_RESULT" }], isError: false, timestamp: 3 }));
        h.append(messageEntry(user("NEW_PENDING_USER")));
        const context = requestContext(h, { modern });
        const originalContext = structuredClone(context);
        await withCompactionFetch(async (calls) => {
          const { payloads } = await streamRegisteredProvider(h, context, {
            beforePayload: (payload) => {
              const input = JSON.stringify(payload.input);
              assert.match(input, /NATIVE_CHECKPOINT/);
              assert.match(input, /NEW_PENDING_TOOL_RESULT/);
              assert.match(input, /NEW_PENDING_USER/, "fresh history must reach the transport before before_provider_request runs");
              assert.match(JSON.stringify(getRemoteCompactionState(h.sessionId).explicitHistory), /NEW_PENDING_TOOL_RESULT/);
            },
          });
          assert.equal(calls.length, 1, "SSE transport must make one mocked HTTP request and no compaction call");
          const sent = calls[0];
          assert.equal(sent.remote, false);
          assert.equal(sent.url, "https://api.openai.com/v1/responses");
          assert.equal(sent.headers.get("authorization"), `Bearer ${fakeApiKey}`);
          assert.equal(sent.body.model, directGpt.id);
          const input = JSON.stringify(sent.body.input);
          assert.match(input, modern ? /CURRENT_TRANSCRIPT_SYSTEM/ : /CURRENT_LEGACY_SYSTEM/);
          assert.match(input, /NATIVE_CHECKPOINT/);
          assert.match(input, /DIRECT_USER_AFTER_CHECKPOINT/);
          assert.match(input, /NEW_PENDING_TOOL_RESULT/);
          assert.match(input, /NEW_PENDING_USER/);
          assert.doesNotMatch(input, /Portable checkpoint summary/, "native history must replace the portable checkpoint, not duplicate it");
          assert.ok(["system", "developer"].includes(sent.body.input[0].role), "current provider instructions must precede native history");
          assert.equal(sent.body.input[1].type, "compaction");
          assert.equal(sent.body.input.filter((item) => item.type === "function_call_output").length, 1);
          assert.equal(sent.body.input.find((item) => item.type === "function_call_output").call_id, "call-pending");
          assert.deepEqual(sent.body.tools.map((tool) => tool.name), ["read"]);
          assert.equal(sent.body.max_output_tokens, 777);
          assert.equal(sent.body.temperature, 0.2);
          assert.equal(sent.body.reasoning.effort, "high");
          assert.equal(sent.body.store, true);
          assert.ok(sent.body.context_management);
          assert.equal("previous_response_id" in sent.body, false);
          assert.deepEqual(sent.body.input, payloads[0].input, "the request hook must not replace freshly reconstructed transport input");
          assert.deepEqual(context, originalContext);
        });
      });
    }
  });

  await test("registered HTTP transport sends a complete transcript without adding the cached response ID", async (t) => {
    for (const modern of [false, true]) {
      await t.test(modern ? "transcript system messages" : "legacy systemPrompt", async (t) => {
        if (modern && typeof piAi.normalizeContext !== "function") {
          t.skip("Installed Pi uses legacy Context.systemPrompt; transcript-system coverage requires Pi 1.x");
          return;
        }
        const h = harness({ entries: [messageEntry(user("OLD_USER_IN_FULL_TRANSCRIPT"))] });
        const oldReply = assistant(directGpt, "OLD_REPLY_IN_FULL_TRANSCRIPT", { responseId: "resp-already-in-full-transcript" });
        await h.emit("message_end", { message: oldReply });
        h.append(messageEntry(oldReply));
        h.append(messageEntry(user("NEW_USER_IN_FULL_TRANSCRIPT")));
        assert.equal(getContinuationState(h.sessionId).responseId, "resp-already-in-full-transcript");
        await withCompactionFetch(async (calls) => {
          await streamRegisteredProvider(h, requestContext(h, { modern }), {
            beforePayload: (payload) => {
              assert.equal(getContinuationState(h.sessionId).responseId, "resp-already-in-full-transcript", "valid cached state stays available to incremental WS requests");
              assert.equal("previous_response_id" in payload, false);
            },
          });
          assert.equal(calls.length, 1);
          const body = calls[0].body;
          const input = JSON.stringify(body.input);
          assert.match(input, modern ? /CURRENT_TRANSCRIPT_SYSTEM/ : /CURRENT_LEGACY_SYSTEM/);
          assert.match(input, /OLD_USER_IN_FULL_TRANSCRIPT/);
          assert.match(input, /OLD_REPLY_IN_FULL_TRANSCRIPT/);
          assert.match(input, /NEW_USER_IN_FULL_TRANSCRIPT/);
          assert.equal("previous_response_id" in body, false, "a pointer plus the full old transcript would duplicate prior history");
          assert.deepEqual(body.tools.map((tool) => tool.name), ["read"]);
        });
      });
    }
  });

  await test("context hook invalidates stale direct transport state before GPT returns after Opus or a context edit", async (t) => {
    for (const reason of ["GPT to Opus to GPT", "context_edit"]) {
      await t.test(reason, async () => {
        const h = harness({ entries: [checkpoint(directGpt), messageEntry(user("old question"))] });
        await h.emit("session_start");
        const oldReply = assistant(directGpt, "OLD_DIRECT_REPLY", { responseId: "resp-before-context-change" });
        await h.emit("message_end", { message: oldReply });
        h.append(messageEntry(oldReply));
        assert.equal(getContinuationState(h.sessionId).responseId, "resp-before-context-change");
        if (reason === "context_edit") {
          h.append({ type: "context_edit", edits: [{ type: "remove", entryId: h.branch.at(-1).id }] });
        } else {
          h.append(messageEntry(user("ask Opus")));
          const opusReply = assistant(opus, "OPUS_WORK_IN_CANONICAL_CONTEXT");
          await h.emit("message_end", { message: opusReply });
          h.append(messageEntry(opusReply));
          h.append(messageEntry(user("return to GPT")));
          h.append(messageEntry(assistant(directGpt, "GPT_RETURNED_AFTER_OPUS")));
          assert.equal(getContinuationState(h.sessionId), undefined);
        }
        assert.ok(getRemoteCompactionState(h.sessionId), "seed a stale checkpoint to verify the context hook clears it before transport construction");
        const context = requestContext(h);
        if (reason === "context_edit") {
          // Pi 0.80 does not apply newer context_edit entries. Supply the
          // finalized edited transcript that modern Pi passes to its provider.
          context.messages = [user("EDITED_PORTABLE_CONTEXT")];
        }
        await withCompactionFetch(async (calls) => {
          await streamRegisteredProvider(h, context, {
            beforePayload: (payload) => {
              assert.equal(getRemoteCompactionState(h.sessionId), undefined);
              assert.equal(getContinuationState(h.sessionId), undefined);
              assert.doesNotMatch(JSON.stringify(payload.input), /NATIVE_CHECKPOINT/, "stale native input must be absent before the request hook can resync state");
              assert.equal("previous_response_id" in payload, false);
            },
          });
          assert.equal(calls.length, 1);
          const body = calls[0].body;
          const input = JSON.stringify(body.input);
          assert.doesNotMatch(input, /NATIVE_CHECKPOINT/);
          assert.match(input, /CURRENT_LEGACY_SYSTEM/);
          assert.match(input, reason === "context_edit" ? /EDITED_PORTABLE_CONTEXT/ : /OPUS_WORK_IN_CANONICAL_CONTEXT/);
          assert.equal("previous_response_id" in body, false, "an old response ID must not bypass an edited or mixed-model transcript");
          assert.ok(body.context_management);
        });
      });
    }
  });

  await test("reload reconstructs native history with trailing user and tool output, then refreshes it at every request", async () => {
    const h = harness({ entries: [checkpoint(), messageEntry(user("AFTER_CHECKPOINT_USER")), messageEntry(assistant(gpt, "tool request", {
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "call-read|fc-read", name: "read", arguments: { path: "example.txt" } }],
    }))] });
    clearAllContinuationState();
    await h.emit("session_start");
    assert.ok(getRemoteCompactionState(h.sessionId));
    h.append(messageEntry({ role: "toolResult", toolCallId: "call-read|fc-read", toolName: "read", content: [{ type: "text", text: "TRAILING_TOOL_OUTPUT" }], isError: false, timestamp: 3 }));
    h.append(messageEntry(user("QUEUED_USER_MESSAGE")));
    const instructions = [
      { type: "message", role: "system", content: [{ type: "input_text", text: "PROVIDER_SYSTEM_INSTRUCTION" }] },
      { role: "developer", content: "PROVIDER_DEVELOPER_INSTRUCTION" },
    ];
    const payload = request(gpt, {
      input: [...instructions, { role: "user", content: "STALE_PORTABLE_HISTORY" }],
      instructions: "TOP_LEVEL_INSTRUCTION",
      tools: [{ type: "function", name: "current_tool", parameters: { type: "object" } }],
      tool_choice: "required",
      parallel_tool_calls: false,
      reasoning: { effort: "high", summary: "auto" },
      text: { verbosity: "high", format: { type: "text" } },
      temperature: 0.4,
      max_output_tokens: 777,
      stream: true,
      store: false,
      previous_response_id: "must-be-removed",
      messages: [{ role: "user", content: "must-be-removed" }],
    });
    const original = structuredClone(payload);
    const patched = await h.emit("before_provider_request", { payload });
    assert.ok(patched);
    assert.deepEqual(patched.input.slice(0, 2), instructions, "provider system/developer instructions must precede native history");
    assert.deepEqual(patched.input.slice(2).map((item) => item.type), ["compaction", "message", "function_call", "function_call_output", "message"]);
    assert.equal(patched.input[2].encrypted_content, "NATIVE_CHECKPOINT");
    assert.match(JSON.stringify(patched.input), /AFTER_CHECKPOINT_USER/);
    assert.match(JSON.stringify(patched.input), /TRAILING_TOOL_OUTPUT/);
    assert.match(JSON.stringify(patched.input), /QUEUED_USER_MESSAGE/);
    assert.doesNotMatch(JSON.stringify(patched.input), /STALE_PORTABLE_HISTORY/);
    assert.equal(patched.input.find((item) => item.type === "function_call_output").call_id, "call-read");
    assert.equal("previous_response_id" in patched, false);
    assert.equal("messages" in patched, false);
    for (const key of ["model", "instructions", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "temperature", "max_output_tokens", "stream", "store"]) {
      assert.deepEqual(patched[key], payload[key], `${key} must survive history replacement`);
    }
    assert.deepEqual(payload, original, "history replacement must not mutate the source payload");
    h.append(messageEntry(user("ADDED_AFTER_FIRST_REQUEST")));
    const next = await h.emit("before_provider_request", { payload: request() });
    assert.match(JSON.stringify(next.input), /ADDED_AFTER_FIRST_REQUEST/);
    assert.equal(next.input.filter((item) => item.type === "function_call_output").length, 1, "reconstruction must not duplicate the tool output");
    await h.emit("session_before_switch");
    assert.equal(getRemoteCompactionState(h.sessionId), undefined);
    await h.emit("session_start");
    assert.match(JSON.stringify(getRemoteCompactionState(h.sessionId).explicitHistory), /ADDED_AFTER_FIRST_REQUEST/);
  });

  await test("a validated checkpoint identifies a gateway even when another available provider has the same model ID", async () => {
    const h = harness({ entries: [checkpoint(), messageEntry(user("PENDING_WITH_DUPLICATE_ID"))], available: [gpt, duplicateGpt, opus] });
    await h.emit("session_start");
    const patched = await h.emit("before_provider_request", { payload: request() });
    assert.ok(patched);
    assert.match(JSON.stringify(patched.input), /NATIVE_CHECKPOINT/);
    assert.match(JSON.stringify(patched.input), /PENDING_WITH_DUPLICATE_ID/);
    assert.equal(getResponsesRequestShapeState(h.sessionId).modelKey, modelKey(gpt));
    h.append(messageEntry(assistant(opus, "OPUS_INVALIDATES_CHECKPOINT")));
    assert.equal(await h.emit("before_provider_request", { payload: request() }), undefined);
  });

  await test("GPT to Opus to GPT cannot replay a checkpoint that omits Opus work", async () => {
    const h = harness({ entries: [checkpoint(), messageEntry(assistant(gpt, "GPT_AFTER_CHECKPOINT"))] });
    await h.emit("session_start");
    assert.ok(await h.emit("before_provider_request", { payload: request() }));
    h.append(messageEntry(user("ask Opus")));
    h.append(messageEntry(assistant(opus, "OPUS_WORK_MUST_NOT_DISAPPEAR")));
    const opusPayload = { model: opus.id, messages: [{ role: "assistant", content: "OPUS_WORK_MUST_NOT_DISAPPEAR" }] };
    assert.equal(await h.emit("before_provider_request", { payload: opusPayload }), undefined);
    h.append(messageEntry(user("back to GPT")));
    const gptPayload = request(gpt, { input: [{ role: "user", content: "PORTABLE_CONTEXT_WITH_OPUS_WORK" }] });
    const original = structuredClone(gptPayload);
    assert.equal(await h.emit("before_provider_request", { payload: gptPayload }), undefined);
    assert.equal(getRemoteCompactionState(h.sessionId), undefined);
    assert.deepEqual(gptPayload, original);
    h.append(messageEntry(assistant(gpt, "GPT back again")));
    assert.equal(await h.emit("before_provider_request", { payload: gptPayload }), undefined, "a newer GPT response cannot hide the incompatible Opus suffix");
  });

  await test("persisted context edits invalidate checkpoint replay", async () => {
    const h = harness({ entries: [checkpoint(), messageEntry(assistant(gpt, "compatible suffix"))] });
    await h.emit("session_start");
    assert.ok(getRemoteCompactionState(h.sessionId));
    h.append({ type: "context_edit", edits: [{ type: "remove", entryId: "prior-entry" }] });
    assert.equal(reconstructRemoteCompactionStateFromBranch({ branchEntries: h.branch }), undefined);
    assert.equal(await h.emit("before_provider_request", { payload: request() }), undefined);
    assert.equal(getRemoteCompactionState(h.sessionId), undefined);
  });

  await test("background custom messages and branch summaries survive native checkpoint replay", async () => {
    const h = harness({ entries: [checkpoint(), messageEntry(assistant(gpt, "compatible suffix"))] });
    await h.emit("session_start");
    h.append({
      type: "custom_message",
      customType: "background-task-completed",
      content: [{ type: "text", text: "BACKGROUND_RESULT_MUST_SURVIVE" }],
      display: true,
      timestamp,
      details: { taskId: "regression-background-task" },
    });
    h.append({ type: "branch_summary", fromId: "another-branch", summary: "BRANCH_WORK_MUST_SURVIVE", timestamp });
    h.append(messageEntry(user("QUEUED_AFTER_BACKGROUND_RESULT")));
    const patched = await h.emit("before_provider_request", { payload: request() });
    assert.ok(patched, "background notifications must not disable native history replay");
    const input = JSON.stringify(patched.input);
    assert.match(input, /NATIVE_CHECKPOINT/);
    assert.match(input, /BACKGROUND_RESULT_MUST_SURVIVE/);
    assert.match(input, /BRANCH_WORK_MUST_SURVIVE/);
    assert.match(input, /QUEUED_AFTER_BACKGROUND_RESULT/);
    assert.equal(patched.input.filter((item) => JSON.stringify(item).includes("BACKGROUND_RESULT_MUST_SURVIVE")).length, 1);
    assert.ok(getRemoteCompactionState(h.sessionId));
    await h.emit("session_before_switch");
    await h.emit("session_start");
    const reloaded = await h.emit("before_provider_request", { payload: request() });
    assert.deepEqual(reloaded.input, patched.input, "persisted background content must survive reload unchanged");
  });

  await test("a later portable compaction supersedes an older native checkpoint", async () => {
    const h = harness({ entries: [checkpoint(), messageEntry(user("retained user")), messageEntry(assistant(gpt, "retained GPT"))] });
    const firstKeptEntryId = h.branch[1].id;
    await h.emit("session_start");
    h.append({ type: "compaction", summary: "NEW_PORTABLE_SUMMARY", firstKeptEntryId, tokensBefore: 2400 });
    await h.emit("session_compact");
    assert.equal(getRemoteCompactionState(h.sessionId), undefined);
    assert.equal(await h.emit("before_provider_request", { payload: request() }), undefined);
  });

  await test("request settings observed for a different physical model are not reused for compaction", async () => {
    const h = harness({ entries: [messageEntry(user("begin")), messageEntry(assistant(gpt, "previous GPT"))], thinkingLevel: "high" });
    await h.emit("before_provider_request", { payload: request(gpt, { reasoning: { effort: "low", summary: "detailed" }, text: { verbosity: "low" } }) });
    h.append(messageEntry(assistant(otherGpt, "new physical model")));
    await withCompactionFetch(async (calls) => {
      const result = await h.emit("session_before_compact", compactEvent(h));
      const remote = calls.find((call) => call.remote);
      assert.equal(remote.body.model, otherGpt.id);
      assert.deepEqual(h.authRequests, [otherGpt]);
      assert.deepEqual(remote.body.reasoning, { effort: "high", summary: "auto" });
      assert.equal("text" in remote.body, false);
      assert.equal(result.compaction.details.remoteCompaction.modelKey, modelKey(otherGpt));
    });
  });

  await test("new compaction uses finalized context rather than already summarized raw messages", async () => {
    const h = harness({ entries: [messageEntry(user("OLD_SUMMARIZED_USER")), messageEntry(assistant(opus, "OLD_SUMMARIZED_OPUS")), messageEntry(user("RETAINED_USER")), messageEntry(assistant(gpt, "RETAINED_GPT"))] });
    h.append({ type: "compaction", summary: "CANONICAL_PORTABLE_SUMMARY", firstKeptEntryId: h.branch[2].id, tokensBefore: 2400 });
    assert.strictEqual(resolvePhysicalModel(h.ctx), gpt);
    await withCompactionFetch(async (calls) => {
      const result = await h.emit("session_before_compact", compactEvent(h));
      const input = JSON.stringify(calls.find((call) => call.remote).body.input);
      assert.doesNotMatch(input, /OLD_SUMMARIZED_USER|OLD_SUMMARIZED_OPUS/);
      assert.match(input, /CANONICAL_PORTABLE_SUMMARY/, "the native checkpoint must include Pi's existing portable summary, not only the retained suffix");
      assert.match(input, /RETAINED_USER/);
      assert.match(input, /RETAINED_GPT/);
      assert.equal(result.compaction.details.remoteCompaction.modelKey, modelKey(gpt));
    });
  });
} finally {
  clearAllContinuationState();
  globalThis.fetch = originalFetch;
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
