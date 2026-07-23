#!/usr/bin/env node
import os from "node:os";
import path from "node:path";

import { createGateway } from "./server.mjs";

function positiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function log(event, fields = {}) {
  process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
}

const home = os.homedir();
const upstream = process.env.GROK_COMPACTION_UPSTREAM?.trim();
if (!upstream) throw new Error("GROK_COMPACTION_UPSTREAM is required");
const gateway = createGateway({
  host: process.env.GROK_COMPACTION_HOST || "127.0.0.1",
  port: positiveInteger("GROK_COMPACTION_PORT", 10532),
  upstream,
  stateFile: process.env.GROK_COMPACTION_STATE_FILE || path.join(home, ".grok", "openai-compaction-gateway", "state.json"),
  thresholdTokens: positiveInteger("GROK_COMPACTION_THRESHOLD_TOKENS", 180_000),
  keepTokens: positiveInteger("GROK_COMPACTION_KEEP_TOKENS", 20_000),
  helperModel: process.env.GROK_COMPACTION_HELPER_MODEL || "gpt-5.6-luna",
  logger: log,
});

await gateway.start();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    log("gateway_stopping", { signal });
    await gateway.close();
    process.exit(0);
  });
}
