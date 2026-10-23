import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WebSocketServer } from "ws";
import extensionFactory from "../src/index.ts";
import { createOpenAIWebSocketStreamFn, releaseAllWsSessions } from "../src/openai-ws-stream.ts";
import { clearAllContinuationState } from "../src/state.ts";

for (const route of ["codex-http", "direct-http", "direct-websocket"]) {
  // [itest->req~remote-history.persisted-context~1]
  test(`${route}: idle custom context survives compaction, further requests, and reopening`, { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(process.cwd(), ".context-preservation-"));
    const requests = [];
    let compactions = 0;
    let session;
    const originalFetch = globalThis.fetch;
    function respond(body) {
      requests.push(body);
      const compacting = body.input?.some((item) => item.type === "compaction_trigger");
      const output = compacting
        ? [{ type: "compaction", encrypted_content: `SYNTHETIC_CHECKPOINT_${++compactions}` }]
        : [{ type: "message", id: `msg_${requests.length}`, role: "assistant", phase: "final_answer",
          content: [{ type: "output_text", text: "Synthetic receipt.", annotations: [] }] }];
      return [
        ...output.filter((item) => item.type === "message").flatMap((item) => [
          { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Synthetic receipt." },
        ]),
        { type: "response.output_item.done", output_index: 0, item: output[0] },
        { type: "response.completed", response: { id: `resp_${requests.length}`, status: "completed", output,
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
      ];
    }
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let raw = Buffer.concat(chunks);
      if (request.headers["content-encoding"] === "zstd") raw = zstdDecompressSync(raw);
      const events = respond(JSON.parse(raw.toString()));
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => socket.on("message", (data) => {
      for (const event of respond(JSON.parse(data.toString()))) socket.send(JSON.stringify(event));
    }));
    // Keep production model host checks, redirecting only at the network boundary.
    globalThis.fetch = (input, init) => {
      const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      assert.ok(["api.openai.com", "chatgpt.com"].includes(target.hostname), "Unexpected external request");
      return originalFetch(`${url}${target.pathname}`, init);
    };
    try {
      const provider = route === "codex-http" ? "openai-codex" : "openai";
      const credentials = new InMemoryCredentialStore();
      const token = `e30.${Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "synthetic" },
      })).toString("base64url")}.fake`;
      await credentials.modify(provider, async () => provider === "openai-codex"
        ? { type: "oauth", access: token, refresh: "synthetic", expires: Date.now() + 3600000 }
        : { type: "api_key", key: "offline-test" });
      const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
      runtime.registerProvider(provider, { models: [{
        id: "synthetic-model", name: "Synthetic model",
        api: provider === "openai" ? "openai-responses" : "openai-codex-responses",
        baseUrl: provider === "openai" ? "https://api.openai.com/v1" : "https://chatgpt.com/backend-api",
        reasoning: false, input: ["text"], contextWindow: 500000, maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }] });
      const model = runtime.getModel(provider, "synthetic-model");
      const settings = SettingsManager.inMemory({
        compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false },
        transport: route === "direct-websocket" ? "websocket" : "sse", cacheWarming: "off",
      });
      async function open(manager) {
        const loader = new DefaultResourceLoader({
          cwd: root, agentDir: root, settingsManager: settings,
          noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          systemPrompt: "Synthetic context preservation test.",
          extensionFactories: [extensionFactory, (pi) => {
            if (route === "direct-websocket") pi.registerProvider("openai", {
              api: "openai-responses",
              streamSimple: createOpenAIWebSocketStreamFn({ url: url.replace("http:", "ws:"), maxRetries: 0 }),
            });
          }],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        ({ session } = await createAgentSession({
          cwd: root, agentDir: root, modelRuntime: runtime, model, resourceLoader: loader,
          settingsManager: settings, sessionManager: manager, tools: [],
        }));
        await session.bindExtensions({});
      }
      async function compact() {
        const result = await session.compact();
        assert.equal(result.details?.remoteCompaction?.implementation, "responses_compaction_v2");
      }
      function assertContext(body, text) {
        const texts = body.input.flatMap((item) => Array.isArray(item.content)
          ? item.content.filter((part) => part.type === "input_text").map((part) => part.text) : []);
        assert.equal(texts.filter((value) => value === text).length, 1,
          `Persisted context must reach ${route} exactly once`);
        assert.ok(body.input.some((item) => item.type === "compaction"));
        assert.equal(body.previous_response_id, undefined);
      }
      await open(SessionManager.create(root, join(root, "sessions")));
      await session.prompt("Start the synthetic session.");
      assert.equal(session.getLastAssistantText(), "Synthetic receipt.");
      await compact();
      await session.sendCustomMessage({ customType: "note", content: "CONTEXT_AFTER_COMPACTION", display: false });
      assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "custom_message"));
      await session.prompt("Use the new context.");
      assert.equal(session.getLastAssistantText(), "Synthetic receipt.");
      assertContext(requests.at(-1), "CONTEXT_AFTER_COMPACTION");
      await session.prompt("Keep the same context.");
      assertContext(requests.at(-1), "CONTEXT_AFTER_COMPACTION");
      await session.sendCustomMessage({ customType: "note", content: "CONTEXT_BEFORE_RECOMPACTION", display: false });
      await compact();
      assertContext(requests.findLast((body) => body.input?.some((item) => item.type === "compaction_trigger")),
        "CONTEXT_BEFORE_RECOMPACTION");
      const file = session.sessionFile;
      session.dispose();
      releaseAllWsSessions();
      clearAllContinuationState();
      await open(SessionManager.open(file));
      await session.sendCustomMessage({ customType: "note", content: "CONTEXT_AFTER_REOPEN", display: false });
      await session.prompt("Use the context added after reopening.");
      assertContext(requests.at(-1), "CONTEXT_AFTER_REOPEN");
    } finally {
      globalThis.fetch = originalFetch;
      session?.dispose();
      releaseAllWsSessions();
      clearAllContinuationState();
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  });
}
