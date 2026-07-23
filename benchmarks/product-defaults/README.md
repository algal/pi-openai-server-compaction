# Benchmark: Pi default compaction vs. extension-native compaction

This benchmark compares the two product policies without forcing either representation
to match the other's output-token count:

1. Pi 0.80.9's real default compaction prompt, cut point, 20K recent-token retention,
   and `reserveTokens` settings.
2. This extension's Responses compaction v2 request and its actual provider-native
   replay history, including retained user messages.
3. An uncompressed full-context control.

The fixture generator holds estimated pre-compaction context near a fixed target while
varying the number of independent authoritative records. It replaces unrelated filler
with exact state rather than making harder trials proportionally longer. Questions are
selected deterministically across categories and history epochs, but are introduced
only after compaction.

## Retained reference run

The corrected 2026-07-23 held-out run used Pi's default medium thinking level,
densities 180 and 200, and fresh seeds 301–304:

- Full context: 600/600 (100.0%)
- Pi default: 288/600 (48.0%)
- Extension-native: 468/600 (78.0%)

Native used 4.58x as many mean compaction output tokens and 1.29x as many
downstream input tokens as Pi. Native results were bimodal: five artifacts over
10K output tokens scored perfectly, while three artifacts under 5K did not beat
Pi consistently. Read [REPORT.md](REPORT.md) for the interpretation and
[CALIBRATION.md](CALIBRATION.md) for the density-selection trace. Primary
machine records are retained under
`final-results/2026-07-23_product-defaults-medium_gpt-5.6-sol/`.

An earlier non-medium run exposed a harness fidelity error before final
reporting. Its raw bundle is intentionally excluded from the published
evidence.

## Offline checks

Node 22 or newer is required.

```bash
node --experimental-strip-types benchmarks/product-defaults/self-test.ts
npx tsc -p benchmarks/product-defaults/tsconfig.json
```

## Calibration

Use calibration-only seeds and a modest cost guard:

```bash
node --experimental-strip-types benchmarks/product-defaults/run.ts \
  --label calibration-medium \
  --seeds 111 \
  --densities 120,160,200 \
  --target-tokens 50000 \
  --max-cost-usd 8
```

Analyze the completed trials:

```bash
node --experimental-strip-types benchmarks/product-defaults/analyze.ts \
  benchmarks/product-defaults/results/<run-directory>
```

Choose a shoulder and stress density from calibration, lock them, and use disjoint
held-out seeds for the confirmatory run. Do not use calibration scores in the final
inferential totals.

## Confirmatory template

```bash
node --experimental-strip-types benchmarks/product-defaults/run.ts \
  --label confirmatory-medium \
  --seeds 301,302,303,304 \
  --densities 180,200 \
  --target-tokens 50000 \
  --max-cost-usd 20
```

The cost guard is evaluated between fixtures. A single in-flight fixture can take the
recorded total slightly past the configured guard.

## Interpretation

The primary comparison answers which default product policy preserves more state and
reports the resource footprint each policy naturally chooses. It is not an
equal-information-capacity claim: native token accounting remains opaque.

A later diagnostic Pi budget sweep can plot Pi accuracy against downstream footprint
and overlay native's realized points. Its budgets must be predeclared independently,
not copied from a paired native response. That secondary sweep must explicitly tell
the text compactor its numeric budget and record length-stop responses.
