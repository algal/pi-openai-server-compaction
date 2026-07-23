#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProductTrialRecord } from "./run.ts";

type Arm = "full_context" | "pi_default" | "native_extension";

const ARMS: Arm[] = ["full_context", "pi_default", "native_extension"];

type Score = ProductTrialRecord["evaluations"][Arm]["scores"][number];
type RunManifest = {
  label?: string;
  seeds?: number[];
  densities?: number[];
  defaultThinkingLevel?: string;
  nativeRequestTuning?: string;
};

function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function aggregate(scores: Score[]): {
  correct: number;
  total: number;
  accuracy: number;
} {
  const correct = scores.filter((score) => score.correct).length;
  return {
    correct,
    total: scores.length,
    accuracy: scores.length === 0 ? 0 : correct / scores.length,
  };
}

function processedTokens(usage: ProductTrialRecord["piDefault"]["usage"]): number {
  return usage
    ? usage.input + usage.cacheRead + usage.cacheWrite
    : 0;
}

function fmtPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function armScores(records: ProductTrialRecord[], arm: Arm): Score[] {
  return records.flatMap((record) => record.evaluations[arm].scores);
}

function chooseDensity(
  byDensity: Record<string, {
    arms: Record<Arm, ReturnType<typeof aggregate>>;
  }>,
  target: number,
  excluded?: number,
): number | undefined {
  const eligible = Object.entries(byDensity)
    .map(([density, value]) => ({
      density: Number(density),
      full: value.arms.full_context.accuracy,
      best: Math.max(value.arms.pi_default.accuracy, value.arms.native_extension.accuracy),
    }))
    .filter((value) => value.full >= 0.98 && value.density !== excluded)
    .sort((left, right) => {
      const leftDistance = Math.abs(left.best - target);
      const rightDistance = Math.abs(right.best - target);
      return leftDistance - rightDistance || left.density - right.density;
    });
  return eligible[0]?.density;
}

async function main(): Promise<void> {
  const directory = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) {
    throw new Error("Usage: analyze.ts <product-defaults-run-directory>");
  }
  const manifest = JSON.parse(
    await readFile(join(directory, "manifest.json"), "utf8"),
  ) as RunManifest;
  const runLabel = manifest.label ?? "unspecified";
  const isCalibration = runLabel.toLowerCase().includes("calibration");
  const isDiscarded = runLabel.toLowerCase().includes("discard");
  const records = (await readFile(join(directory, "trials.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ProductTrialRecord);
  if (records.length === 0) throw new Error(`No records in ${directory}`);

  const densities = [...new Set(records.map((record) => record.density))].sort((a, b) => a - b);
  const categories = [
    ...new Set(records.flatMap((record) =>
      ARMS.flatMap((arm) => record.evaluations[arm].scores.map((score) => score.category))
    )),
  ].sort();
  const epochs = [
    ...new Set(records.flatMap((record) =>
      ARMS.flatMap((arm) => record.evaluations[arm].scores.map((score) => score.epoch))
    )),
  ].sort((a, b) => a - b);

  const byArm = Object.fromEntries(
    ARMS.map((arm) => [arm, aggregate(armScores(records, arm))]),
  ) as Record<Arm, ReturnType<typeof aggregate>>;
  const byDensity = Object.fromEntries(
    densities.map((density) => {
      const selected = records.filter((record) => record.density === density);
      const arms = Object.fromEntries(
        ARMS.map((arm) => [arm, aggregate(armScores(selected, arm))]),
      ) as Record<Arm, ReturnType<typeof aggregate>>;
      return [density, {
        trials: selected.length,
        arms,
        meanEstimatedInputTokens: average(selected.map((record) => record.estimatedTokens)),
        meanAuthoritativeRecords: average(selected.map((record) => record.authoritativeRecords)),
        meanRecordedCostUsd: average(selected.map((record) => record.recordedCostUsd)),
      }];
    }),
  );
  const byCategory = Object.fromEntries(
    categories.map((category) => [
      category,
      Object.fromEntries(ARMS.map((arm) => [
        arm,
        aggregate(armScores(records, arm).filter((score) => score.category === category)),
      ])),
    ]),
  );
  const byEpoch = Object.fromEntries(
    epochs.map((epoch) => [
      epoch,
      Object.fromEntries(ARMS.map((arm) => [
        arm,
        aggregate(armScores(records, arm).filter((score) => score.epoch === epoch)),
      ])),
    ]),
  );

  let nativeOnly = 0;
  let piOnly = 0;
  let bothCorrect = 0;
  let bothWrong = 0;
  for (const record of records) {
    const pi = new Map(record.evaluations.pi_default.scores.map((score) => [score.questionId, score.correct]));
    for (const native of record.evaluations.native_extension.scores) {
      const piCorrect = pi.get(native.questionId) ?? false;
      if (piCorrect && native.correct) bothCorrect++;
      else if (native.correct) nativeOnly++;
      else if (piCorrect) piOnly++;
      else bothWrong++;
    }
  }

  const resources = {
    piDefault: {
      meanCompactionInputTokens: average(records.map((record) => processedTokens(record.piDefault.usage))),
      meanCompactionOutputTokens: average(records.map((record) => record.piDefault.usage?.output ?? 0)),
      meanCompactionCostUsd: average(records.map((record) => record.piDefault.usage?.cost.total ?? 0)),
      meanSummaryCharacters: average(records.map((record) => record.piDefault.summaryCharacters)),
      lengthStoppedTrials: records.filter((record) => record.piDefault.stopReason === "length").length,
      meanDownstreamInputTokens: average(
        records.map((record) => processedTokens(record.evaluations.pi_default.usage)),
      ),
      meanDownstreamCostUsd: average(
        records.map((record) => record.evaluations.pi_default.usage?.cost.total ?? 0),
      ),
    },
    nativeExtension: {
      meanCompactionInputTokens: average(records.map((record) => processedTokens(record.nativeExtension.usage))),
      meanCompactionOutputTokens: average(records.map((record) => record.nativeExtension.usage?.output ?? 0)),
      meanCompactionCostUsd: average(records.map((record) => record.nativeExtension.usage?.cost.total ?? 0)),
      meanArtifactBytes: average(records.map((record) => record.nativeExtension.artifactBytes)),
      meanRetainedUserMessageItems: average(records.map((record) => record.nativeExtension.retainedUserMessageItems)),
      meanDownstreamInputTokens: average(
        records.map((record) => processedTokens(record.evaluations.native_extension.usage)),
      ),
      meanDownstreamCostUsd: average(
        records.map((record) => record.evaluations.native_extension.usage?.cost.total ?? 0),
      ),
    },
    fullContext: {
      meanDownstreamInputTokens: average(
        records.map((record) => processedTokens(record.evaluations.full_context.usage)),
      ),
      meanDownstreamCostUsd: average(
        records.map((record) => record.evaluations.full_context.usage?.cost.total ?? 0),
      ),
    },
    totalRecordedCostUsd: records.reduce((total, record) => total + record.recordedCostUsd, 0),
  };
  const resourceComparison = {
    nativeToPiCompactionOutputRatio: ratio(
      resources.nativeExtension.meanCompactionOutputTokens,
      resources.piDefault.meanCompactionOutputTokens,
    ),
    nativeToPiCompactionCostRatio: ratio(
      resources.nativeExtension.meanCompactionCostUsd,
      resources.piDefault.meanCompactionCostUsd,
    ),
    nativeToPiDownstreamInputRatio: ratio(
      resources.nativeExtension.meanDownstreamInputTokens,
      resources.piDefault.meanDownstreamInputTokens,
    ),
    nativeMinusPiAccuracyPoints:
      100 * (byArm.native_extension.accuracy - byArm.pi_default.accuracy),
  };

  const shoulderDensity = isCalibration ? chooseDensity(byDensity, 0.935) : undefined;
  const stressDensity = isCalibration
    ? chooseDensity(byDensity, 0.75, shoulderDensity)
    : undefined;
  const recommendation = isCalibration
    ? {
        shoulderTargetBestArmAccuracy: 0.935,
        stressTargetBestArmAccuracy: 0.75,
        shoulderDensity,
        stressDensity,
        caveat:
          "Calibration selections are heuristic. Lock densities before evaluating held-out confirmatory seeds.",
      }
    : null;

  const summary = {
    directory,
    runLabel,
    defaultThinkingLevel: manifest.defaultThinkingLevel ?? "not recorded",
    nativeRequestTuning: manifest.nativeRequestTuning ?? "not recorded",
    primaryEligible: !isCalibration && !isDiscarded,
    trials: records.length,
    independentSeeds: [...new Set(records.map((record) => record.seed))].length,
    densities,
    byArm,
    byDensity,
    byCategory,
    byEpoch,
    pairedNativeVsPi: { bothCorrect, nativeOnly, piOnly, bothWrong },
    resources,
    resourceComparison,
    recommendation,
  };
  await writeFile(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

  const densityRows = densities.map((density) => {
    const value = byDensity[String(density)]!;
    return (
      `| ${density} | ${value.trials} | ${fmtNumber(value.meanEstimatedInputTokens)} | ` +
      `${fmtNumber(value.meanAuthoritativeRecords)} | ` +
      `${fmtPercent(value.arms.full_context.accuracy)} | ` +
      `${fmtPercent(value.arms.pi_default.accuracy)} | ` +
      `${fmtPercent(value.arms.native_extension.accuracy)} | ` +
      `$${value.meanRecordedCostUsd.toFixed(3)} |`
    );
  }).join("\n");
  const categoryRows = categories.map((category) => {
    const value = byCategory[category] as Record<Arm, ReturnType<typeof aggregate>>;
    return (
      `| ${category} | ${fmtPercent(value.full_context.accuracy)} | ` +
      `${fmtPercent(value.pi_default.accuracy)} | ${fmtPercent(value.native_extension.accuracy)} |`
    );
  }).join("\n");
  const epochRows = epochs.map((epoch) => {
    const value = byEpoch[String(epoch)] as Record<Arm, ReturnType<typeof aggregate>>;
    return (
      `| ${epoch} | ${fmtPercent(value.full_context.accuracy)} | ` +
      `${fmtPercent(value.pi_default.accuracy)} | ${fmtPercent(value.native_extension.accuracy)} |`
    );
  }).join("\n");
  const trialRows = [...records]
    .sort((left, right) => left.density - right.density || left.seed - right.seed)
    .map((record) => {
      const full = aggregate(record.evaluations.full_context.scores);
      const pi = aggregate(record.evaluations.pi_default.scores);
      const native = aggregate(record.evaluations.native_extension.scores);
      return (
        `| ${record.seed} | ${record.density} | ${full.correct}/${full.total} | ` +
        `${pi.correct}/${pi.total} | ${native.correct}/${native.total} | ` +
        `${fmtNumber(record.piDefault.usage?.output ?? 0)} | ` +
        `${fmtNumber(record.nativeExtension.usage?.output ?? 0)} |`
      );
    }).join("\n");
  const overallRows = ARMS.map((arm) => {
    const value = byArm[arm];
    return `| ${arm} | ${value.correct}/${value.total} | ${fmtPercent(value.accuracy)} |`;
  }).join("\n");
  const runRoleSection = isCalibration
    ? (
        `## Calibration recommendation\n\n` +
        `- Shoulder density: ${shoulderDensity ?? "not identified"}\n` +
        `- Stress density: ${stressDensity ?? "not identified"}\n\n` +
        `Selections are heuristic and must be locked before held-out confirmatory seeds are run.\n`
      )
    : isDiscarded
      ? (
          `## Run role\n\n` +
          `This run is discarded and must not be included in the primary totals. ` +
          `It is retained only as an audit trail.\n`
        )
      : (
        `## Run role\n\n` +
        `This is a ${runLabel} run. Density selection is not recomputed from these scores; ` +
        `the recorded densities are treated as locked.\n`
      );
  const statusNotice = isDiscarded
    ? (
        `> **Discarded:** this run used a non-default reasoning setting and is not ` +
        `part of the reported primary result.\n\n`
      )
    : "";
  const generated =
    `# Pi default vs. extension-native compaction: generated results\n\n` +
    statusNotice +
    `Run label: ${runLabel}. Trials: ${records.length}; independent seeds: ` +
    `${summary.independentSeeds}; default thinking level: ${summary.defaultThinkingLevel}; ` +
    `recorded API cost: $${resources.totalRecordedCostUsd.toFixed(4)}.\n\n` +
    `## Overall exact accuracy\n\n` +
    `| Arm | Correct | Accuracy |\n|---|---:|---:|\n${overallRows}\n\n` +
    `## Accuracy by density\n\n` +
    `| Density per category | Trials | Estimated input tokens | Authoritative records | Full | Pi default | Native extension | Mean trial cost |\n` +
    `|---:|---:|---:|---:|---:|---:|---:|---:|\n${densityRows}\n\n` +
    `## Overall accuracy by category\n\n` +
    `| Category | Full | Pi default | Native extension |\n|---|---:|---:|---:|\n${categoryRows}\n\n` +
    `## Accuracy by history epoch\n\n` +
    `Epoch 0 is oldest and epoch 9 is newest.\n\n` +
    `| Epoch | Full | Pi default | Native extension |\n|---:|---:|---:|---:|\n${epochRows}\n\n` +
    `## Per-fixture scores and compaction output\n\n` +
    `| Seed | Density | Full | Pi default | Native extension | Pi output tokens | Native output tokens |\n` +
    `|---:|---:|---:|---:|---:|---:|---:|\n${trialRows}\n\n` +
    `## Paired Pi/native outcomes\n\n` +
    `- Both correct: ${bothCorrect}\n` +
    `- Native only correct: ${nativeOnly}\n` +
    `- Pi only correct: ${piOnly}\n` +
    `- Both wrong: ${bothWrong}\n\n` +
    `## Mean resource use\n\n` +
    `| Measure | Pi default | Native extension |\n|---|---:|---:|\n` +
    `| Compaction input tokens | ${fmtNumber(resources.piDefault.meanCompactionInputTokens)} | ${fmtNumber(resources.nativeExtension.meanCompactionInputTokens)} |\n` +
    `| Compaction output tokens | ${fmtNumber(resources.piDefault.meanCompactionOutputTokens)} | ${fmtNumber(resources.nativeExtension.meanCompactionOutputTokens)} |\n` +
    `| Compaction cost | $${resources.piDefault.meanCompactionCostUsd.toFixed(4)} | $${resources.nativeExtension.meanCompactionCostUsd.toFixed(4)} |\n` +
    `| Downstream input tokens | ${fmtNumber(resources.piDefault.meanDownstreamInputTokens)} | ${fmtNumber(resources.nativeExtension.meanDownstreamInputTokens)} |\n` +
    `| Downstream request cost | $${resources.piDefault.meanDownstreamCostUsd.toFixed(4)} | $${resources.nativeExtension.meanDownstreamCostUsd.toFixed(4)} |\n\n` +
    `Native used ${resourceComparison.nativeToPiCompactionOutputRatio?.toFixed(2) ?? "n/a"}x ` +
    `Pi's compaction output tokens and ` +
    `${resourceComparison.nativeToPiDownstreamInputRatio?.toFixed(2) ?? "n/a"}x its downstream input tokens. ` +
    `Pi length-stopped in ${resources.piDefault.lengthStoppedTrials} trial(s).\n\n` +
    runRoleSection;
  await writeFile(join(directory, "GENERATED_RESULTS.md"), generated);
  console.log(generated);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
