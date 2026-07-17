# Does OpenAI native compaction preserve context better than a textual summary?

## Executive summary

This experiment compared OpenAI Responses compaction v2 with a conventional textual continuation summary on long synthetic software-project conversations. The same `openai/gpt-5.6-sol` model produced both representations and answered the same hidden-after-compaction questions. The textual summary's per-trial output cap was set to the native compaction pass's reported output-token count. A full-context arm established that every question was answerable.

**Result:** native compaction preserved all tested state in this experiment. It answered **900/900 (100%)** questions correctly, equal to the uncompressed full-context control. The balanced textual summary answered **745/900 (82.8%)**. There were 155 paired observations where only native was correct and none where only text was correct.

The result is not explained by giving native more downstream context. In the 11 of 12 balanced-summary trials that consumed exactly the native output budget, mean downstream input was **8,770.6 tokens for native and 8,790.4 for text**; native scored **825/825**, while text scored **670/825**. A second, deliberately dense task-first summary consumed the exact native budget in all 12 trials and had a slightly larger downstream footprint than native (8,856.8 versus 8,836.1 tokens), yet scored **690/900 (76.7%)**.

The evidence therefore supports this limited conclusion:

> For GPT-5.6 Sol on these information-preservation tasks, Responses native compaction preserved substantially more usable state than either tested textual summary at essentially the same downstream context footprint.

It does **not** establish that the opaque artifact is a latent-space representation. An encrypted, model-optimized textual or structured representation remains a sufficient explanation.

## Research question

When a long conversation is compressed before future questions are known, does OpenAI's opaque native compaction artifact preserve more downstream-useful information than a token-budget-matched plaintext summary?

The intended comparison is behavioral. The benchmark does not inspect or attempt to decrypt the native artifact.

## Experimental design

### Model and API

- Model: `openai/gpt-5.6-sol`
- Native mechanism: Responses compaction v2, invoked with a trailing `compaction_trigger`
- Compression reasoning effort: `none` in both arms
- Evaluation reasoning effort: `low` in all arms
- Ordinary Responses requests: `store: false`
- Run date recorded by the harness: 2026-07-17

### Conditions

Each trial evaluated three primary conditions:

1. **Full context:** the original history and a shared recent tail.
2. **Native compaction:** only the opaque native `compaction` item and the same shared tail.
3. **Balanced text summary:** a plaintext continuation summary and the same shared tail.

The extension's additional retained-user-message behavior was deliberately excluded. The benchmark selected only the native compaction item, then supplied an identical explicit tail to native and text. This isolates the compressed representation rather than confounding it with different retention policies.

A supplementary fourth condition tested prompt sensitivity:

4. **Dense task-first text summary:** a semicolon-delimited state dump instructed to preserve current tasks and corrections before tools, relationships, and early exact facts.

### Budget matching

For every paired trial:

```text
text max_output_tokens = native compaction reported output_tokens
```

This is the closest output-budget match exposed by the API. Eleven of twelve balanced summaries used the entire cap; one stopped early. The dense variant used the entire cap in all twelve trials.

Downstream input usage provides an independent check. For exact-realized-budget balanced trials, native and text differed by only 19.7 tokens on average (0.22%). The dense arm's mean downstream input was 20.8 tokens larger than native's (also about 0.24%).

### Fixtures

Six independently seeded fixtures were run twice, producing 12 paired trials. Each fixture contained:

- roughly 35,000 processed input tokens;
- hundreds of Responses items, including user/assistant turns and function call/output pairs;
- 165 unrelated archival distractor exchanges;
- 325 authoritative candidate state items across five categories;
- explicit provisional values followed by final corrections;
- a shared recent tail containing no answers;
- 75 questions selected before the run but introduced only after compaction.

Identifier payloads were deterministically derived from SHA-256. This prevents a model from reconstructing an omitted value by extrapolating an arithmetic sequence. Complete generated histories and expected answers are retained in `fixtures.json`.

### Question categories

There were 15 questions per category per fixture:

- **Exact recall:** exact codes, ports, paths, checksums, owners, and parameter values.
- **Relational state:** directed dependency/routing edges, deployment region, reporting, and vault location.
- **Tool history:** exact read, test, edit, query, deploy, and probe outputs.
- **Distractor resolution:** final values after explicit replacement of obsolete candidates.
- **Task continuation:** done, in-progress, blocked, queued, and verifying work; blocker and next action.

The compactors did not receive the questions. They had to decide what to retain without knowing which 75 of the 325 authoritative state items would be probed.

### Scoring

The evaluator returned a strict JSON-schema object containing one string per question. A deterministic scorer compared each answer with its expected canonical string. No LLM judge was used.

Full context scored 900/900, confirming that the generated questions were answerable and the evaluator could follow the requested format when the evidence was present.

The full/text evaluation order alternated by trial; native remained the middle evaluation. This controls some order drift but is not a complete randomization.

## Primary results

### Overall exact accuracy

| Condition | Correct | Accuracy | Descriptive Wilson 95% interval |
|---|---:|---:|---:|
| Full context | 900/900 | 100.0% | 99.6%–100.0% |
| Native compaction | 900/900 | 100.0% | 99.6%–100.0% |
| Balanced text summary | 745/900 | 82.8% | 80.2%–85.1% |
| Dense task-first text | 690/900 | 76.7% | not used for confirmatory inference |

### Primary accuracy by category

| Category | Full context | Native | Balanced text |
|---|---:|---:|---:|
| Exact recall | 180/180 (100.0%) | 180/180 (100.0%) | 180/180 (100.0%) |
| Relational state | 180/180 (100.0%) | 180/180 (100.0%) | 180/180 (100.0%) |
| Tool history | 180/180 (100.0%) | 180/180 (100.0%) | 169/180 (93.9%) |
| Distractor resolution | 180/180 (100.0%) | 180/180 (100.0%) | 152/180 (84.4%) |
| Task continuation | 180/180 (100.0%) | 180/180 (100.0%) | 64/180 (35.6%) |

### Paired outcomes

For the 900 native/text question pairs:

- both correct: 745;
- native only correct: 155;
- text only correct: 0;
- both wrong: 0.

The exact McNemar/binomial calculation over question observations gives `p = 4.379e-47`. That number should be treated as descriptive rather than a confirmatory population-level p-value because questions within a fixture and repeated trials over the same fixture are correlated.

At the coarser fixture level, native scored 150/150 in every fixture. Balanced text scored between 108/150 and 144/150 and was lower in all six fixtures.

### Exact-realized-budget sensitivity

One balanced summary stopped before reaching its cap. Excluding it leaves 11 trials where native and text consumed exactly the same reported output-token budget:

| Measure | Native | Balanced text |
|---|---:|---:|
| Correct | 825/825 (100.0%) | 670/825 (81.2%) |
| Mean downstream input tokens | 8,770.6 | 8,790.4 |

Thus, the primary gap survives after removing the only trial with lower realized text output.

## Stronger textual-summary sensitivity

The balanced prompt asked for exact identifiers, relationships, tools, corrections, and task state without prescribing section order. Its main failure mode was loss of late corrections and task state when generation reached its cap.

To test whether that was merely poor ordering, a second prompt required a dense format and prioritized:

1. current task state;
2. final corrections;
3. tool results;
4. relationships;
5. early exact facts.

This variant consumed the exact native output budget in all 12 trials and had a slightly **larger** downstream context footprint than native. Its results were:

| Category | Dense task-first text |
|---|---:|
| Exact recall | 27/180 (15.0%) |
| Relational state | 123/180 (68.3%) |
| Tool history | 180/180 (100.0%) |
| Distractor resolution | 180/180 (100.0%) |
| Task continuation | 180/180 (100.0%) |
| **Overall** | **690/900 (76.7%)** |

Prompt engineering moved the loss rather than eliminating it. Balanced text preserved early exact and relational state but often lost late task state; task-first text preserved late state but discarded early facts and some relationships. Native retained all tested categories simultaneously.

This sensitivity arm is important evidence that the primary result is not solely caused by neglecting to tell the summarizer that tasks matter.

## Resource use

Mean per primary paired trial:

| Measure | Native compaction | Balanced text summary |
|---|---:|---:|
| Processed compression input tokens | 34,926.2 | 35,273.2 |
| Compression output tokens | 5,939.9 | 5,842.4 |
| Downstream evaluation input tokens | 8,836.1 | 8,758.2 |
| Compression latency | 48.48 s | 47.76 s |
| Compression API cost | $0.3964 | $0.2723 |

The uncompressed evaluation used 37,608.3 processed input tokens on average. Native reduced the subsequent evaluation footprint to 23.5% of full context, roughly a 4.3× reduction, without a measured accuracy loss.

Native compaction cost about 46% more than balanced text generation in these recorded calls, largely because its input was billed through cache-write accounting. Subsequent native and text evaluation costs were nearly equal (about $0.091 per request).

Recorded API cost was:

- primary run: $12.0264;
- dense textual sensitivity: approximately $4.3665;
- total retained evidentiary run: approximately **$16.39**.

## Examples of grounded disagreements

These are taken directly from `summary.json`; native returned the expected value in every case.

| Category | Expected | Balanced text answer |
|---|---|---|
| Tool history | `tool-result-hidden-keystone-6432793ff006` | `unknown` |
| Distractor resolution | `final-frozen-nebula-5dab66533fd3` | empty string |
| Task continuation | `schema-1-migration` | empty string |
| Task continuation | `backfill-project-1` | empty string |

The complete set of 155 disagreements, including fixture, trial, expected answer, and both actual answers, is in `summary.json`. Flattened scores are in `scores.csv`.

## Interpretation

### What the experiment supports

The native artifact behaved as a more effective continuation representation than either plaintext strategy tested. At nearly identical downstream token footprints it avoided the allocation tradeoff visible in textual summaries: it preserved early exact state, structured relationships, tool outcomes, corrected values, and late task state together.

This is practically relevant to long coding-agent sessions. A prose summary has to spend visible tokens deciding what to omit and how to order what remains. The native mechanism appears able to preserve more recoverable state under the model's own continuation protocol.

### What it does not support

The result does not reveal the artifact's internal ontology. In particular, it does not prove that OpenAI stores a continuous latent state rather than text. Plausible alternatives include:

- encrypted optimized text not intended for human readability;
- a compact structured record;
- model-specific control tokens or serialized state;
- a hybrid of summaries, selected original spans, and metadata.

The correct claim is behavioral: **the opaque representation preserved more usable information in this test**.

## Limitations

1. **Synthetic workload.** The fixtures are designed to measure information retention cleanly. They are not a substitute for real repository work, code edits, or open-ended design continuation.
2. **One model and provider.** Only direct OpenAI GPT-5.6 Sol was measured. Results may differ for other effort tiers, models, or the `openai-codex` provider.
3. **Two textual prompts.** The space of possible plaintext compressors is unlimited. These were a balanced high-recall prompt and a deliberately dense task-first prompt, not a proof that no textual strategy can match native.
4. **Not Pi's exact default prompt.** The balanced arm is a controlled generic continuation summary, not a byte-for-byte invocation of Pi's current compaction implementation. It avoids some Pi-specific truncation, so it should not be read as a direct benchmark of one Pi release.
5. **Budget observability.** Native `output_tokens` is the best available matching signal, but the API does not expose the decrypted artifact's semantic capacity. Downstream input-token matching substantially reduces, but cannot remove, this uncertainty.
6. **Correlated observations.** Questions within fixtures and two trials over the same fixture are not independent. The tiny question-level p-value overstates the effective sample size.
7. **No repeated-compaction chain.** Every trial performed one compaction. Accumulated degradation after several compactions remains unmeasured.
8. **Same-model consumption.** GPT-5.6 Sol generated and consumed each representation. Native artifacts may rely on model-specific conventions and may not transfer.
9. **Evaluation order.** Native was always evaluated between the other two primary arms; only full versus text order alternated.

## Reproducibility and evidence map

Reference run directory:

```text
benchmarks/native-vs-text/final-results/2026-07-17T01-51-59-774Z_gpt-5.6-sol/
```

Files:

- `manifest.json` — prespecified run dimensions and budget rule.
- `fixtures.json` — complete histories, SHA-256-derived facts, questions, and expected answers.
- `trials.jsonl` — per-trial balanced summaries, response IDs, token usage, latency, answers, and exact scores.
- `scores.csv` — all 2,700 primary arm/question score rows.
- `summary.json` — aggregate results, category results, costs, per-fixture scores, and all paired disagreements.
- `GENERATED_RESULTS.md` — tables generated directly from trial records.
- `dense-text-trials.jsonl` — dense prompt outputs, usage, answers, and scores.
- `dense-text-summary.json` — dense sensitivity aggregates and the exact prompt.

Encrypted native contents are intentionally absent. Each trial records only the artifact's SHA-256 and byte length, which is sufficient to identify the response without publishing opaque ciphertext.

Implementation:

- `fixtures.ts` — deterministic fixture generator.
- `run.ts` — native/text/full paired runner.
- `run-dense-text-variant.ts` — stronger textual sensitivity arm.
- `analyze.ts` — exact scoring and aggregate analysis.
- `self-test.ts` — fixture invariants.

Reproduction commands and environment requirements are in `README.md`.

## Bottom line

Within the tested regime, native Responses compaction was not merely equivalent to a well-prompted textual summary. It retained every probed item while matched-size textual summaries exhibited substantial and prompt-dependent forgetting. That is strong evidence for using native compaction when continuity quality matters and the session will remain on a compatible OpenAI model/provider.

The remaining reasons to retain Pi's plaintext fallback are portability, inspectability, provider switching, and failure recovery—not superior measured recall in this experiment.
