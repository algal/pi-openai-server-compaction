#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { BenchmarkFixture } from "./fixtures.ts";
import { evaluateArm, summarizeText } from "./run.ts";

const DENSE_INSTRUCTIONS = `Create a maximally dense, loss-minimizing continuation state dump for another model. The later questions are unknown.

Order the dump as follows so late state cannot be lost: (1) current task checkpoint and every work-item state, blocker, next action, and hard constraint; (2) every final correction and which values are obsolete; (3) every exact tool/probe result; (4) every direct relationship; (5) every exact active-project parameter and base fact.

Copy identifiers and values exactly. Include every numbered active-project ledger entry, not merely examples. Use compact section labels and semicolon-delimited key=value or source->target records. Spend no tokens paraphrasing unrelated archive distractors, acknowledgements, or obvious prose. Do not answer future questions or continue the work. Continue until every authoritative active-project record has been captured.`;

type OriginalTrial = {
  fixtureId: string;
  trial: number;
  nativeBudgetTokens: number;
  evaluations: { native_compaction: { scores: Array<{ questionId: string; correct: boolean }> } };
};

type DenseRecord = {
  fixtureId: string;
  trial: number;
  nativeBudgetTokens: number;
  summary: Awaited<ReturnType<typeof summarizeText>>;
  evaluation: Awaited<ReturnType<typeof evaluateArm>>;
};

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

async function main(): Promise<void> {
  const runDir = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Usage: run-dense-text-variant.ts <reference-run-directory>");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  const modelId = String(manifest.model).replace(/^openai\//, "");
  const model = getModel("openai", modelId as Parameters<typeof getModel>[1]);
  if (!model) throw new Error(`Model not found: ${manifest.model}`);
  const fixtures = JSON.parse(await readFile(join(runDir, "fixtures.json"), "utf8")) as BenchmarkFixture[];
  const originals = (await readFile(join(runDir, "trials.jsonl"), "utf8"))
    .trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as OriginalTrial);
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const outputPath = join(runDir, "dense-text-trials.jsonl");

  const records: DenseRecord[] = [];
  for (const original of originals) {
    const fixture = fixtureById.get(original.fixtureId);
    if (!fixture) throw new Error(`Missing fixture ${original.fixtureId}`);
    console.log(`[${original.fixtureId}] trial ${original.trial}: dense summary and evaluation`);
    const summary = await summarizeText({
      apiKey,
      model,
      fixture,
      maxOutputTokens: original.nativeBudgetTokens,
      summaryInstructions: DENSE_INSTRUCTIONS,
    });
    const evaluation = await evaluateArm({
      apiKey,
      model,
      fixture,
      context: [{
        type: "message",
        role: "user",
        content: [{
          type: "input_text",
          text: `The conversation before the retained tail was compacted into this dense continuation memory:\n\n<summary>\n${summary.text}\n</summary>`,
        }],
      }, ...fixture.sharedTail],
    });
    const record = {
      fixtureId: fixture.id,
      trial: original.trial,
      nativeBudgetTokens: original.nativeBudgetTokens,
      summary,
      evaluation,
    };
    records.push(record);
    await appendFile(outputPath, `${JSON.stringify(record)}\n`);
    console.log(`  score=${evaluation.scores.filter((score) => score.correct).length}/${evaluation.scores.length}; output=${summary.usage?.output}/${original.nativeBudgetTokens}`);
  }

  const allScores = records.flatMap((record) => record.evaluation.scores);
  const categories = [...new Set(allScores.map((score) => score.category))];
  const byCategory = Object.fromEntries(categories.map((category) => {
    const rows = allScores.filter((score) => score.category === category);
    return [category, { correct: rows.filter((score) => score.correct).length, total: rows.length }];
  }));
  let nativeOnly = 0;
  let denseOnly = 0;
  let bothCorrect = 0;
  let bothWrong = 0;
  for (const [index, record] of records.entries()) {
    const native = new Map(originals[index]!.evaluations.native_compaction.scores.map((score) => [score.questionId, score.correct]));
    for (const score of record.evaluation.scores) {
      const nativeCorrect = native.get(score.questionId) ?? false;
      if (nativeCorrect && score.correct) bothCorrect++;
      else if (nativeCorrect) nativeOnly++;
      else if (score.correct) denseOnly++;
      else bothWrong++;
    }
  }
  const summary = {
    variant: "dense-task-first-text-summary",
    prompt: DENSE_INSTRUCTIONS,
    trials: records.length,
    aggregate: { correct: allScores.filter((score) => score.correct).length, total: allScores.length },
    byCategory,
    pairedVsNative: { bothCorrect, nativeOnly, denseOnly, bothWrong },
    usage: {
      meanBudgetTokens: average(records.map((record) => record.nativeBudgetTokens)),
      meanOutputTokens: average(records.map((record) => record.summary.usage?.output ?? 0)),
      meanDownstreamInputTokens: average(records.map((record) => record.evaluation.usage?.input ?? 0)),
      meanSummaryCostUsd: average(records.map((record) => record.summary.usage?.cost.total ?? 0)),
      meanEvaluationCostUsd: average(records.map((record) => record.evaluation.usage?.cost.total ?? 0)),
    },
  };
  await writeFile(join(runDir, "dense-text-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

await main();
