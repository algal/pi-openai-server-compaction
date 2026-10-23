import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createRequestBudget } from "./live/request-budget.mjs";

test("live budget stops request 21 at the provider boundary across tool loops and reopened sessions", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(process.cwd(), ".request-budget-"));
  const budget = createRequestBudget();
  let transmitted = 0;
  let hookCalls = 0;
  let toolCalls = 0;
  let session;
  const server = createServer((request, response) => {
    request.resume();
    transmitted++;
    const item = { type: "function_call", id: `fc_${transmitted}`, call_id: `call_${transmitted}`,
      name: "probe", arguments: "{}" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${transmitted}`, status: "completed", output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => ({ type: "api_key", key: "offline-test" }));
    const runtime = await ModelRuntime.create({
      credentials,
      modelsPath: null, refreshOnCreate: false,
    });
    runtime.registerProvider("openai", { baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    const model = runtime.getModels("openai").find((model) => model.api === "openai-responses");
    assert.ok(model);
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false }, transport: "sse", cacheWarming: "off",
    });
    async function open(manager) {
      const loader = new DefaultResourceLoader({
        cwd: root, agentDir: root, settingsManager: settings,
        noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        systemPrompt: "Synthetic request budget test.",
        extensionFactories: [(pi) => {
          pi.registerTool({
            name: "probe", label: "probe", description: "Synthetic probe",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            async execute() {
              toolCalls++;
              return { content: [{ type: "text", text: "42" }], details: undefined };
            },
          });
          pi.on("before_provider_request", () => {
            hookCalls++;
            throw new Error("Synthetic swallowed hook failure");
          });
        }],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session } = await createAgentSession({
        cwd: root, agentDir: root, modelRuntime: runtime, model,
        resourceLoader: loader, settingsManager: settings, sessionManager: manager, tools: ["probe"],
      }));
      session.agent.onPayload = budget.wrap(session.agent.onPayload);
      await session.bindExtensions({});
    }
    await open(SessionManager.create(root, join(root, "sessions")));
    await session.prompt("Keep using the probe.");
    assert.equal(transmitted, 20);
    assert.equal(hookCalls, 20);
    assert.equal(toolCalls, 20);
    assert.equal(budget.requests, 20);
    assert.equal(session.messages.at(-1).stopReason, "error");
    assert.match(session.messages.at(-1).errorMessage, /Live request budget exceeded/);
    const file = session.sessionFile;
    session.dispose();
    await open(SessionManager.open(file));
    await session.prompt("Try again after reopening.");
    assert.match(session.messages.at(-1).errorMessage, /Live request budget exceeded/);
    assert.equal(transmitted, 20);
    assert.equal(hookCalls, 20);
    assert.equal(budget.requests, 20);
  } finally {
    session?.dispose();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
