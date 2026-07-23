# Changelog

This changelog intentionally starts at **0.1.0**.

## Unreleased
- target Pi 0.80.9 and the `@earendil-works/*` package namespace
- align compaction fallback, Responses payload normalization, Codex identity headers, and WebSocket behavior with Pi 0.80.9
- replace the legacy `/responses/compact` call with Codex's current Responses compaction v2 protocol
- stream a normal Responses request with a trailing `compaction_trigger` and persist the returned `compaction` item
- retain recent user messages with the same 20K-token budget shape used by Codex while continuing to read legacy version 1 session artifacts
- add a reproducible native-vs-text compaction benchmark, retained GPT-5.6 Sol evidence, and a standalone report
- add a fixed-context, information-density-calibrated product-defaults benchmark comparing Pi's real default compactor with the extension's real native replay policy
- correct the earlier benchmark's same-budget interpretation: its text cap was selected after observing native output usage

During local development on 2026-04-09, the project used temporary internal version bumps while features, tests, docs, and packaging were being assembled. Those local-only bumps were collapsed before the first public push so the repository does not imply a longer tracked public release history than it actually has.

## 0.1.0 - 2026-04-09
- initial public release
- added hybrid Codex-style remote compaction for direct OpenAI Responses models
- added OpenAI `POST /v1/responses/compact` integration
- persisted opaque replacement history in Pi compaction details
- reconstructed remote compaction state across resume/reload/tree navigation
- added WS-backed continuation and conservative `previous_response_id` reuse
- tightened direct OpenAI continuation so unchanged request shapes send only incremental post-turn deltas instead of replaying full input alongside `previous_response_id`
- fixed reconstructed post-compaction remote replay to exclude turns completed by other models after later resume/tree reconstruction
- kept portable Pi text summaries as the readable fallback and non-OpenAI portability path
- hardened cross-model runtime state handling and remote output validation
- mirrored observed Responses `reasoning` and `text` tuning into remote compaction requests when available, with thinking-level fallback for reasoning
- fixed the direct OpenAI WS path to carry reasoning configuration and encrypted-reasoning inclusion like Pi's normal HTTP Responses path
- persisted remote compaction usage metadata when the backend returns it
- added a reduced-plaintext live replay regression with tiny Pi `keepRecentTokens`
- added a live Pi RPC regression harness in `tests/live/openai-compaction-rpc-live.ts`
- added a local smoke harness that bootstraps Pi peer-package links and runs small regression checks
- added `ARCHITECTURE.md`, testing docs, packaging polish, and MIT licensing
