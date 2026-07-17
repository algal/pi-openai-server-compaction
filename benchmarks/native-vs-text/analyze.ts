#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type Arm = "full_context" | "native_compaction" | "text_summary";
type Score = {
  questionId: string;
  category: string;
  expected: string;
  actual: string;
  correct: boolean;
};
type Usage = { input: number; output: number; cacheRead: number; cacheWrite?: number; totalTokens: number; cost: { total: number } };
type Evaluation = { latencyMs: number; usage?: Usage; scores: Score[] };
type RecordRow = {
  fixtureId: string;
  trial: number;
  nativeBudgetTokens: number;
  nativeCompaction: { latencyMs: number; usage?: Usage; artifactBytes: number };
  textSummary: { latencyMs: number; usage?: Usage; characters: number };
  evaluations: Record<Arm, Evaluation>;
};

const ARMS: Arm[] = ["full_context", "native_compaction", "text_summary"];

function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

function binomialCoefficient(n: number, k: number): number {
  const reduced = Math.min(k, n - k);
  let value = 1;
  for (let index = 1; index <= reduced; index++) value = (value * (n - reduced + index)) / index;
  return value;
}

function exactMcNemarP(nativeOnly: number, textOnly: number): number {
  const discordant = nativeOnly + textOnly;
  if (discordant === 0) return 1;
  const tail = Math.min(nativeOnly, textOnly);
  let cumulative = 0;
  for (let index = 0; index <= tail; index++) {
    cumulative += binomialCoefficient(discordant, index) * 0.5 ** discordant;
  }
  return Math.min(1, 2 * cumulative);
}

function aggregateScores(rows: Score[]) {
  const correct = rows.filter((row) => row.correct).length;
  const total = rows.length;
  const [low, high] = wilson(correct, total);
  return { correct, total, accuracy: total ? correct / total : 0, wilson95: [low, high] };
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function fmtPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtNumber(value: number): string {
  return value.toFixed(2);
}

async function main(): Promise<void> {
  const runDir = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) throw new Error("Usage: analyze.ts <run-directory>");
  const manifest = JSON.parse(await readFile(join(runDir, "manifest.json"), "utf8"));
  const lines = (await readFile(join(runDir, "trials.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean);
  const records = lines.map((line) => JSON.parse(line) as RecordRow);
  if (records.length === 0) throw new Error("No trial records found");

  const categories = [...new Set(records.flatMap((record) => record.evaluations.full_context.scores.map((row) => row.category)))];
  const byArm = Object.fromEntries(ARMS.map((arm) => [arm, aggregateScores(records.flatMap((record) => record.evaluations[arm].scores))]));
  const byCategory = Object.fromEntries(categories.map((category) => [
    category,
    Object.fromEntries(ARMS.map((arm) => [
      arm,
      aggregateScores(records.flatMap((record) => record.evaluations[arm].scores.filter((row) => row.category === category))),
    ])),
  ]));

  let nativeOnly = 0;
  let textOnly = 0;
  let bothCorrect = 0;
  let bothWrong = 0;
  const disagreements: Array<Record<string, unknown>> = [];
  for (const record of records) {
    const native = new Map(record.evaluations.native_compaction.scores.map((row) => [row.questionId, row]));
    for (const text of record.evaluations.text_summary.scores) {
      const nativeRow = native.get(text.questionId);
      if (!nativeRow) continue;
      if (nativeRow.correct && text.correct) bothCorrect++;
      else if (nativeRow.correct) {
        nativeOnly++;
        disagreements.push({ fixtureId: record.fixtureId, trial: record.trial, winner: "native", native: nativeRow, text });
      } else if (text.correct) {
        textOnly++;
        disagreements.push({ fixtureId: record.fixtureId, trial: record.trial, winner: "text", native: nativeRow, text });
      } else bothWrong++;
    }
  }

  const usage = {
    nativeCompaction: {
      meanLatencyMs: average(records.map((record) => record.nativeCompaction.latencyMs)),
      meanInputTokens: average(records.map((record) => record.nativeCompaction.usage?.input ?? 0)),
      meanCacheWriteTokens: average(records.map((record) => record.nativeCompaction.usage?.cacheWrite ?? 0)),
      meanProcessedInputTokens: average(records.map((record) => {
        const value = record.nativeCompaction.usage;
        return (value?.input ?? 0) + (value?.cacheRead ?? 0) + (value?.cacheWrite ?? 0);
      })),
      meanOutputTokens: average(records.map((record) => record.nativeCompaction.usage?.output ?? 0)),
      meanCostUsd: average(records.map((record) => record.nativeCompaction.usage?.cost.total ?? 0)),
      meanArtifactBytes: average(records.map((record) => record.nativeCompaction.artifactBytes)),
    },
    textSummary: {
      meanLatencyMs: average(records.map((record) => record.textSummary.latencyMs)),
      meanInputTokens: average(records.map((record) => record.textSummary.usage?.input ?? 0)),
      meanProcessedInputTokens: average(records.map((record) => {
        const value = record.textSummary.usage;
        return (value?.input ?? 0) + (value?.cacheRead ?? 0) + (value?.cacheWrite ?? 0);
      })),
      meanOutputTokens: average(records.map((record) => record.textSummary.usage?.output ?? 0)),
      meanCostUsd: average(records.map((record) => record.textSummary.usage?.cost.total ?? 0)),
      meanCharacters: average(records.map((record) => record.textSummary.characters)),
      meanNativeBudgetTokens: average(records.map((record) => record.nativeBudgetTokens)),
    },
    evaluation: Object.fromEntries(ARMS.map((arm) => [arm, {
      meanLatencyMs: average(records.map((record) => record.evaluations[arm].latencyMs)),
      meanInputTokens: average(records.map((record) => record.evaluations[arm].usage?.input ?? 0)),
      meanProcessedInputTokens: average(records.map((record) => {
        const value = record.evaluations[arm].usage;
        return (value?.input ?? 0) + (value?.cacheRead ?? 0) + (value?.cacheWrite ?? 0);
      })),
      meanOutputTokens: average(records.map((record) => record.evaluations[arm].usage?.output ?? 0)),
      meanCostUsd: average(records.map((record) => record.evaluations[arm].usage?.cost.total ?? 0)),
    }])),
    totalRecordedCostUsd: records.reduce((sum, record) => {
      return sum +
        (record.nativeCompaction.usage?.cost.total ?? 0) +
        (record.textSummary.usage?.cost.total ?? 0) +
        ARMS.reduce((armSum, arm) => armSum + (record.evaluations[arm].usage?.cost.total ?? 0), 0);
    }, 0),
  };

  const exactRealizedBudgetRecords = records.filter((record) =>
    (record.textSummary.usage?.output ?? -1) === record.nativeBudgetTokens);
  const exactRealizedBudget = {
    trials: exactRealizedBudgetRecords.length,
    native: aggregateScores(exactRealizedBudgetRecords.flatMap((record) => record.evaluations.native_compaction.scores)),
    text: aggregateScores(exactRealizedBudgetRecords.flatMap((record) => record.evaluations.text_summary.scores)),
    meanNativeDownstreamInputTokens: average(exactRealizedBudgetRecords.map((record) => {
      const value = record.evaluations.native_compaction.usage;
      return (value?.input ?? 0) + (value?.cacheRead ?? 0) + (value?.cacheWrite ?? 0);
    })),
    meanTextDownstreamInputTokens: average(exactRealizedBudgetRecords.map((record) => {
      const value = record.evaluations.text_summary.usage;
      return (value?.input ?? 0) + (value?.cacheRead ?? 0) + (value?.cacheWrite ?? 0);
    })),
  };

  const perFixture = Object.fromEntries([...new Set(records.map((record) => record.fixtureId))].map((fixtureId) => [
    fixtureId,
    Object.fromEntries(ARMS.map((arm) => [
      arm,
      aggregateScores(records.filter((record) => record.fixtureId === fixtureId).flatMap((record) => record.evaluations[arm].scores)),
    ])),
  ]));

  const summary = {
    manifest,
    completedTrials: records.length,
    byArm,
    byCategory,
    perFixture,
    pairedNativeVsText: {
      bothCorrect,
      nativeOnly,
      textOnly,
      bothWrong,
      exactMcNemarP: exactMcNemarP(nativeOnly, textOnly),
    },
    usage,
    exactRealizedBudget,
    disagreements,
  };
  await writeFile(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const csvRows = ["fixture,trial,arm,question_id,category,correct,expected,actual"];
  for (const record of records) {
    for (const arm of ARMS) {
      for (const score of record.evaluations[arm].scores) {
        const values = [record.fixtureId, record.trial, arm, score.questionId, score.category, score.correct, score.expected, score.actual];
        csvRows.push(values.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","));
      }
    }
  }
  await writeFile(join(runDir, "scores.csv"), `${csvRows.join("\n")}\n`);

  const categoryRows = categories.map((category) => {
    const values = byCategory[category] as Record<Arm, ReturnType<typeof aggregateScores>>;
    return `| ${category} | ${fmtPercent(values.full_context.accuracy)} | ${fmtPercent(values.native_compaction.accuracy)} | ${fmtPercent(values.text_summary.accuracy)} |`;
  }).join("\n");
  const report = `# Native vs. token-matched textual compaction: generated results\n\n` +
    `Run directory: \`${runDir}\`  \nModel: \`${manifest.model}\`  \n` +
    `Fixtures: ${manifest.fixtureCount}; trials per fixture: ${manifest.trials}; scored observations per arm: ${byArm.full_context.total}.\n\n` +
    `## Accuracy\n\n` +
    `| Arm | Correct | Accuracy | Descriptive Wilson 95% interval |\n|---|---:|---:|---:|\n` +
    ARMS.map((arm) => {
      const value = byArm[arm] as ReturnType<typeof aggregateScores>;
      return `| ${arm} | ${value.correct}/${value.total} | ${fmtPercent(value.accuracy)} | ${fmtPercent(value.wilson95[0])}–${fmtPercent(value.wilson95[1])} |`;
    }).join("\n") +
    `\n\n## Accuracy by category\n\n| Category | Full context | Native | Text summary |\n|---|---:|---:|---:|\n${categoryRows}\n\n` +
    `## Paired native vs. text outcomes\n\n` +
    `- Both correct: ${bothCorrect}\n- Native only correct: ${nativeOnly}\n- Text only correct: ${textOnly}\n- Both wrong: ${bothWrong}\n` +
    `- Exact McNemar/binomial p-value over repeated observations: ${summary.pairedNativeVsText.exactMcNemarP.toPrecision(4)}\n\n` +
    `## Compaction resource use (mean per paired trial)\n\n` +
    `| Measure | Native | Text |\n|---|---:|---:|\n` +
    `| Processed input tokens | ${fmtNumber(usage.nativeCompaction.meanProcessedInputTokens)} | ${fmtNumber(usage.textSummary.meanProcessedInputTokens)} |\n` +
    `| Output tokens | ${fmtNumber(usage.nativeCompaction.meanOutputTokens)} | ${fmtNumber(usage.textSummary.meanOutputTokens)} |\n` +
    `| Downstream evaluation input tokens | ${fmtNumber(usage.evaluation.native_compaction.meanProcessedInputTokens)} | ${fmtNumber(usage.evaluation.text_summary.meanProcessedInputTokens)} |\n` +
    `| Latency (ms) | ${fmtNumber(usage.nativeCompaction.meanLatencyMs)} | ${fmtNumber(usage.textSummary.meanLatencyMs)} |\n` +
    `| Cost (USD) | ${usage.nativeCompaction.meanCostUsd.toFixed(4)} | ${usage.textSummary.meanCostUsd.toFixed(4)} |\n\n` +
    `Recorded API cost across compaction, summarization, and evaluation: $${usage.totalRecordedCostUsd.toFixed(4)}.\n\n` +
    `## Exact-realized-budget sensitivity\n\n` +
    `${exactRealizedBudget.trials}/${records.length} text summaries consumed exactly the paired native output-token budget. ` +
    `Within those trials, native scored ${exactRealizedBudget.native.correct}/${exactRealizedBudget.native.total} ` +
    `and text scored ${exactRealizedBudget.text.correct}/${exactRealizedBudget.text.total}; mean downstream inputs were ` +
    `${fmtNumber(exactRealizedBudget.meanNativeDownstreamInputTokens)} and ${fmtNumber(exactRealizedBudget.meanTextDownstreamInputTokens)} tokens.\n\n` +
    `This generated document reports measurements only. Interpretive conclusions and limitations belong in the benchmark's standalone REPORT.md.\n`;
  await writeFile(join(runDir, "GENERATED_RESULTS.md"), report);
  console.log(report);
}

await main();
