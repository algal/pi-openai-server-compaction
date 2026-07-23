import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const STATE_VERSION = 1;
const MAX_BRANCHES_PER_IDENTITY = 8;
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

export function hashValue(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function approximateTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(canonicalJson(value), "utf8") / 4));
}

function callId(item) {
  return item && typeof item === "object" && typeof item.call_id === "string" ? item.call_id : null;
}

function isFunctionCall(item) {
  return item && typeof item === "object" && ["function_call", "custom_tool_call", "function_shell_call"].includes(item.type);
}

function isFunctionOutput(item) {
  return item && typeof item === "object" && ["function_call_output", "custom_tool_call_output", "function_shell_call_output"].includes(item.type);
}

export function chooseSafeCutIndex(items, _currentTokens, keepTokens, minimumIndex = 0) {
  if (!Array.isArray(items) || items.length <= minimumIndex + 1) return minimumIndex;
  let keptTokens = 0;
  let cut = items.length - 1;
  for (let index = items.length - 1; index >= minimumIndex; index -= 1) {
    const next = keptTokens + approximateTokens(items[index]);
    if (next > keepTokens) {
      cut = index === items.length - 1 ? index : index + 1;
      break;
    }
    keptTokens = next;
    cut = index;
  }

  // Never leave an output in the retained tail while compacting its matching call.
  const callIndexes = new Map();
  items.forEach((item, index) => {
    if (isFunctionCall(item) && callId(item)) callIndexes.set(callId(item), index);
  });
  for (let index = cut; index < items.length; index += 1) {
    const item = items[index];
    if (!isFunctionOutput(item)) continue;
    const matchingCall = callIndexes.get(callId(item));
    if (matchingCall !== undefined && matchingCall < cut) cut = matchingCall;
  }

  // An unresolved call belongs in the live tail, not in an opaque old prefix.
  for (let index = minimumIndex; index < cut; index += 1) {
    const item = items[index];
    if (!isFunctionCall(item) || !callId(item)) continue;
    const hasOutput = items.some((candidate, outputIndex) => outputIndex < cut && isFunctionOutput(candidate) && callId(candidate) === callId(item));
    if (!hasOutput) cut = Math.min(cut, index);
  }
  return Math.max(minimumIndex, cut);
}

export function identityHash(headers, model, requestShape = {}) {
  const session = headers["x-grok-session-id"];
  if (!session || typeof model !== "string") return null;
  return hashValue({
    session,
    conversation: headers["x-grok-conv-id"] || session,
    agent: headers["x-grok-agent-id"] || "parent",
    model,
    requestShape,
  });
}

export function sourcePrefixHash(input, length) {
  return hashValue(input.slice(0, length));
}

export class StateStore {
  constructor(file, logger = () => {}) {
    this.file = file;
    this.logger = logger;
    this.loaded = false;
    this.data = { version: STATE_VERSION, identities: {} };
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed?.version === STATE_VERSION && parsed.identities && typeof parsed.identities === "object") {
        this.data = parsed;
        this.prune();
      }
    } catch (error) {
      if (error?.code !== "ENOENT") this.logger("state_load_failed", { error: error?.message || String(error) });
    }
  }

  prune(now = Date.now()) {
    for (const [key, record] of Object.entries(this.data.identities)) {
      const branches = Array.isArray(record?.branches) ? record.branches : [];
      record.branches = branches.filter((branch) => now - Date.parse(branch.lastUsedAt || branch.createdAt || 0) <= STATE_TTL_MS).slice(-MAX_BRANCHES_PER_IDENTITY);
      if (record.branches.length === 0) delete this.data.identities[key];
    }
  }

  async match(key, input) {
    await this.load();
    if (!key || !Array.isArray(input)) return null;
    const branches = [...(this.data.identities[key]?.branches || [])].sort((a, b) => b.sourcePrefixLength - a.sourcePrefixLength);
    for (const branch of branches) {
      if (!Number.isInteger(branch.sourcePrefixLength) || branch.sourcePrefixLength > input.length) continue;
      if (sourcePrefixHash(input, branch.sourcePrefixLength) === branch.sourcePrefixHash) return structuredClone(branch);
    }
    return null;
  }

  async commit(key, branch) {
    await this.load();
    if (!key) return;
    const record = this.data.identities[key] || { branches: [] };
    const branches = record.branches.filter((existing) => !(existing.sourcePrefixLength === branch.sourcePrefixLength && existing.sourcePrefixHash === branch.sourcePrefixHash));
    branches.push({ ...structuredClone(branch), lastUsedAt: new Date().toISOString() });
    record.branches = branches.slice(-MAX_BRANCHES_PER_IDENTITY);
    this.data.identities[key] = record;
    this.prune();
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(this.data)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  countBranches() {
    return Object.values(this.data.identities).reduce((sum, record) => sum + (record.branches?.length || 0), 0);
  }
}
