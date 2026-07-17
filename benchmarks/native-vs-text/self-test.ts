#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildFixture, buildFixtures } from "./fixtures.ts";

const fixture = buildFixture(1);
assert.equal(fixture.questions.length, 75);
assert.equal(new Set(fixture.questions.map((question) => question.id)).size, 75);
assert.deepEqual(
  [...new Set(fixture.questions.map((question) => question.category))].sort(),
  ["distractor_resolution", "exact_recall", "relational_state", "task_continuation", "tool_history"],
);
for (const category of new Set(fixture.questions.map((question) => question.category))) {
  assert.equal(fixture.questions.filter((question) => question.category === category).length, 15);
}
assert.ok(fixture.history.length > 300, "fixture should create a long conversation");
assert.ok(fixture.history.some((item) => item.type === "function_call"));
assert.ok(fixture.history.some((item) => item.type === "function_call_output"));
assert.equal(JSON.stringify(buildFixture(1)), JSON.stringify(fixture), "fixtures must be deterministic");
assert.notEqual(JSON.stringify(buildFixture(2)), JSON.stringify(fixture), "seeds must vary fixtures");
assert.equal(buildFixtures(3).length, 3);

console.log("benchmark self-test ok");
