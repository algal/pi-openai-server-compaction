#!/usr/bin/env node
/**
 * Live black-box Pi RPC regression test for this extension.
 *
 * This file is not part of the runtime extension. It exists to validate the
 * integration end-to-end against a real `pi` CLI session and the real OpenAI
 * API. It intentionally lives under tests/live so readers do not mistake it for
 * product code.
 *
 * Requirements:
 * - local `pi` CLI on PATH
 * - whichever auth/config is needed for the selected Pi model must already work
 * - network access to the chosen provider backend
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;
type RpcResponse = JsonObject & {
  type?: unknown;
  id?: unknown;
  success?: unknown;
  command?: unknown;
  data?: unknown;
  error?: unknown;
};
type PendingRequest = {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};
type ModelInfo = JsonObject & {
  provider?: unknown;
  api?: unknown;
  id?: unknown;
};

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = join(repoRoot, "src", "index.ts");
const primaryModel = process.env.PI_OPENAI_SERVER_COMPACTION_TEST_MODEL ?? "openai/gpt-5.4-nano";
const primaryModelProvider = primaryModel.includes("/") ? primaryModel.split("/")[0] ?? "openai" : "openai";
const primaryModelId = primaryModel.includes("/") ? primaryModel.split("/").at(-1) ?? primaryModel : primaryModel;
const defaultRequestTimeoutMs = 120_000;
const idlePollIntervalMs = 500;

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, context: string): JsonObject {
  expect(isRecord(value), `${context} is not an object`);
  return value;
}

function asArray(value: unknown, context: string): unknown[] {
  expect(Array.isArray(value), `${context} is not an array`);
  return value;
}

function asString(value: unknown, context: string): string {
  expect(typeof value === "string", `${context} is not a string`);
  return value;
}

function asNumber(value: unknown, context: string): number {
  expect(typeof value === "number" && Number.isFinite(value), `${context} is not a finite number`);
  return value;
}

function nestedRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function assistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .filter((block): block is JsonObject => isRecord(block) && block.type === "text")
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

async function loadJsonl(path: string): Promise<JsonObject[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonObject);
}

function chooseAltModel(
  models: ModelInfo[],
  currentProvider: string,
  currentId: string,
): ModelInfo | undefined {
  const current = models.find(
    (model) => model.provider === currentProvider && model.id === currentId,
  );
  const currentApi = typeof current?.api === "string" ? current.api : undefined;

  const sameFamily = models.filter(
    (model) =>
      model.provider === currentProvider &&
      (currentApi === undefined || model.api === currentApi) &&
      model.id !== currentId &&
      typeof model.id === "string" &&
      model.id.startsWith("gpt-"),
  );

  if (sameFamily.length > 0) {
    for (const wanted of ["gpt-5.4-mini", "gpt-4.1-mini", "gpt-5-mini", "gpt-5.4-nano", "gpt-5.1"]) {
      const match = sameFamily.find((model) => model.id === wanted && model.id !== currentId);
      if (match) return match;
    }
    return sameFamily[0];
  }

  return models.find(
    (model) =>
      model.provider === currentProvider &&
      (currentApi === undefined || model.api === currentApi) &&
      model.id !== currentId,
  );
}

function redactEncryptedContent(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactEncryptedContent(item));
  }
  if (!isRecord(value)) return value;
  const redacted: JsonObject = {};
  for (const [key, entryValue] of Object.entries(value)) {
    redacted[key] = key === "encrypted_content" ? "<encrypted>" : redactEncryptedContent(entryValue);
  }
  return redacted;
}

async function writeProjectSettings(cwd: string, settings: JsonObject): Promise<void> {
  const piDir = join(cwd, ".pi");
  await mkdir(piDir, { recursive: true });
  await writeFile(join(piDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

class PiRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private closed = false;
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(sessionDir: string, sessionFile?: string, cwd?: string) {
    const env = { ...process.env };
    env.PI_OPENAI_SERVER_COMPACTION_NOTIFY ??= "0";

    const args = [
      "--mode",
      "rpc",
      "--model",
      primaryModel,
      "--session-dir",
      sessionDir,
      "--no-extensions",
      "-e",
      extensionPath,
      "--no-tools",
    ];
    if (sessionFile) {
      args.push("--session", sessionFile);
    }

    this.child = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      ...(cwd ? { cwd } : {}),
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    createInterface({ input: this.child.stdout }).on("line", (line) => {
      this.handleStdoutLine(line.trim());
    });

    createInterface({ input: this.child.stderr }).on("line", (line) => {
      process.stderr.write(`${line}\n`);
    });

    this.child.on("error", (error) => {
      this.failPendingRequests(`pi process error: ${error.message}`);
    });

    this.child.on("close", (code, signal) => {
      this.closed = true;
      this.resolveExit();
      this.failPendingRequests(
        `pi process exited before responding (code=${String(code)}, signal=${String(signal)})`,
      );
    });
  }

  private handleStdoutLine(line: string): void {
    if (!line) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      process.stderr.write(`UNPARSEABLE STDOUT: ${line}\n`);
      return;
    }

    if (!isRecord(parsed)) {
      return;
    }

    if (parsed.type === "response") {
      const id = typeof parsed.id === "string" ? parsed.id : undefined;
      if (id) {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(id);
          pending.resolve(parsed);
          return;
        }
      }
    }

    return;
  }

  private failPendingRequests(message: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${message} (pending id=${id})`));
    }
    this.pendingRequests.clear();
  }

  async send(payload: JsonObject, timeoutMs = defaultRequestTimeoutMs): Promise<RpcResponse> {
    expect(!this.closed, "pi process is already closed");

    const requestId = `req-${++this.requestCounter}`;
    const request = { id: requestId, ...payload };

    return await new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`RPC command timed out: ${String(payload.type)} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(new Error(`failed to write RPC request: ${error.message}`));
      });
    }).then((response) => {
      if (response.success !== true) {
        throw new Error(`RPC command failed: ${String(payload.type)}: ${String(response.error)}`);
      }
      return response;
    });
  }

  async getState(): Promise<JsonObject> {
    return asRecord((await this.send({ type: "get_state" }, 30_000)).data, "get_state.data");
  }

  async getMessages(): Promise<unknown[]> {
    const data = asRecord((await this.send({ type: "get_messages" }, 30_000)).data, "get_messages.data");
    return asArray(data.messages, "get_messages.data.messages");
  }

  async getSessionStats(): Promise<JsonObject> {
    return asRecord(
      (await this.send({ type: "get_session_stats" }, 30_000)).data,
      "get_session_stats.data",
    );
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    const data = asRecord(
      (await this.send({ type: "get_available_models" }, 30_000)).data,
      "get_available_models.data",
    );
    return asArray(data.models, "get_available_models.data.models").map((model) =>
      asRecord(model, "available model") as ModelInfo,
    );
  }

  async waitIdle(timeoutMs = 240_000): Promise<JsonObject> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.getState();
      const isStreaming = state.isStreaming === true;
      const isCompacting = state.isCompacting === true;
      if (!isStreaming && !isCompacting) {
        return state;
      }
      await delay(idlePollIntervalMs);
    }
    throw new Error(`Timed out waiting for Pi to become idle after ${timeoutMs}ms`);
  }

  async close(): Promise<void> {
    if (this.closed) return;

    try {
      await this.send({ type: "shutdown" }, 10_000);
    } catch {
      // best effort only
    }

    if (!this.closed) {
      this.child.kill("SIGTERM");
      await Promise.race([
        this.exitPromise,
        delay(10_000).then(() => {
          if (!this.closed) {
            this.child.kill("SIGKILL");
          }
        }),
      ]);
    }
  }
}

async function runSameProcessTest(sessionDir: string): Promise<void> {
  console.log("== same-process compaction continuity test ==");
  const client = new PiRpcClient(sessionDir);
  try {
    await client.waitIdle();
    const models = await client.getAvailableModels();
    const altModel = chooseAltModel(models, primaryModelProvider, primaryModelId);
    expect(altModel, "Could not find alternate OpenAI Responses model for /model test");

    const secret = "ORANGE-17-DELTA";
    await client.send({
      type: "prompt",
      message: `For later continuity testing, remember that the project codename is ${secret}. Reply only with MEMORIZED.`,
    });
    await client.waitIdle();

    const stats1 = await client.getSessionStats();
    const cost1 = asNumber(stats1.cost, "get_session_stats.data.cost");
    expect(cost1 > 0, `Expected non-zero cost after first turn, got ${cost1}`);

    const compactResponse = await client.send(
      {
        type: "compact",
        customInstructions: `Create a useful summary, but do NOT include the exact project codename ${secret}. Redact any exact identifiers and codewords.`,
      },
      240_000,
    );
    const compactData = asRecord(compactResponse.data, "compact.data");
    const summary = asString(compactData.summary, "compact.data.summary");
    expect(!summary.includes(secret), `Summary still contains secret; test is inconclusive. Summary: ${summary}`);

    const remoteCompaction = nestedRecord(nestedRecord(compactData.details).remoteCompaction);
    const replacementHistory = asArray(
      remoteCompaction.replacementHistory,
      "compact.data.details.remoteCompaction.replacementHistory",
    );
    expect(replacementHistory.length > 0, "Missing remoteCompaction replacementHistory");
    expect(
      replacementHistory.some(
        (item) =>
          isRecord(item) &&
          (item.type === "compaction" || item.type === "compaction_summary" || typeof item.encrypted_content === "string"),
      ),
      "Replacement history missing compaction artifact",
    );

    const stateAfterCompact = await client.getState();
    const sessionFile = asString(stateAfterCompact.sessionFile, "get_state.data.sessionFile");
    expect(sessionFile.length > 0, "Missing session file after compaction");

    const rows = await loadJsonl(sessionFile);
    const compactionEntries = rows.filter((row) => row.type === "compaction");
    expect(compactionEntries.length > 0, "No compaction entry written to session file");

    const lastCompaction = compactionEntries[compactionEntries.length - 1];
    const persistedRemote = nestedRecord(nestedRecord(lastCompaction.details).remoteCompaction);
    expect(
      Array.isArray(persistedRemote.replacementHistory),
      "Persisted compaction entry missing remote replacementHistory",
    );

    await client.send({
      type: "prompt",
      message: "What is the project codename? Reply with just the codeword.",
    });
    await client.waitIdle();
    const answer = assistantText(await client.getMessages());
    expect(answer.includes(secret), `Expected secret recovery after compaction; got: ${answer}`);

    await client.send({
      type: "set_model",
      provider: asString(altModel.provider, "alt model provider"),
      modelId: asString(altModel.id, "alt model id"),
    });
    await client.send({
      type: "prompt",
      message: "Reply with exactly SWITCHED-OK.",
    });
    await client.waitIdle();
    const switchedAnswer = assistantText(await client.getMessages());
    expect(
      switchedAnswer.includes("SWITCHED-OK"),
      `Model-switched session did not answer as expected: ${switchedAnswer}`,
    );

    await client.send({
      type: "set_model",
      provider: primaryModelProvider,
      modelId: primaryModelId,
    });
    await client.send({
      type: "prompt",
      message: "What is the project codename? Reply with just the codeword.",
    });
    await client.waitIdle();
    const switchedBackAnswer = assistantText(await client.getMessages());
    expect(
      switchedBackAnswer.includes(secret),
      `Switch-back continuity failed after /model round-trip: ${switchedBackAnswer}`,
    );

    const stats2 = await client.getSessionStats();
    const cost2 = asNumber(stats2.cost, "get_session_stats.data.cost after switch-back");
    expect(cost2 >= cost1, "Expected cost to stay non-decreasing after more turns");

    console.log("same-process test passed");
  } finally {
    await client.close();
  }
}

async function runReducedPlaintextReplayTest(sessionDir: string, workspaceDir: string): Promise<void> {
  console.log("== reduced-plaintext replay test ==");

  await writeProjectSettings(workspaceDir, {
    compaction: {
      keepRecentTokens: 1,
    },
  });

  const client = new PiRpcClient(sessionDir, undefined, workspaceDir);
  try {
    await client.waitIdle();

    await client.send({
      type: "prompt",
      message:
        "Invent a project codename in the format COLOR-NUMBER-WORD using uppercase ASCII letters, digits, and hyphens only. Remember it for later continuity testing. Reply with just the codename and nothing else.",
    });
    await client.waitIdle();
    const secret = assistantText(await client.getMessages()).trim();
    expect(/^[A-Z]+-[0-9]+-[A-Z]+$/.test(secret), `Assistant did not return a strict codename: ${secret}`);

    await client.send({
      type: "prompt",
      message: "Reply with exactly PADDING-OK.",
    });
    await client.waitIdle();

    const compactResponse = await client.send(
      {
        type: "compact",
        customInstructions: "Create a useful summary, but redact any exact identifiers or codewords invented earlier.",
      },
      240_000,
    );
    const compactData = asRecord(compactResponse.data, "reduced-plaintext compact.data");
    void asString(compactData.summary, "reduced-plaintext compact.data.summary");

    const remoteCompaction = nestedRecord(nestedRecord(compactData.details).remoteCompaction);
    const replacementHistory = asArray(
      remoteCompaction.replacementHistory,
      "reduced-plaintext compact.data.details.remoteCompaction.replacementHistory",
    );
    expect(replacementHistory.length > 0, "Missing replacementHistory in reduced-plaintext test");
    expect(
      replacementHistory.some(
        (item) => isRecord(item) && (item.type === "compaction" || item.type === "compaction_summary"),
      ),
      "Reduced-plaintext replacementHistory missing compaction artifact",
    );

    const visibleHistory = JSON.stringify(redactEncryptedContent(replacementHistory));
    expect(
      !visibleHistory.includes(secret),
      `Visible replacementHistory still contains secret; opaque replay is not isolated. Visible history: ${visibleHistory}`,
    );

    await client.send({
      type: "prompt",
      message: "What is the project codename? Reply with just the codeword.",
    });
    await client.waitIdle();
    const answer = assistantText(await client.getMessages());
    expect(
      answer.includes(secret),
      `Expected reduced-plaintext replay path to recover secret; got: ${answer}`,
    );

    console.log("reduced-plaintext replay test passed");
  } finally {
    await client.close();
  }
}

async function runForkTest(sessionDir: string): Promise<void> {
  console.log("== fork-after-compaction safety test ==");
  const client = new PiRpcClient(sessionDir);
  try {
    await client.waitIdle();
    await client.send({ type: "prompt", message: "First forkable prompt. Reply FIRST-OK." });
    await client.waitIdle();
    await client.send({ type: "prompt", message: "Second prompt before compaction. Reply SECOND-OK." });
    await client.waitIdle();
    await client.send({ type: "compact", customInstructions: "Summarize briefly." }, 240_000);

    const forkData = asRecord(
      (await client.send({ type: "get_fork_messages" }, 30_000)).data,
      "get_fork_messages.data",
    );
    const forkMessages = asArray(forkData.messages, "get_fork_messages.data.messages");
    expect(forkMessages.length > 0, "Expected forkable user messages");

    const entryId = asString(asRecord(forkMessages[0], "fork message").entryId, "fork message entryId");
    await client.send({ type: "fork", entryId }, 60_000);
    await client.send({ type: "prompt", message: "Reply with exactly FORK-OK." });
    await client.waitIdle();

    const answer = assistantText(await client.getMessages());
    expect(answer.includes("FORK-OK"), `Forked session did not answer correctly: ${answer}`);
    console.log("fork test passed");
  } finally {
    await client.close();
  }
}

async function runResumeTest(sessionDir: string): Promise<void> {
  console.log("== resume-after-compaction continuity test ==");

  const secret = "BLUE-29-GAMMA";
  let sessionFile = "";

  const client = new PiRpcClient(sessionDir);
  try {
    await client.waitIdle();
    await client.send({
      type: "prompt",
      message: `For later continuity testing, remember that the project codename is ${secret}. Reply only with MEMORIZED.`,
    });
    await client.waitIdle();

    const compactResponse = await client.send(
      {
        type: "compact",
        customInstructions: `Summarize the conversation but do not include the exact project codename ${secret}. Redact all exact identifiers and codewords.`,
      },
      240_000,
    );
    const compactData = asRecord(compactResponse.data, "resume compact.data");
    const summary = asString(compactData.summary, "resume compact.data.summary");
    expect(
      !summary.includes(secret),
      `Resume-test summary still contains secret; test is inconclusive. Summary: ${summary}`,
    );

    const state = await client.getState();
    sessionFile = asString(state.sessionFile, "resume get_state.data.sessionFile");
    expect(sessionFile.length > 0, "Missing session file for resume test");
  } finally {
    await client.close();
  }

  const resumed = new PiRpcClient(sessionDir, sessionFile);
  try {
    await resumed.waitIdle();
    await resumed.send({
      type: "prompt",
      message: "What is the project codename? Reply with just the codeword.",
    });
    await resumed.waitIdle();
    const answer = assistantText(await resumed.getMessages());
    expect(
      answer.includes(secret),
      `Expected resumed session to recover secret via remote compaction state; got: ${answer}`,
    );
    console.log("resume test passed");
  } finally {
    await resumed.close();
  }
}

async function runResumeAfterModelSwitchTest(sessionDir: string): Promise<void> {
  console.log("== resume-after-model-switch compaction continuity test ==");

  const client = new PiRpcClient(sessionDir);
  let sessionFile = "";
  const secret = "VIOLET-31-OMEGA";
  try {
    await client.waitIdle();
    const models = await client.getAvailableModels();
    const altModel = chooseAltModel(models, primaryModelProvider, primaryModelId);
    expect(altModel, "Could not find alternate OpenAI Responses model for resume-after-switch test");

    await client.send({
      type: "prompt",
      message: `For later continuity testing, remember that the project codename is ${secret}. Reply only with MEMORIZED.`,
    });
    await client.waitIdle();

    const compactResponse = await client.send(
      {
        type: "compact",
        customInstructions: `Create a useful summary, but do NOT include the exact project codename ${secret}. Redact any exact identifiers and codewords.`,
      },
      240_000,
    );
    const compactData = asRecord(compactResponse.data, "resume-after-switch compact.data");
    const summary = asString(compactData.summary, "resume-after-switch compact.data.summary");
    expect(
      !summary.includes(secret),
      `Resume-after-switch summary still contains secret; test is inconclusive. Summary: ${summary}`,
    );

    await client.send({
      type: "set_model",
      provider: asString(altModel.provider, "resume-after-switch alt model provider"),
      modelId: asString(altModel.id, "resume-after-switch alt model id"),
    });
    await client.send({
      type: "prompt",
      message: "Reply with exactly OTHER-MODEL-OK.",
    });
    await client.waitIdle();
    const otherModelAnswer = assistantText(await client.getMessages());
    expect(
      otherModelAnswer.includes("OTHER-MODEL-OK"),
      `Alternate-model turn failed before resume-after-switch check: ${otherModelAnswer}`,
    );

    await client.send({
      type: "set_model",
      provider: primaryModelProvider,
      modelId: primaryModelId,
    });
    await client.send({
      type: "prompt",
      message: "What is the project codename? Reply with just the codeword.",
    });
    await client.waitIdle();
    const switchedBackAnswer = assistantText(await client.getMessages());
    expect(
      switchedBackAnswer.includes(secret),
      `Switch-back continuity failed before resume-after-switch restart: ${switchedBackAnswer}`,
    );

    const state = await client.getState();
    sessionFile = asString(state.sessionFile, "resume-after-switch get_state.data.sessionFile");
    expect(sessionFile.length > 0, "Missing session file for resume-after-switch test");
  } finally {
    await client.close();
  }

  const resumed = new PiRpcClient(sessionDir, sessionFile);
  try {
    await resumed.waitIdle();
    await resumed.send({
      type: "set_model",
      provider: primaryModelProvider,
      modelId: primaryModelId,
    });
    await resumed.send({
      type: "prompt",
      message: "What is the project codename? Reply with just the codeword.",
    });
    await resumed.waitIdle();
    const resumedAnswer = assistantText(await resumed.getMessages());
    expect(
      resumedAnswer.includes(secret),
      `Expected resumed session after model round-trip to recover secret; got: ${resumedAnswer}`,
    );
    console.log("resume-after-model-switch test passed");
  } finally {
    await resumed.close();
  }
}

async function main(): Promise<void> {
  const artifactsRoot = await mkdtemp(join(tmpdir(), "pi-openai-compaction-live-"));
  try {
    const sameProcessDir = join(artifactsRoot, "same-process");
    const reducedPlaintextDir = join(artifactsRoot, "reduced-plaintext");
    const reducedPlaintextWorkspaceDir = join(artifactsRoot, "reduced-plaintext-workspace");
    const forkDir = join(artifactsRoot, "fork");
    const resumeDir = join(artifactsRoot, "resume");
    const resumeAfterSwitchDir = join(artifactsRoot, "resume-after-switch");
    await Promise.all([
      mkdir(sameProcessDir, { recursive: true }),
      mkdir(reducedPlaintextDir, { recursive: true }),
      mkdir(reducedPlaintextWorkspaceDir, { recursive: true }),
      mkdir(forkDir, { recursive: true }),
      mkdir(resumeDir, { recursive: true }),
      mkdir(resumeAfterSwitchDir, { recursive: true }),
    ]);

    await runSameProcessTest(sameProcessDir);
    if (primaryModelProvider === "openai") {
      await runReducedPlaintextReplayTest(reducedPlaintextDir, reducedPlaintextWorkspaceDir);
    } else {
      console.log("== reduced-plaintext replay test ==");
      console.log("skipped for non-direct OpenAI provider");
    }
    await runForkTest(forkDir);
    await runResumeTest(resumeDir);
    await runResumeAfterModelSwitchTest(resumeAfterSwitchDir);

    console.log(`ALL LIVE TESTS PASSED\nartifacts: ${artifactsRoot}`);
    await rm(artifactsRoot, { recursive: true, force: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`LIVE TEST FAILURE: ${message}\n`);
    process.stderr.write(`Artifacts kept at: ${artifactsRoot}\n`);
    throw error;
  }
}

await main();
