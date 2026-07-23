# Validation

## Current Responses compaction v2 validation

The full live Pi RPC suite passes with both:

- `openai/gpt-5.6-luna` through the direct OpenAI Responses API
- `openai-codex/gpt-5.6-sol` through the ChatGPT Codex subscription backend

The validated compaction request uses the normal Responses endpoint with a trailing `{ "type": "compaction_trigger" }`. Both backends returned an opaque `compaction` output item, persisted as `details.remoteCompaction` with `implementation: "responses_compaction_v2"`.

Validated continuity on both providers includes same-process recall, fork safety, resume/reload, and model-switch round trips. The direct OpenAI suite also includes reduced-plaintext replay; that test recovered a generated secret absent from all visible retained history and from the portable Pi summary.

## Controlled product-defaults benchmark

A retained GPT-5.6 Sol benchmark compared Pi 0.80.9's actual default
compaction policy, this extension's actual Responses compaction/replay policy,
and a full-context control. It increased task difficulty by replacing filler
with exact state at a fixed roughly 50K-token history, without imposing an
output cap from one arm on the other.

On held-out seeds 301–304, full context scored 600/600, native scored 468/600
(78.0%), and Pi default scored 288/600 (48.0%). Native used 4.58x Pi's mean
compaction output tokens, 2.52x its compaction cost, and 1.29x its downstream
input tokens. Pi had zero length-stopped summaries. All five native artifacts
above 10K output tokens scored 75/75, while the three below 5K scored 39, 26,
and 28. The supported conclusion is that the native default policy preserved
more old state in aggregate while using more resources and exhibiting high
allocation variability—not that it was more accurate at an equal budget.

See:

- `benchmarks/product-defaults/REPORT.md`
- `benchmarks/product-defaults/README.md`
- `benchmarks/product-defaults/CALIBRATION.md`

## Correction to the earlier matched-cap benchmark

The earlier native-vs-text run set each text summary's maximum output tokens
after observing its paired native request's output usage. That creates a
one-sided, post-treatment cap and is not a symmetric matched-budget comparison.
Its raw results remain reproducible, but its same-budget interpretation is
superseded by the methodological note in:

- `benchmarks/native-vs-text/REPORT.md`
- `benchmarks/native-vs-text/README.md`

## Legacy `/responses/compact` validation

Before the v2 migration, a direct manual probe against the OpenAI API succeeded:

1. `POST /v1/responses/compact`
   - returned `object: "response.compaction"`
   - returned an `output` array containing:
     - a preserved `message` item
     - a `compaction` item with large `encrypted_content`

2. A follow-up `POST /v1/responses`
   - used the returned compaction output plus a new user message
   - correctly recovered hidden prior information from the compaction artifact

### Concrete probe

Compressed history contained the fact:
- `My launch code is ORANGE-17.`

After compaction, the next request included:
- the returned `compaction` item
- a fresh user message: `What is my launch code?`

The model replied:
- `Your launch code is ORANGE-17.`

## Meaning

This confirms that the OpenAI compaction endpoint is real, returns opaque compaction artifacts, and that replaying those artifacts in later Responses requests does preserve continuity across the compaction boundary.

## Live Pi RPC tests

A full live Pi RPC test run also passed using this extension.

The maintained regression harness now lives at:
- `tests/live/openai-compaction-rpc-live.ts`

Validated end-to-end for:
- direct OpenAI Responses (`openai/*`)
- OpenAI Codex subscription provider (`openai-codex/*`)

Validated end-to-end:

1. **Same-process continuity across compaction**
   - prompt stored a secret
   - `/compact` equivalent RPC compaction was run with custom instructions explicitly telling the text summary to omit the secret
   - compaction response contained `details.remoteCompaction.replacementHistory`
   - the current direct OpenAI and OpenAI Codex paths return a `compaction` artifact item
   - legacy session entries containing `compaction_summary` remain supported for replay compatibility
   - a later prompt in the same session correctly recovered the secret

2. **`/model`-style switching mid-session**
   - after compaction and successful recall, the session switched to another direct OpenAI Responses model
   - the next prompt completed successfully
   - the session then switched back to the original direct OpenAI Responses model
   - remote continuity still worked after the round-trip
   - Pi remained usable and cost totals stayed non-zero

3. **Fork safety after compaction**
   - after compaction, a fork was created from an earlier user message
   - the forked session stayed usable and answered correctly on the next prompt

4. **Resume/reload continuity after remote compaction**
   - a session was compacted
   - Pi was restarted on the saved session file
   - the resumed session correctly recovered the secret even though the portable text summary omitted it

5. **Resume/reload after a `/model` round-trip**
   - a session was compacted under one direct OpenAI model
   - the session switched to another OpenAI Responses model for a completed turn
   - the session switched back and successfully recalled the hidden secret
   - Pi was restarted on the saved session file
   - the resumed session still recovered the secret, confirming reconstructed replay excluded the intervening other-model turn

This confirms the extension uses Responses compaction v2 artifacts in a way that materially affects continuity, while keeping Pi operational across key session features on both the direct API provider and the OpenAI Codex subscription provider.

## Hardening notes

After the first successful live pass, an additional cleanup/hardening pass was applied:

- in-memory remote history is now only extended when the active model still matches the compaction model, preventing cross-model pollution during `/model` round-trips
- local portable-summary generation now falls back to Pi's built-in compaction helper if the full-branch summary attempt fails
- remote compaction output is now shape-checked before being persisted or reconstructed from session details
- the WebSocket connection manager now handles reconnect scheduling and pre-open close/error cases more defensively
