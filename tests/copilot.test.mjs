import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getModel } from "@earendil-works/pi-ai/compat";
import { RpcClient, SessionManager } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../src/index.ts";

const usage = {
  input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(model, text) {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text }], stopReason: "stop", usage, timestamp: Date.now(),
  };
}

function sendEvents(response, events) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
}

function textEvents(model, text) {
  const item = {
    type: "message", id: "msg_summary", role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: "resp_summary", model, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: {
      id: "resp_summary", model, status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    } },
  ];
}

async function harness(t, mode = "success") {
  const cwd = mkdtempSync(join(tmpdir(), "pi-copilot-compaction-"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "openai-server-compaction.json"), JSON.stringify({ enabled: true, notify: true }));
  const requests = [];
  let compactionStarted;
  const started = new Promise((resolve) => { compactionStarted = resolve; });
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const isCompaction = body.input?.at(-1)?.type === "compaction_trigger";
    requests.push({ path: request.url, headers: request.headers, body, isCompaction });
    if (!isCompaction) {
      if (mode === "both-fail") {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Summary request rejected" } }));
        return;
      }
      sendEvents(response, textEvents(body.model, "Portable summary for other providers."));
      return;
    }
    compactionStarted();
    if (mode === "abort") return;
    if (mode === "unsupported" || mode === "both-fail") {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Unsupported input item: compaction_trigger" } }));
      return;
    }
    if (mode === "missing-artifact") {
      sendEvents(response, textEvents(body.model, "An ordinary response is not a compaction artifact."));
      return;
    }
    const item = { type: "compaction", id: "cmp_wire", encrypted_content: mode === "empty-artifact" ? "" : "SYNTHETIC_ENCRYPTED_STATE" };
    sendEvents(response, [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_compacted", status: "completed", output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } },
    ]);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(cwd, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const model = { ...getModel("github-copilot", "gpt-6-luna"), baseUrl: "https://wrong-endpoint.invalid" };
  const notifications = [];
  const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
  sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Remember synthetic PIN 314159." }], timestamp: 1 });
  sessionManager.appendMessage(assistant(model, "I will remember it."));
  const keptId = sessionManager.appendMessage({
    role: "user", content: [
      { type: "text", text: "Continue from the saved state." },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ], timestamp: 2,
  });
  let authCalls = 0;
  const ctx = {
    cwd, model, hasUI: true, sessionManager,
    ui: { notify: (message, level) => notifications.push({ message, level }) },
    getSystemPrompt: () => "Current system instructions.",
    modelRegistry: { getApiKeyAndHeaders: async () => {
      authCalls++;
      return { ok: true, apiKey: "synthetic-copilot-token", baseUrl, headers: { "X-Extra": "yes", "X-Deleted": null } };
    } },
  };
  const handlers = new Map();
  const registeredProviders = [];
  extensionFactory({
    registerProvider: (provider) => registeredProviders.push(provider),
    on: (name, handler) => handlers.set(name, handler),
    getAllTools: () => [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "high",
  });
  const emit = (name, event = {}) => handlers.get(name)?.(event, ctx);
  const compact = (signal = new AbortController().signal) => {
    const branchEntries = sessionManager.getBranch();
    const messages = branchEntries.filter((entry) => entry.type === "message").map((entry) => entry.message);
    return emit("session_before_compact", {
      branchEntries, signal, customInstructions: "Preserve the task.",
      preparation: {
        messagesToSummarize: messages, turnPrefixMessages: [], isSplitTurn: false,
        firstKeptEntryId: keptId, tokensBefore: 100,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
        settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      },
    });
  };
  return { ctx, baseUrl, requests, notifications, registeredProviders, emit, compact, started, authCalls: () => authCalls };
}

function persist(h, compaction) {
  h.ctx.sessionManager.appendCompaction(
    compaction.summary, compaction.firstKeptEntryId, compaction.tokensBefore,
    compaction.details, true, compaction.usage,
  );
  h.emit("session_compact");
}

function ordinaryPayload() {
  return {
    model: "gpt-6-luna", store: false, previous_response_id: "stale_response",
    input: [
      { type: "message", role: "system", content: "Updated system instructions." },
      { type: "message", role: "user", content: "A portable summary rather than native history." },
    ],
    tools: [{ type: "function", name: "current_tool", parameters: { type: "object" } }],
    reasoning: { effort: "high", summary: "auto" }, text: { verbosity: "low" },
  };
}

test("Copilot requests use resolved credentials and native replay stays model-scoped", async (t) => {
  const h = await harness(t);
  await h.emit("before_provider_request", { payload: ordinaryPayload() });
  const result = await h.compact();
  assert.ok(result?.compaction?.details?.remoteCompaction, "Copilot should return native compaction details");
  assert.deepEqual(h.registeredProviders, ["openai"], "Copilot should retain its built-in transport and auth");
  const request = h.requests.find((request) => request.isCompaction);
  assert.equal(request.path, "/responses", "Copilot does not use /v1/responses");
  assert.equal(request.headers.authorization, "Bearer synthetic-copilot-token");
  assert.equal(request.headers["editor-version"], h.ctx.model.headers["Editor-Version"]);
  assert.equal(request.headers["x-extra"], "yes");
  assert.equal(request.headers["x-deleted"], undefined);
  assert.equal(request.headers["x-initiator"], "agent");
  assert.equal(request.headers["openai-intent"], "conversation-edits");
  assert.equal(request.headers["copilot-vision-request"], "true");
  assert.equal(request.headers["x-codex-beta-features"], "remote_compaction_v2");
  assert.equal(request.headers["x-codex-installation-id"], undefined);
  assert.deepEqual(request.body.input.at(-1), { type: "compaction_trigger" });
  assert.match(JSON.stringify(request.body.input), /314159/);
  assert.equal(request.body.instructions, "Current system instructions.");
  assert.equal(request.body.tools[0].name, "read");
  assert.equal(request.body.store, false);
  assert.deepEqual(request.body.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(request.body.text, { verbosity: "low" });
  assert.equal(result.compaction.summary, "Portable summary for other providers.");
  persist(h, result.compaction);

  const followUp = { role: "user", content: [{ type: "text", text: "Now use the saved state." }], timestamp: 3 };
  h.ctx.sessionManager.appendMessage(followUp);
  await h.emit("message_end", { message: followUp });
  const payload = ordinaryPayload();
  const replay = await h.emit("before_provider_request", { payload });
  assert.equal(replay.input[0].content, "Updated system instructions.", "Replay must not drop Pi 1.x system messages");
  assert.ok(replay.input.some((item) => item.encrypted_content === "SYNTHETIC_ENCRYPTED_STATE"));
  assert.match(JSON.stringify(replay.input.at(-1)), /Now use the saved state/);
  assert.deepEqual(replay.tools, payload.tools);
  assert.equal(replay.store, false);
  assert.equal(replay.previous_response_id, undefined);
  assert.equal(replay.context_management, undefined, "Copilot does not opt into stored-response continuity");
  assert.equal(payload.previous_response_id, "stale_response", "Request patching must not mutate the caller's payload");

  h.ctx.sessionManager.appendMessage(assistant(h.ctx.model, "Continued from native state."));
  h.ctx.sessionManager = SessionManager.open(h.ctx.sessionManager.getSessionFile());
  await h.emit("session_start");
  const resumed = await h.emit("before_provider_request", { payload: ordinaryPayload() });
  assert.ok(resumed.input.some((item) => item.encrypted_content === "SYNTHETIC_ENCRYPTED_STATE"));
  assert.match(JSON.stringify(resumed.input), /Continued from native state/);

  h.ctx.model = { ...h.ctx.model, id: "gpt-6.1-sol" };
  await h.emit("model_select");
  assert.equal(await h.emit("before_provider_request", { payload: ordinaryPayload() }), undefined,
    "Native state must not leak into another model's request");
});

for (const mode of ["unsupported", "missing-artifact", "empty-artifact"]) {
  test(`Copilot falls back visibly to portable text when remote compaction is ${mode}`, async (t) => {
    const h = await harness(t, mode);
    const result = await h.compact();
    assert.equal(result?.compaction?.summary, "Portable summary for other providers.");
    assert.equal(result.compaction.details?.remoteCompaction, undefined);
    assert.ok(h.notifications.some((notice) => notice.level === "warning" && /falling back/i.test(notice.message)));
    persist(h, result.compaction);
    assert.equal(await h.emit("before_provider_request", { payload: ordinaryPayload() }), undefined);
  });
}

test("a rejected remote request and failed text summarizer do not fabricate a successful checkpoint", async (t) => {
  const h = await harness(t, "both-fail");
  assert.equal(await h.compact(), undefined, "Pi should retain responsibility for default compaction when both paths fail");
  assert.ok(h.notifications.some((notice) => notice.level === "warning"));
});

test("cancelling Copilot compaction does not save a partial or fallback checkpoint", async (t) => {
  const h = await harness(t, "abort");
  const controller = new AbortController();
  const pending = h.compact(controller.signal);
  await h.started;
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(h.notifications.length, 0);
});

test("Pi's real RPC lifecycle persists native Copilot compaction and replays it after a process restart", { timeout: 30000 }, async (t) => {
  const h = await harness(t);
  const agentDir = join(h.ctx.cwd, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    packages: [], compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 0 },
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { "github-copilot": { baseUrl: h.baseUrl, apiKey: "synthetic-copilot-token" } },
  }));
  const options = {
    cliPath: fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url)),
    cwd: h.ctx.cwd, model: "github-copilot/gpt-6-luna",
    env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    args: [
      "--offline", "--no-extensions", "--no-skills", "--no-mcp", "--no-tools", "--no-context-files", "--no-prompt-templates",
      "--extension", fileURLToPath(new URL("..", import.meta.url)),
      "--system-prompt", "Runtime system instructions.", "--session-dir", join(h.ctx.cwd, "runtime-sessions"),
    ],
  };
  let client = new RpcClient(options);
  try {
    await client.start();
    await client.promptAndWait("Remember this synthetic state for a later turn.", undefined, 10000);
    const result = await client.compact();
    assert.ok(result.details?.remoteCompaction, client.getStderr());
    const state = await client.getState();
    const entries = readFileSync(state.sessionFile, "utf8").trim().split("\n").map(JSON.parse);
    const checkpoint = entries.find((entry) => entry.type === "compaction");
    assert.equal(checkpoint.details.remoteCompaction.replacementHistory.at(-1).encrypted_content, "SYNTHETIC_ENCRYPTED_STATE");
    await client.stop();

    client = new RpcClient({ ...options, args: [...options.args, "--session", state.sessionFile] });
    await client.start();
    await client.promptAndWait("Continue after restarting Pi.", undefined, 10000);
    const request = h.requests.at(-1);
    assert.equal(request.path, "/responses");
    assert.equal(request.body.store, false);
    assert.ok(request.body.input.some((item) => item.encrypted_content === "SYNTHETIC_ENCRYPTED_STATE"));
    assert.match(JSON.stringify(request.body.input), /Continue after restarting Pi/);
    assert.match(JSON.stringify(request.body.input.filter((item) => ["system", "developer"].includes(item.role))), /Runtime system instructions/);
    assert.equal(request.body.previous_response_id, undefined);
    assert.doesNotMatch(client.getStderr(), /Failed to load extension|Extension error/);
  } finally {
    await client.stop();
  }
});

test("non-OpenAI Copilot models and Chat Completions models keep Pi's ordinary compaction", async (t) => {
  const h = await harness(t);
  for (const [id, api] of [["claude-sonnet-5.5", "anthropic-messages"], ["gpt-5", "openai-completions"], ["grok-4.7", "openai-responses"]]) {
    h.ctx.model = { ...h.ctx.model, id, api };
    assert.equal(await h.compact(), undefined);
  }
  assert.equal(h.authCalls(), 0);
  assert.equal(h.requests.length, 0);
});
