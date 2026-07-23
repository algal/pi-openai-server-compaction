# Pi default compaction vs. extension-native compaction

## Executive result

On the corrected held-out run, the extension's native Responses compaction
policy preserved substantially more exact project state than Pi's default text
compaction policy:

| Arm | Correct | Exact accuracy |
|---|---:|---:|
| Full context control | 600/600 | 100.0% |
| Pi default compaction | 288/600 | 48.0% |
| Extension-native compaction | 468/600 | 78.0% |

The paired outcomes were 262 both correct, 206 native-only correct, 26 Pi-only
correct, and 106 both wrong. Native's aggregate advantage was 30.0 percentage
points, and native won when results were aggregated within each of the four
held-out seeds.

This is a product-default comparison, not a same-budget comparison. Native
compaction naturally emitted 4.58 times as many output tokens and left a 29%
larger billed downstream context:

| Mean per fixture | Pi default | Extension-native | Native/Pi |
|---|---:|---:|---:|
| Compaction input tokens | 39,047 | 67,519 | 1.73x |
| Compaction output tokens | 3,103 | 14,212 | 4.58x |
| Compaction cost | $0.3371 | $0.8483 | 2.52x |
| Evaluation input tokens | 32,969 | 42,691 | 1.29x |
| Evaluation request cost | $0.2536 | $0.3278 | 1.29x |

None of Pi's eight summaries stopped for length. Pi was therefore not truncated
to native's realized size; it ended its default summaries naturally. The result
supports “the native default policy preserved more state on these tasks,” but it
does not support “native is better at the same budget” or “native has a more
efficient representation.”

There is also a major reliability qualification. All five native artifacts
larger than 10K reported output tokens scored 75/75. The three artifacts smaller
than 5K scored 39/75, 26/75, and 28/75. The endpoint's default output allocation
was bimodal in this small run, so the 78% aggregate describes a high-variance
policy rather than uniformly superior compactions.

## Claim map: what is known and what is not

Several distinct comparisons can otherwise collapse into the phrase “Codex
compaction is better”:

| Question | What this experiment says | Status |
|---|---|---|
| Does the extension's default Codex-style native policy beat Pi's default policy? | Yes in this tested regime: 78.0% versus 48.0%, with native ahead in every held-out seed aggregate. | Directly tested |
| Does the actual Codex CLI default beat Pi's default? | Probably, if this extension faithfully reproduces the relevant Codex request, retention, and replay policy. The benchmark did not run the Codex CLI itself. | Inference, not direct test |
| Does the native default spend more resources? | Yes: 4.58x compaction output, 2.52x compaction cost, and 1.29x downstream input on average. | Directly measured |
| Is native's aggregate advantage concentrated in its larger artifacts? | Yes. Every large artifact was perfect; the small artifacts were slightly worse than their paired Pi results in aggregate. | Directly observed, post-hoc grouping |
| Does the endpoint reliably recognize when content needs a longer artifact? | Unknown. Identical-length, similarly structured fixtures received very different allocations, and three difficult fixtures received short, poor artifacts. | Not established |
| Does processing the full history cause the advantage? | Unknown. Full-history input is bundled with different prompts, representation, retention, server behavior, and output allocation. | Not isolated |
| Is native more accurate at equal tokens or equal cost? | Unknown. This experiment intentionally lets both default policies choose their natural footprints. | Not tested |

“Default Codex” should therefore be read carefully in this report. The directly
measured native arm is this extension's best reconstruction of Codex-style
Responses compaction, not an end-to-end invocation of the Codex CLI. Any claim
about Codex itself inherits the assumption that the reconstruction captures all
material harness behavior.

The relationship between allocation and accuracy is especially important. A
descriptive split at the large gap in observed native artifact sizes gives:

| Native allocation group | Native accuracy | Paired Pi accuracy | Mean native downstream input | Mean Pi downstream input |
|---|---:|---:|---:|---:|
| Three artifacts below 5K output tokens | 93/225 (41.3%) | 110/225 (48.9%) | 31.8K | 32.8K |
| Five artifacts above 10K output tokens | 375/375 (100.0%) | 178/375 (47.5%) | 49.3K | 33.1K |

Thus all of native's net aggregate advantage came from the large-allocation
group. This is strong evidence that resource allocation is a major part of the
observed product-policy result. It is not proof that token count itself caused
the improvement: artifact size could also be a marker that the opaque process
successfully understood or represented the history.

The strongest supported mechanism statement is:

> The native default is willing and able to produce much larger artifacts than
> Pi's default summaries, and those large-artifact runs performed much better.

The stronger statement “native adaptively chooses a longer artifact whenever
the content needs one” is not supported. Testing that requires repeated
compactions of identical fixtures to separate content-dependent allocation
from run-to-run randomness.

## Why this follow-up was needed

The earlier benchmark set each text summary's `max_output_tokens` after observing
the paired native compaction request's reported output-token count. That is a
real asymmetry: native first selected its own realized size, while the text arm
was subsequently prohibited from exceeding that size. Matching the final billed
footprint does not remove the post-treatment cap. The older run remains useful
historical evidence, but its claimed same-budget interpretation is superseded.

This follow-up asks a cleaner primary question:

> If a user chooses Pi's default compactor or this extension's native compactor,
> with each product allowed to apply its own actual default policy, which one
> preserves more usable state, and what resources does each policy consume?

No output-token budget was transferred from one arm to the other.

## Experimental design

### Arms

The harness compared:

1. **Pi default:** Pi 0.80.9's pinned `prepareCompaction` and `compact`
   implementation, default `reserveTokens: 16384`, default
   `keepRecentTokens: 20000`, default thinking level `medium`, default
   compaction prompt, and real post-compaction session context.
2. **Extension-native:** the extension's
   `callRemoteCompactionEndpoint` implementation, the default Pi Responses
   request shape (`reasoning` medium with summary auto and no explicit text
   configuration), Responses compaction v2, and the actual replay output,
   including retained user-message items.
3. **Full context:** the original uncompressed history, used as an answerability
   control.

Native's compactor receives the full branch. Pi's summary model receives the
older prefix chosen by Pi's cut-point policy, while Pi passes roughly 20K recent
tokens through verbatim. Consequently, native's larger compaction input does
not mean Pi's final evaluation context simply lacks the recent tail; it is a
difference in how the policies divide and process the same original history.

The same `openai/gpt-5.6-sol` model evaluated all arms. Compaction and evaluation
orders were rotated from fixture identifiers. The compactors never saw the later
questions.

An initial six-fixture run used reasoning off. A fidelity audit caught that Pi's
actual unset/default level is medium. That run was discarded before reporting,
the harness was corrected, and both calibration and holdout were rerun with
fresh seeds. The discarded raw bundle is intentionally not published and is not
included in any totals below.

### Hardness without longer contexts

The generator held Pi's estimated pre-compaction history near 50,220 tokens while
replacing irrelevant archival filler with authoritative state. The two locked
densities contained:

| Density per category | Authoritative records | Estimated history tokens |
|---:|---:|---:|
| 180 | 900 | 50,220 |
| 200 | 1,000 | 50,220 |

This increases information density without buying difficulty through
proportionally longer inputs. It also avoids artificially short summary caps,
which would create a new policy and could induce the same kind of cap artifact
the benchmark is intended to avoid.

Each fixture contains ten chronological epochs and five kinds of state: exact
values, directed relations, structured tool outputs, corrected values amid
distractors, and compound task checkpoints. Fifteen questions per category were
selected deterministically across the history, for 75 questions per fixture.
Answers were synthetic, unique, and exact-scored from strict JSON; no LLM judge
was used.

The full-context arm answered all 600 held-out questions, establishing that the
challenge came from compaction rather than unanswerable fixtures or evaluator
failure.

### Calibration and holdout

Corrected calibration seed 111 tested densities 120, 160, and 200. Density 120
was a ceiling for both policies; Pi remained at ceiling at 160; at 200, Pi and
native scored 40/75 and 41/75. Density 180 was predeclared as an interpolated
shoulder and 200 as the stress point. Those densities were locked before running
fresh held-out seeds 301–304. Calibration scores are excluded from the
confirmatory totals. The trace is in [CALIBRATION.md](CALIBRATION.md).

## Confirmatory results

### By locked density

| Density | Full context | Pi default | Extension-native |
|---:|---:|---:|---:|
| 180 | 300/300 (100.0%) | 154/300 (51.3%) | 215/300 (71.7%) |
| 200 | 300/300 (100.0%) | 134/300 (44.7%) | 253/300 (84.3%) |

The higher-density condition did not reduce native accuracy. Provider-native
output size varied sharply between fixtures, so density was not the only source
of difficulty.

### By seed

| Held-out seed | Pi default | Extension-native | Native advantage |
|---:|---:|---:|---:|
| 301 | 72/150 | 114/150 | +42 |
| 302 | 70/150 | 103/150 | +33 |
| 303 | 72/150 | 101/150 | +29 |
| 304 | 74/150 | 150/150 | +76 |

These are only four independent synthetic seeds. The 600 question-level scores
are nested within fixtures and should not be treated as 600 independent
replications.

### Per-fixture allocation and accuracy

| Seed | Density | Pi score | Native score | Pi output tokens | Native output tokens |
|---:|---:|---:|---:|---:|---:|
| 301 | 180 | 40/75 | 39/75 | 3,515 | 4,993 |
| 302 | 180 | 40/75 | 75/75 | 3,350 | 18,164 |
| 303 | 180 | 40/75 | 26/75 | 3,929 | 2,131 |
| 304 | 180 | 34/75 | 75/75 | 3,835 | 18,297 |
| 301 | 200 | 32/75 | 75/75 | 2,377 | 20,401 |
| 302 | 200 | 30/75 | 28/75 | 1,731 | 3,078 |
| 303 | 200 | 32/75 | 75/75 | 1,980 | 27,447 |
| 304 | 200 | 40/75 | 75/75 | 4,109 | 19,186 |

Native output size and score had a descriptive Pearson correlation of 0.95
(n=8). This small-sample association is not a causal estimate, but it makes it
especially unsafe to attribute native's aggregate advantage solely to the
artifact's representation.

### Where the difference appeared

Pi preserved the recent tail perfectly but lost all exact probes from the old
summarized prefix:

| History region | Questions | Pi default | Extension-native |
|---|---:|---:|---:|
| Oldest epochs 0–4 | 280 | 0/280 (0.0%) | 182/280 (65.0%) |
| Boundary epoch 5 | 80 | 48/80 (60.0%) | 54/80 (67.5%) |
| Newest epochs 6–9 | 240 | 240/240 (100.0%) | 232/240 (96.7%) |

That pattern is consistent with Pi's product policy: summarize an older prefix
and retain roughly 20K recent tokens verbatim. Native's advantage in this run
was specifically deep-history state preservation, not better recall of the
recent tail.

## What the result does and does not show

The strongest warranted conclusion is:

> Under their real defaults on these dense synthetic state-preservation tasks,
> this extension's native compaction policy preserved substantially more old
> project state in aggregate than Pi's default compaction policy, while
> consuming materially more compaction output, compaction cost, and downstream
> context—and with high run-to-run variability.

The run deliberately includes product-policy differences: native processes the
history using the extension's native request/replay strategy, while Pi chooses
its own cut point, prompt, summary length, and recent tail. That is appropriate
for a default-vs-default user decision, but it does not isolate the encrypted
artifact's representation from prompt, allocation, retention, or protocol.

In particular, the benchmark does not establish:

- better accuracy at an equal output or downstream-token budget;
- better information efficiency per token or dollar;
- that every native compaction is better than its Pi counterpart;
- that the opaque artifact uses a non-textual or latent representation;
- that the result generalizes to ordinary coding sessions, other models, or
  future endpoint behavior.

## Limitations and next diagnostic

- There are four held-out seeds and two nested density variants per seed. The
  aggregate result is consistent by seed, but this is not a large replication.
- Calibration used one seed and sparse densities. Density 180 was an
  interpolation, deliberately locked before holdout rather than tuned afterward.
- The tasks are deliberately dense exact-state tests. They cover useful coding
  session primitives but not holistic code generation quality.
- Native output allocation was highly variable and opaque.
- Provider token accounting is externally reported billing usage, not a measure
  of decrypted information capacity.
- Only one model and one run date were tested.

If equal-resource efficiency matters, the next benchmark should be a
predeclared budget frontier, not another paired post-hoc cap. For example,
independently run Pi at several fixed, prompt-disclosed summary budgets and plot
accuracy against realized downstream tokens and cost; overlay native's
unconstrained realized points afterward. That would show whether Pi can reach
native's accuracy/resource frontier without letting either arm determine the
other's cap.

## Reproduction and retained evidence

The exact harness and commands are documented in [README.md](README.md). The
held-out manifest, complete fixtures, per-question raw records, and generated
aggregates are retained in
[final-results/2026-07-23_product-defaults-medium_gpt-5.6-sol](final-results/2026-07-23_product-defaults-medium_gpt-5.6-sol).
Opaque encrypted content is not stored; only its hash and byte length are
recorded.

The corrected calibration cost $6.6135 and the held-out run cost $18.2471, for
$24.8606 of primary-design calls. The discarded reasoning-off exploration cost
an additional $27.5039; total live benchmark spend was $52.3645.
