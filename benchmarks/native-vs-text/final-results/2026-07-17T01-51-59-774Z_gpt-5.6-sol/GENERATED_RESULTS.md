# Native vs. token-matched textual compaction: generated results

Run directory: `/home/algal/gits/pi-openai-server-compaction/benchmarks/native-vs-text/final-results/2026-07-17T01-51-59-774Z_gpt-5.6-sol`  
Model: `openai/gpt-5.6-sol`  
Fixtures: 6; trials per fixture: 2; scored observations per arm: 900.

## Accuracy

| Arm | Correct | Accuracy | Descriptive Wilson 95% interval |
|---|---:|---:|---:|
| full_context | 900/900 | 100.0% | 99.6%–100.0% |
| native_compaction | 900/900 | 100.0% | 99.6%–100.0% |
| text_summary | 745/900 | 82.8% | 80.2%–85.1% |

## Accuracy by category

| Category | Full context | Native | Text summary |
|---|---:|---:|---:|
| exact_recall | 100.0% | 100.0% | 100.0% |
| relational_state | 100.0% | 100.0% | 100.0% |
| tool_history | 100.0% | 100.0% | 93.9% |
| distractor_resolution | 100.0% | 100.0% | 84.4% |
| task_continuation | 100.0% | 100.0% | 35.6% |

## Paired native vs. text outcomes

- Both correct: 745
- Native only correct: 155
- Text only correct: 0
- Both wrong: 0
- Exact McNemar/binomial p-value over repeated observations: 4.379e-47

## Compaction resource use (mean per paired trial)

| Measure | Native | Text |
|---|---:|---:|
| Processed input tokens | 34926.17 | 35273.17 |
| Output tokens | 5939.92 | 5842.42 |
| Downstream evaluation input tokens | 8836.08 | 8758.17 |
| Latency (ms) | 48478.75 | 47760.17 |
| Cost (USD) | 0.3964 | 0.2723 |

Recorded API cost across compaction, summarization, and evaluation: $12.0264.

## Exact-realized-budget sensitivity

11/12 text summaries consumed exactly the paired native output-token budget. Within those trials, native scored 825/825 and text scored 670/825; mean downstream inputs were 8770.64 and 8790.36 tokens.

This generated document reports measurements only. Interpretive conclusions and limitations belong in the benchmark's standalone REPORT.md.
