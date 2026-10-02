import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localNodeModules = join(repoRoot, "node_modules");

function packagePathSegments(packageName) {
  return packageName.split("/");
}

function npmGlobalRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function candidateRoots() {
  const roots = new Set();
  roots.add(localNodeModules);

  const globalRoot = npmGlobalRoot();
  if (globalRoot) roots.add(globalRoot);

  const voltaPiRoot = join(
    homedir(),
    ".volta",
    "tools",
    "image",
    "packages",
    "@earendil-works",
    "pi-coding-agent",
    "lib",
    "node_modules",
  );
  roots.add(voltaPiRoot);
  roots.add(join(voltaPiRoot, "@earendil-works", "pi-coding-agent", "node_modules"));

  return [...roots];
}

function resolveInstalledPackageDir(packageName) {
  const segments = packagePathSegments(packageName);
  for (const root of candidateRoots()) {
    const dir = join(root, ...segments);
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      return dir;
    }
  }
  return undefined;
}

function ensureLocalPeerLink(packageName) {
  const localDir = join(localNodeModules, ...packagePathSegments(packageName));
  if (existsSync(join(localDir, "package.json"))) {
    return;
  }

  const targetDir = resolveInstalledPackageDir(packageName);
  if (!targetDir) {
    throw new Error(
      `Unable to locate peer dependency ${packageName}. Install Pi or add the package locally before running smoke.`,
    );
  }

  mkdirSync(dirname(localDir), { recursive: true });
  if (existsSync(localDir)) {
    const stat = lstatSync(localDir);
    if (stat.isSymbolicLink() || stat.isDirectory()) {
      rmSync(localDir, { recursive: true, force: true });
    }
  }
  symlinkSync(targetDir, localDir, "dir");
}

for (const packageName of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
]) {
  ensureLocalPeerLink(packageName);
}

const { default: extensionFactory } = await import(pathToFileURL(join(repoRoot, "src", "index.ts")).href);
assert.equal(typeof extensionFactory, "function", "extension entrypoint should export a function");

const {
  buildCodexWebSocketHeaders,
  buildCompactionResultWithRemoteDetails,
  buildRemoteCompactionHeaders,
  buildRemoteCompactionDetails,
  buildRemoteCompactionRequestBody,
  buildRemoteCompactionV2History,
  combineCompactionUsage,
  extractRemoteCompactionDetails,
  messageToResponseItems,
  normalizeResponseItemsForPrompt,
  parseRemoteCompactionV2Events,
  processCompactedHistory,
  reconstructRemoteCompactionStateFromBranch,
  remoteCompactionV2EndpointUrl,
} = await import(pathToFileURL(join(repoRoot, "src", "remote-compaction.ts")).href);
const {
  selectInputItemsForContinuation,
  buildResponseCreatePayload,
  convertTools,
} = await import(pathToFileURL(join(repoRoot, "src", "openai-ws-stream.ts")).href);
const { normalizeContext, getCurrentTools } = await import("@earendil-works/pi-ai");
const transcriptContext = normalizeContext({
  systemPrompt: "SYSTEM_INSTRUCTIONS",
  tools: [{ name: "read", description: "Read files", parameters: { type: "object", properties: {} } }],
  messages: [{ role: "user", content: "Hello", timestamp: 0 }],
});
transcriptContext.messages.push({ role: "system", content: "UPDATED_INSTRUCTIONS" });
const transcriptPayload = buildResponseCreatePayload({
  model: { id: "gpt-5.4-nano", reasoning: false },
  context: transcriptContext,
  inputItems: [],
  tools: convertTools(getCurrentTools(transcriptContext.messages)),
  options: undefined,
});
assert.match(transcriptPayload.instructions, /SYSTEM_INSTRUCTIONS/);
assert.match(transcriptPayload.instructions, /UPDATED_INSTRUCTIONS/);
assert.equal(transcriptPayload.tools[0].name, "read");

const deletedHeaders = buildRemoteCompactionHeaders({
  model: { provider: "openai", api: "openai-responses" },
  apiKey: "test-key",
  headers: { Authorization: null, "X-Test": "present" },
});
assert.ok(!Object.keys(deletedHeaders).some((key) => key.toLowerCase() === "authorization"));
assert.equal(deletedHeaders["X-Test"], "present");

const targetModelKey = "openai:openai-responses:gpt-5.4-nano";
const reconstructed = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    {
      type: "compaction",
      id: "cmp-1",
      details: {
        remoteCompaction: {
          version: 1,
          provider: "openai-responses-compact",
          modelKey: targetModelKey,
          replacementHistory: [
            {
              type: "compaction",
              encrypted_content: "ENCRYPTED",
            },
          ],
        },
      },
    },
    {
      type: "message",
      id: "user-a1",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_ONE" }],
      },
    },
    {
      type: "message",
      id: "assistant-a1",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_ONE" }],
      },
    },
    {
      type: "message",
      id: "user-b1",
      message: {
        role: "user",
        content: [{ type: "text", text: "DROP_ME" }],
      },
    },
    {
      type: "message",
      id: "assistant-b1",
      message: {
        role: "assistant",
        provider: "anthropic",
        api: "anthropic-messages",
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "DROP_REPLY" }],
      },
    },
    {
      type: "message",
      id: "user-a2",
      message: {
        role: "user",
        content: [{ type: "text", text: "KEEP_ME_TWO" }],
      },
    },
    {
      type: "message",
      id: "assistant-a2",
      message: {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4-nano",
        content: [{ type: "text", text: "KEEP_REPLY_TWO" }],
      },
    },
  ],
});
assert.ok(reconstructed, "expected reconstructed remote compaction state");
const reconstructedJson = JSON.stringify(reconstructed.explicitHistory);
assert.match(reconstructedJson, /KEEP_ME_ONE/);
assert.match(reconstructedJson, /KEEP_REPLY_ONE/);
assert.match(reconstructedJson, /KEEP_ME_TWO/);
assert.match(reconstructedJson, /KEEP_REPLY_TWO/);
assert.doesNotMatch(reconstructedJson, /DROP_ME/);
assert.doesNotMatch(reconstructedJson, /DROP_REPLY/);

// Pi context messages must survive replacement-history conversion.
for (const [message, marker] of [
  [{ role: "custom", customType: "note", content: "CUSTOM_NOTE_TEXT", display: false, timestamp: 0 }, /CUSTOM_NOTE_TEXT/],
  [{ role: "bashExecution", command: "echo hi", output: "BASH_OUTPUT_TEXT", exitCode: 0, cancelled: false, truncated: false, timestamp: 0 }, /BASH_OUTPUT_TEXT/],
  [{ role: "branchSummary", summary: "BRANCH_SUMMARY_TEXT", fromId: "x", timestamp: 0 }, /BRANCH_SUMMARY_TEXT/],
  [{ role: "compactionSummary", summary: "COMPACTION_SUMMARY_TEXT", tokensBefore: 1, timestamp: 0 }, /COMPACTION_SUMMARY_TEXT/],
]) {
  const items = messageToResponseItems(message);
  assert.ok(items.length > 0, `${message.role} message must not convert to zero response items`);
  assert.equal(items[0].type, "message");
  assert.equal(items[0].role, "user");
  assert.match(JSON.stringify(items), marker);
}
assert.deepEqual(messageToResponseItems({
  role: "bashExecution", command: "echo secret", output: "EXCLUDED_TEXT",
  exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 0,
}), []);

const trailingState = reconstructRemoteCompactionStateFromBranch({
  branchEntries: [
    {
      type: "compaction", id: "cmp-2",
      details: { remoteCompaction: {
        version: 2, provider: "openai-responses-compaction",
        implementation: "responses_compaction_v2", modelKey: targetModelKey,
        replacementHistory: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
      } },
    },
    { type: "custom_message", id: "custom-1", customType: "supervision", content: "INJECTED_EXTENSION_NOTE", display: false },
    { type: "branch_summary", id: "branch-1", fromId: "branch-0", summary: "PERSISTED_BRANCH_SUMMARY" },
    { type: "message", id: "user-trailing", message: { role: "user", content: [{ type: "text", text: "UNANSWERED_USER_TURN" }] } },
  ],
});
assert.ok(trailingState);
const trailingJson = JSON.stringify(trailingState.explicitHistory);
assert.match(trailingJson, /INJECTED_EXTENSION_NOTE/);
assert.match(trailingJson, /PERSISTED_BRANCH_SUMMARY/);
assert.match(trailingJson, /UNANSWERED_USER_TURN/);

const requestBody = buildRemoteCompactionRequestBody({
  model: {
    id: "gpt-5.4-nano",
  },
  input: [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
  instructions: "system",
  tools: [{ type: "function", name: "read" }],
  parallelToolCalls: true,
  reasoning: { effort: "high", summary: "auto" },
  text: { verbosity: "medium" },
});
assert.equal(requestBody.model, "gpt-5.4-nano");
assert.equal(requestBody.stream, true);
assert.equal(requestBody.store, false);
assert.equal(requestBody.tool_choice, "auto");
assert.deepEqual(requestBody.include, ["reasoning.encrypted_content"]);
assert.deepEqual(requestBody.input.at(-1), { type: "compaction_trigger" });
assert.deepEqual(requestBody.reasoning, { effort: "high", summary: "auto" });
assert.deepEqual(requestBody.text, { verbosity: "medium" });
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  }),
  "https://api.openai.com/v1/responses",
);
assert.equal(
  remoteCompactionV2EndpointUrl({
    provider: "openai-codex",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  }),
  "https://chatgpt.com/backend-api/codex/responses",
);

const parsedV2Events = parseRemoteCompactionV2Events([
  {
    type: "response.output_item.done",
    item: { type: "compaction", encrypted_content: "V2_ENCRYPTED" },
  },
  {
    type: "response.completed",
    response: { usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
  },
]);
assert.equal(parsedV2Events.compactionItem.type, "compaction");
const v2History = buildRemoteCompactionV2History(
  [
    { type: "message", role: "user", content: [{ type: "input_text", text: "retain user" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "summarize assistant" }] },
  ],
  parsedV2Events.compactionItem,
);
assert.deepEqual(v2History.map((item) => item.type), ["message", "compaction"]);
assert.equal(v2History[0].role, "user");

const normalizedPromptItems = normalizeResponseItemsForPrompt(
  [
    { type: "ghost_snapshot", data: "hidden" },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
    },
    { type: "function_call", name: "read", call_id: "call-1", arguments: "{}" },
    { type: "function_call_output", call_id: "orphan", output: "drop" },
    { type: "image_generation_call", result: "base64" },
  ],
  { input: ["text"] },
);
assert.equal(normalizedPromptItems[0].type, "message");
assert.deepEqual(normalizedPromptItems[0].content, [
  { type: "input_text", text: "image content omitted because you do not support image input" },
]);
assert.deepEqual(normalizedPromptItems[2], {
  type: "function_call_output",
  call_id: "call-1",
  output: "aborted",
});
assert.equal(normalizedPromptItems[3].result, "");
assert.doesNotMatch(JSON.stringify(normalizedPromptItems), /orphan|ghost_snapshot/);

const compactedHistory = processCompactedHistory([
  { type: "message", role: "developer", content: [{ type: "input_text", text: "drop developer" }] },
  { type: "message", role: "user", content: [] },
  { type: "message", role: "user", content: [{ type: "input_text", text: "keep user" }] },
  { type: "message", role: "assistant", content: [{ type: "output_text", text: "keep assistant" }] },
  { type: "function_call", name: "read", call_id: "call-2", arguments: "{}" },
  { type: "compaction", encrypted_content: "keep" },
]);
assert.deepEqual(compactedHistory.map((item) => item.type), ["message", "message", "compaction"]);
assert.equal(compactedHistory[0].role, "user");
assert.equal(compactedHistory[1].role, "assistant");

const compactionHeaders = buildRemoteCompactionHeaders({
  model: {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  apiKey: "sk-test",
  sessionId: "session-123",
  headers: { "x-extra": "yes" },
});
assert.equal(compactionHeaders.authorization, "Bearer sk-test");
assert.equal(compactionHeaders.session_id, "session-123");
assert.equal(compactionHeaders["x-codex-window-id"], "session-123:0");
assert.match(compactionHeaders["x-codex-installation-id"], /^[0-9a-f-]{36}$/);
assert.equal(compactionHeaders["x-extra"], "yes");
assert.equal(compactionHeaders["x-codex-beta-features"], "remote_compaction_v2");
assert.equal(compactionHeaders.accept, "text/event-stream");

const websocketHeaders = buildCodexWebSocketHeaders("session-123");
assert.equal(websocketHeaders["x-client-request-id"], "session-123");
assert.equal(websocketHeaders.session_id, "session-123");
assert.equal(websocketHeaders["x-codex-window-id"], "session-123:0");

const detailsRoundTrip = extractRemoteCompactionDetails({
  remoteCompaction: buildRemoteCompactionDetails(
    {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5.4-nano",
    },
    [{ type: "compaction", encrypted_content: "ENCRYPTED" }],
    {
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrite: 40,
      totalTokens: 100,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
    },
  ),
});
assert.ok(detailsRoundTrip, "expected remote compaction details round trip");
assert.equal(detailsRoundTrip.usage?.cacheWrite, 40);
assert.equal(detailsRoundTrip.usage?.cost.total, 10);

const localCompactionUsage = {
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  cacheWrite1h: 1,
  reasoning: 2,
  totalTokens: 10,
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
};
const remoteCompactionUsage = {
  input: 10,
  output: 20,
  cacheRead: 30,
  cacheWrite: 40,
  reasoning: 5,
  totalTokens: 100,
  cost: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 },
};
const combinedCompactionUsage = {
  input: 11,
  output: 22,
  cacheRead: 33,
  cacheWrite: 44,
  cacheWrite1h: 1,
  reasoning: 7,
  totalTokens: 110,
  cost: { input: 11, output: 22, cacheRead: 33, cacheWrite: 44, total: 110 },
};
assert.deepEqual(combineCompactionUsage(localCompactionUsage, remoteCompactionUsage), combinedCompactionUsage);
assert.deepEqual(combineCompactionUsage(localCompactionUsage, undefined), localCompactionUsage);
assert.deepEqual(combineCompactionUsage(undefined, remoteCompactionUsage), remoteCompactionUsage);
assert.equal(combineCompactionUsage(undefined, undefined), undefined);

const remoteCompactionHistory = [{ type: "compaction", encrypted_content: "RESULT_ENCRYPTED" }];
const remoteDetailsWithUsage = buildRemoteCompactionDetails(
  {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  remoteCompactionHistory,
  remoteCompactionUsage,
);
const remoteDetailsWithoutUsage = buildRemoteCompactionDetails(
  {
    provider: "openai",
    api: "openai-responses",
    id: "gpt-5.4-nano",
  },
  remoteCompactionHistory,
);
const localCompactionSummary = {
  summary: "local summary",
  firstKeptEntryId: "entry-1",
  tokensBefore: 123,
};

const bothUsageCompaction = buildCompactionResultWithRemoteDetails({
  localSummary: { ...localCompactionSummary, usage: localCompactionUsage },
  remoteDetails: remoteDetailsWithUsage,
  remoteUsage: remoteCompactionUsage,
});
assert.deepEqual(bothUsageCompaction.usage, combinedCompactionUsage);
assert.deepEqual(bothUsageCompaction.details.remoteCompaction, remoteDetailsWithUsage);

const localOnlyCompaction = buildCompactionResultWithRemoteDetails({
  localSummary: { ...localCompactionSummary, usage: localCompactionUsage },
  remoteDetails: remoteDetailsWithoutUsage,
});
assert.deepEqual(localOnlyCompaction.usage, localCompactionUsage);
assert.deepEqual(localOnlyCompaction.details.remoteCompaction, remoteDetailsWithoutUsage);

const remoteOnlyCompaction = buildCompactionResultWithRemoteDetails({
  localSummary: localCompactionSummary,
  remoteDetails: remoteDetailsWithUsage,
  remoteUsage: remoteCompactionUsage,
});
assert.deepEqual(remoteOnlyCompaction.usage, remoteCompactionUsage);
assert.deepEqual(remoteOnlyCompaction.details.remoteCompaction, remoteDetailsWithUsage);

const neitherUsageCompaction = buildCompactionResultWithRemoteDetails({
  localSummary: localCompactionSummary,
  remoteDetails: remoteDetailsWithoutUsage,
});
assert.equal(Object.hasOwn(neitherUsageCompaction, "usage"), false);
assert.deepEqual(neitherUsageCompaction.details.remoteCompaction, remoteDetailsWithoutUsage);

const incrementalInput = selectInputItemsForContinuation({
  context: {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "old user" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old assistant" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "new user" }],
      },
    ],
  },
  model: { input: ["text"] },
  session: { lastContextLength: 2 },
  currentModelKey: targetModelKey,
  remoteCompactionState: undefined,
  previousResponseId: "resp_123",
});
assert.deepEqual(incrementalInput, [
  {
    type: "message",
    role: "user",
    content: "new user",
  },
]);

console.log("smoke ok");
