import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../../src/index.ts";
import { createRequestBudget } from "./request-budget.mjs";

// Synthetic, bounded live acceptance. No user session, project context, global
// extensions, or shell tools are loaded. Keep the temporary evidence on failure.
const root = await mkdtemp(join(tmpdir(), "pi-compaction-tools-"));
console.log(`Acceptance evidence: ${root}`);
const modelName = process.env.PI_OPENAI_SERVER_COMPACTION_TEST_MODEL ?? "openai-codex/gpt-6.1-sol";
const slash = modelName.indexOf("/");
const runtime = await ModelRuntime.create();
const model = runtime.getModel(modelName.slice(0, slash), modelName.slice(slash + 1));
assert.ok(model, `Model unavailable: ${modelName}`);
const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0 }, retry: { enabled: false } });
const calls = [];
const budget = createRequestBudget();
let activePi;
let session;
const timeout = setTimeout(() => { void session?.abort(); }, 300000);

function probe(name, grammar = false) {
  return {
    name, label: name, description: "Return a fresh acceptance receipt. Call once with token test.",
    parameters: { type: "object", properties: { token: { type: "string" } }, required: ["token"], additionalProperties: false },
    ...(grammar ? { constrainedSampling: { type: "grammar", variants: { openai_lark: 'start: "test"' } } } : {}),
    async execute(_id, input) {
      assert.equal(input.token, "test");
      const receipt = randomUUID();
      calls.push({ name, receipt });
      return { content: [{ type: "text", text: receipt }], details: undefined };
    },
  };
}

async function open(manager) {
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    systemPrompt: "You are a synthetic tool-availability acceptance assistant. Call exactly the requested tool once with token test. Return only its receipt.",
    extensionFactories: [extensionFactory, (pi) => {
      activePi = pi;
      pi.registerTool(probe("probe_json"));
      pi.registerTool(probe("probe_code", true));
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model,
    thinkingLevel: "high", resourceLoader: loader, settingsManager: settings, sessionManager: manager,
    tools: ["probe_json", "probe_code", "probe_late"],
  }));
  session.agent.onPayload = budget.wrap(session.agent.onPayload);
  await session.bindExtensions({});
}

async function invoke(name) {
  const before = calls.length;
  await session.prompt(`Call ${name} once with token test now, then return its receipt.`);
  assert.equal(calls.length, before + 1, `${name} must execute exactly once`);
  assert.equal(calls.at(-1).name, name);
  assert.equal(session.getLastAssistantText()?.trim(), calls.at(-1).receipt);
  console.log(`PASS ${name}: tool executed and receipt returned`);
}

async function compact() {
  const result = await session.compact();
  assert.equal(result.details?.remoteCompaction?.implementation, "responses_compaction_v2", "A portable-only fallback is not native compaction acceptance");
  console.log("PASS native compaction");
}

try {
  // Only the temporary test project enables the extension.
  await mkdir(join(root, ".pi"));
  await writeFile(join(root, ".pi", "openai-server-compaction.json"), '{"enabled":true}\n');
  await open(SessionManager.create(root, join(root, "sessions")));
  await invoke("probe_json");
  await compact();
  await invoke("probe_code");
  activePi.registerTool(probe("probe_late"));
  await invoke("probe_late");
  await compact();
  const file = session.sessionFile;
  session.dispose();
  await open(SessionManager.open(file));
  await invoke("probe_code");
  const entries = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(entries.filter((entry) => entry.type === "compaction").length, 2);
  console.log(JSON.stringify({ status: "PASS", model: modelName, compactions: 2, toolCalls: calls.length, requests: budget.requests, evidence: root }));
} finally {
  clearTimeout(timeout);
  session?.dispose();
}
