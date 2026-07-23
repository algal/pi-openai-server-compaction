import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chooseSafeCutIndex } from "../src/grok/core.mjs";
import { createGateway, resolveUpstreamUrl } from "../src/grok/server.mjs";

const identityHeaders = {
  "content-type": "application/json",
  "x-grok-session-id": "session-a",
  "x-grok-conv-id": "conversation-a",
  "x-grok-agent-id": "agent-a",
  "x-grok-req-id": "request-a",
};

function message(role, text) {
  return { type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] };
}

function completedSse(id = "resp_test") {
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress", output: [] } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "reasoning", id: "rs_test", summary: [] } })}\n\n`,
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "visible-ok" })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_full", status: "completed", role: "assistant", content: [{ type: "output_text", text: "visible-ok", annotations: [] }] } })}\n\n`,
    `event: response.metadata\ndata: ${JSON.stringify({ type: "response.metadata", metadata: { internal: true } })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [] } })}\n\n`,
    "data: [DONE]\n\n",
    `event: response.metadata\ndata: ${JSON.stringify({ type: "response.metadata", metadata: { trailing: true } })}`,
  ].join("");
}

async function makeUpstream({ failCompaction = false, incompleteMain = false } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
    requests.push({ path: req.url, body, headers: req.headers });
    const isCompaction = Array.isArray(body?.input) && body.input.at(-1)?.type === "compaction_trigger";
    if (isCompaction) {
      if (failCompaction) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "intentional compaction failure" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "resp_compact", output: [{ type: "compaction", id: "cmp_1", encrypted_content: "opaque-only" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (incompleteMain) {
      res.end(`event: response.incomplete\ndata: ${JSON.stringify({ type: "response.incomplete", response: { id: "resp_incomplete", status: "incomplete" } })}\n\n`);
      return;
    }
    res.end(completedSse());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function post(url, body, headers = identityHeaders) {
  const response = await fetch(`${url}/v1/responses`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, text: await response.text() };
}

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-test-"));
  const upstream = await makeUpstream(options.upstream);
  const gateway = createGateway({
    host: "127.0.0.1",
    port: 0,
    upstream: upstream.url,
    stateFile: path.join(dir, "state.json"),
    thresholdTokens: options.thresholdTokens ?? 45,
    keepTokens: options.keepTokens ?? 12,
    helperModel: "gpt-5.6-luna",
    logger: () => {},
  });
  await gateway.start();
  return {
    dir,
    upstream,
    gateway,
    stateFile: path.join(dir, "state.json"),
    close: async () => {
      await gateway.close();
      await upstream.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("preserves upstream path prefixes without duplicating v1", () => {
  assert.equal(
    resolveUpstreamUrl("https://example.test/custom/v1", "/v1/responses?trace=1").toString(),
    "https://example.test/custom/v1/responses?trace=1",
  );
  assert.equal(
    resolveUpstreamUrl("http://127.0.0.1:10531", "/v1/responses").toString(),
    "http://127.0.0.1:10531/v1/responses",
  );
});

test("keeps a function call and its output on the same side of a cut", () => {
  const items = [
    message("system", "old".repeat(60)),
    { type: "function_call", id: "fc_1", call_id: "call_1", name: "bash", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "ok" },
    message("user", "current"),
  ];
  const cut = chooseSafeCutIndex(items, 4, 5, 0);
  assert.ok(cut <= 1 || cut >= 3, `unsafe cut ${cut}`);
});

test("filters Codex-only metadata and restores terminal output items", async (t) => {
  const fx = await fixture({ thresholdTokens: 10_000 });
  t.after(fx.close);
  const result = await post(fx.gateway.url, { model: "gpt-5.6-luna", input: [message("user", "main")], stream: true });
  assert.equal(fx.upstream.requests[0].headers["accept-encoding"], "identity");
  assert.ok(!result.text.includes("response.metadata"));
  const completedBlock = result.text.split(/\r?\n\r?\n/).find((block) => block.includes("response.completed"));
  const dataLine = completedBlock.split(/\r?\n/).find((line) => line.startsWith("data:"));
  const event = JSON.parse(dataLine.slice(5).trim());
  const visible = event.response.output.find((item) => item.type === "message");
  assert.equal(visible.content[0].text, "visible-ok");
});

test("rewrites stateless Grok helper aliases but not session model requests", async (t) => {
  const fx = await fixture({ thresholdTokens: 10_000 });
  t.after(fx.close);
  const helperHeaders = { "content-type": "application/json" };
  await post(fx.gateway.url, { model: "grok-4.5", input: [message("user", "title")], stream: true }, helperHeaders);
  await post(fx.gateway.url, { model: "gpt-5.6-sol", input: [message("user", "main")], stream: true });
  assert.equal(fx.upstream.requests[0].body.model, "gpt-5.6-luna");
  assert.equal(fx.upstream.requests[1].body.model, "gpt-5.6-sol");
});

test("compacts an old prefix, persists only opaque state, and replays it after restart", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "grok-gateway-restart-"));
  const upstream = await makeUpstream();
  const stateFile = path.join(dir, "state.json");
  const options = { host: "127.0.0.1", port: 0, upstream: upstream.url, stateFile, thresholdTokens: 45, keepTokens: 12, helperModel: "gpt-5.6-luna", logger: () => {} };
  let gateway = createGateway(options);
  t.after(async () => {
    await gateway.close();
    await upstream.close();
    await rm(dir, { recursive: true, force: true });
  });
  await gateway.start();
  const firstInput = [
    message("system", "SYSTEM-SECRET-7319 ".repeat(12)),
    message("user", "old question ".repeat(12)),
    message("assistant", "old answer ".repeat(12)),
    message("user", "current question"),
  ];
  const first = await post(gateway.url, { model: "gpt-5.6-luna", input: firstInput, stream: true });
  assert.equal(first.status, 200);
  assert.equal(upstream.requests.length, 2);
  assert.equal(upstream.requests[0].body.input.at(-1).type, "compaction_trigger");
  assert.ok(!upstream.requests[0].body.input.some((item) => item.role === "system"));
  assert.ok(upstream.requests[0].body.instructions.includes("SYSTEM-SECRET-7319"));
  assert.equal(upstream.requests[1].body.input[0].type, "compaction");
  const disk = await readFile(stateFile, "utf8");
  assert.ok(disk.includes("opaque-only"));
  assert.ok(!disk.includes("SYSTEM-SECRET-7319"));

  await gateway.close();
  gateway = createGateway(options);
  await gateway.start();
  const secondInput = [...firstInput, message("assistant", "current answer"), message("user", "next question")];
  const before = upstream.requests.length;
  await post(gateway.url, { model: "gpt-5.6-luna", input: secondInput, stream: true, temperature: 0.3, top_p: 0.9 });
  const forwarded = upstream.requests.slice(before).at(-1).body;
  assert.equal(forwarded.input[0].type, "compaction");
  assert.ok(!JSON.stringify(forwarded.input).includes("SYSTEM-SECRET-7319"));
  assert.equal(forwarded.temperature, undefined);
  assert.equal(forwarded.top_p, undefined);

});

test("a prefix mismatch fails open with the original input", async (t) => {
  const fx = await fixture();
  t.after(fx.close);
  const original = [message("system", "old ".repeat(80)), message("user", "current")];
  await post(fx.gateway.url, { model: "gpt-5.6-luna", input: original, stream: true });
  const divergent = [message("system", "different"), message("user", "branch")];
  const before = fx.upstream.requests.length;
  await post(fx.gateway.url, { model: "gpt-5.6-luna", input: divergent, stream: true });
  const forwarded = fx.upstream.requests.slice(before).at(-1).body;
  assert.deepEqual(forwarded.input, [divergent[1]]);
  assert.equal(forwarded.instructions, "different");
  assert.ok(!forwarded.input.some((item) => item.type === "compaction"));
});

test("a failed compaction forwards the untouched request and writes no state", async (t) => {
  const fx = await fixture({ upstream: { failCompaction: true } });
  t.after(fx.close);
  const input = [message("system", "old ".repeat(80)), message("user", "current")];
  const result = await post(fx.gateway.url, { model: "gpt-5.6-luna", input, stream: true });
  assert.equal(result.status, 200);
  const forwarded = fx.upstream.requests.at(-1).body;
  assert.deepEqual(forwarded.input, [input[1]]);
  assert.ok(forwarded.instructions.includes("old old"));
  assert.ok(!forwarded.input.some((item) => item.type === "compaction"));
  await assert.rejects(readFile(fx.stateFile, "utf8"), { code: "ENOENT" });
});

test("an incomplete main response never commits provisional compaction state", async (t) => {
  const fx = await fixture({ upstream: { incompleteMain: true } });
  t.after(fx.close);
  const input = [message("system", "old ".repeat(80)), message("user", "current")];
  await post(fx.gateway.url, { model: "gpt-5.6-luna", input, stream: true });
  await assert.rejects(readFile(fx.stateFile, "utf8"), { code: "ENOENT" });
});
