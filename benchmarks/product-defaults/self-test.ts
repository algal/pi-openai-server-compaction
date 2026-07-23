#!/usr/bin/env node
import assert from "node:assert/strict";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { getModel } from "@earendil-works/pi-ai/compat";
import { buildProductFixture } from "./fixtures.ts";
import { messagesAsResponseItems, messagesToEntries } from "./run.ts";

const low = buildProductFixture({ seed: 7, density: 60, targetTokens: 50_000 });
const high = buildProductFixture({ seed: 7, density: 320, targetTokens: 50_000 });
const repeated = buildProductFixture({ seed: 7, density: 60, targetTokens: 50_000 });

assert.equal(JSON.stringify(low), JSON.stringify(repeated), "fixtures must be deterministic");
assert.equal(low.questions.length, 75);
assert.equal(new Set(low.questions.map((question) => question.id)).size, low.questions.length);
assert.equal(new Set(low.questions.map((question) => question.expected)).size, low.questions.length);
assert.equal(low.authoritativeRecords, 300);
assert.equal(high.authoritativeRecords, 1600);
assert.ok(Math.abs(low.estimatedTokens - 50_000) < 500);
assert.ok(Math.abs(high.estimatedTokens - 50_000) < 500);
assert.ok(
  Math.abs(low.estimatedTokens - high.estimatedTokens) < 20,
  "density must change information load without materially changing estimated context size",
);
assert.deepEqual(
  [...new Set(low.questions.map((question) => question.category))].sort(),
  [
    "distractor_resolution",
    "exact_recall",
    "relational_state",
    "task_continuation",
    "tool_history",
  ],
);
for (const category of new Set(low.questions.map((question) => question.category))) {
  assert.equal(low.questions.filter((question) => question.category === category).length, 15);
}
assert.ok(
  low.questions.every((question) => !JSON.stringify(low.sharedTail).includes(question.expected)),
  "shared tail must not contain answers",
);

const entries = messagesToEntries(low);
assert.equal(entries.length, low.messages.length);
for (const [index, entry] of entries.entries()) {
  assert.equal(entry.parentId, index === 0 ? null : entries[index - 1]!.id);
}
const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
assert.ok(preparation, "Pi default compactor must have a non-empty prefix to summarize");
assert.ok(preparation.messagesToSummarize.length > 0);
assert.ok(entries.some((entry) => entry.id === preparation.firstKeptEntryId));

const model = getModel("openai", "gpt-5.6-sol");
assert.ok(model, "benchmark model must exist in the pinned catalog");
const responseItems = messagesAsResponseItems(low.messages, model);
const callIds = new Set(
  responseItems
    .filter((item) => item.type === "function_call")
    .map((item) => String("call_id" in item ? item.call_id : "")),
);
const outputIds = new Set(
  responseItems
    .filter((item) => item.type === "function_call_output")
    .map((item) => String("call_id" in item ? item.call_id : "")),
);
assert.ok(callIds.size > 0);
assert.deepEqual(callIds, outputIds, "every synthetic tool call must have exactly one replayable output");

console.log("product-defaults benchmark self-test ok");
