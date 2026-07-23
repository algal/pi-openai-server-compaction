# Pi default vs. extension-native compaction: generated results

Run label: confirmatory-medium. Trials: 8; independent seeds: 4; default thinking level: medium; recorded API cost: $18.2471.

## Overall exact accuracy

| Arm | Correct | Accuracy |
|---|---:|---:|
| full_context | 600/600 | 100.0% |
| pi_default | 288/600 | 48.0% |
| native_extension | 468/600 | 78.0% |

## Accuracy by density

| Density per category | Trials | Estimated input tokens | Authoritative records | Full | Pi default | Native extension | Mean trial cost |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 180 | 4 | 50,220 | 900 | 100.0% | 51.3% | 71.7% | $2.154 |
| 200 | 4 | 50,220 | 1,000 | 100.0% | 44.7% | 84.3% | $2.408 |

## Overall accuracy by category

| Category | Full | Pi default | Native extension |
|---|---:|---:|---:|
| distractor_resolution | 100.0% | 46.7% | 77.5% |
| exact_recall | 100.0% | 48.3% | 77.5% |
| relational_state | 100.0% | 46.7% | 77.5% |
| task_continuation | 100.0% | 51.7% | 79.2% |
| tool_history | 100.0% | 46.7% | 78.3% |

## Accuracy by history epoch

Epoch 0 is oldest and epoch 9 is newest.

| Epoch | Full | Pi default | Native extension |
|---:|---:|---:|---:|
| 0 | 100.0% | 0.0% | 65.0% |
| 1 | 100.0% | 0.0% | 65.0% |
| 2 | 100.0% | 0.0% | 65.0% |
| 3 | 100.0% | 0.0% | 65.0% |
| 4 | 100.0% | 0.0% | 65.0% |
| 5 | 100.0% | 60.0% | 67.5% |
| 6 | 100.0% | 100.0% | 95.0% |
| 7 | 100.0% | 100.0% | 95.0% |
| 8 | 100.0% | 100.0% | 95.0% |
| 9 | 100.0% | 100.0% | 100.0% |

## Per-fixture scores and compaction output

| Seed | Density | Full | Pi default | Native extension | Pi output tokens | Native output tokens |
|---:|---:|---:|---:|---:|---:|---:|
| 301 | 180 | 75/75 | 40/75 | 39/75 | 3,515 | 4,993 |
| 302 | 180 | 75/75 | 40/75 | 75/75 | 3,350 | 18,164 |
| 303 | 180 | 75/75 | 40/75 | 26/75 | 3,929 | 2,131 |
| 304 | 180 | 75/75 | 34/75 | 75/75 | 3,835 | 18,297 |
| 301 | 200 | 75/75 | 32/75 | 75/75 | 2,377 | 20,401 |
| 302 | 200 | 75/75 | 30/75 | 28/75 | 1,731 | 3,078 |
| 303 | 200 | 75/75 | 32/75 | 75/75 | 1,980 | 27,447 |
| 304 | 200 | 75/75 | 40/75 | 75/75 | 4,109 | 19,186 |

## Paired Pi/native outcomes

- Both correct: 262
- Native only correct: 206
- Pi only correct: 26
- Both wrong: 106

## Mean resource use

| Measure | Pi default | Native extension |
|---|---:|---:|
| Compaction input tokens | 39,046.5 | 67,518.5 |
| Compaction output tokens | 3,103.3 | 14,212.1 |
| Compaction cost | $0.3371 | $0.8483 |
| Downstream input tokens | 32,968.6 | 42,691.4 |
| Downstream request cost | $0.2536 | $0.3278 |

Native used 4.58x Pi's compaction output tokens and 1.29x its downstream input tokens. Pi length-stopped in 0 trial(s).

## Run role

This is a confirmatory-medium run. Density selection is not recomputed from these scores; the recorded densities are treated as locked.
