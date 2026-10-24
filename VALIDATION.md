# Validation

## Pipeline-head Luna verification — 2026-10-24

Tested revision: `ca941e06f11a21e7e4ec82fa4573ef09976c068f`, using
Pi 1.2.0 and `gpt-6-luna` with high reasoning. Both isolated lifecycle
scripts exited 0. Existing credentials were supplied through runtime provider
registration, without refresh, persistent import, or global configuration changes.

- **Codex:** the remote trigger returned HTTP 200 and a persisted encrypted
  `responses_compaction_v2` artifact. The codename was absent from the portable
  summary and retained plaintext, yet post-compaction recall succeeded. The
  persisted session independently confirmed a subsequent real `read` tool result;
  a new process recovered both the codename and file sentinel.
- **Direct OpenAI WebSocket:** HTTP 101, streamed text with empty terminal output,
  a real `read` call, injected invalid-ID rejection followed by fresh-socket
  full-history replay, and saved-session process resume all passed.

The direct channel's previously observed trigger rejection was not retried.
Codex artifact evidence exercises its built-in transport and does not establish
custom WebSocket continuity across remote compaction. This focused test phase
did not run the full suite, static analysis, or delivery phases.

Local evidence is retained under
`/Users/stan/.no-mistakes/evidence/01M5P36SF92SVJE654BS7CGH4T/round4/`:
`result.json`, each channel's `lifecycle.log` and isolated session files,
plus Codex `wire-structure.jsonl`, `compact-result.json`, and
`post-compaction-tool-proof.json`. These are local evidence, not bundled PR assets.

## WebSocket repair validation — 2026-10-24

These checks used Node 24.20.0 and Pi CLI 1.2.0 in isolated sessions with only
this checkout's extension loaded. The declared Pi 0.80.9 development dependencies
were retained for `npm test`; this change does not claim a complete Pi 1.x migration.

**Direct OpenAI, `openai/gpt-6-luna`, high reasoning, existing subscription-sharing OAuth:**

- HTTP 101 WebSocket upgrade with `store: false`, streamed text and a persisted
  final reply, including terminal responses whose `output` array was empty.
- A real `read` tool round trip. Injecting an invalid `previous_response_id`
  produced a real backend rejection, then a fresh authenticated connection and
  successful full-history replay without an assistant error.
- Saved-session resume in a new Pi process preserved the test codename and file
  contents. This direct-provider resume check did not follow remote compaction.
- Remote compaction was **not supported on this tested channel**: a minimal
  request with one user message returned HTTP 200; adding only the trailing
  `compaction_trigger` returned HTTP 400 with
  `subscription_sharing_unsupported_capability`. The full lifecycle attempt
  returned only a portable text summary, which the test correctly rejected as
  remote-compaction evidence.

**Codex, `openai-codex/gpt-6-luna`, high reasoning, existing Codex client login:**

- A separate isolated run used the existing same-account access token through
  Pi's supported runtime provider registration. No login, credential refresh,
  persistent import, global configuration change, or installed-extension change
  was performed.
- The request to `https://chatgpt.com/backend-api/codex/responses` returned HTTP
  200 and an encrypted `compaction` item. The session persisted
  `details.remoteCompaction.implementation: "responses_compaction_v2"`.
- The exact test codename was absent from both the portable text summary and
  retained plaintext history. The first post-compaction answer recovered it.
- A subsequent real `read` tool round trip returned the file sentinel and
  codename; a new Pi process resumed the saved session and recalled both.

The Codex run exercises the built-in Codex transport and this extension's remote
compaction/replay path. It does **not** establish that the direct OpenAI OAuth
channel accepts triggers or that the custom WebSocket path has passed a remote
compaction boundary on that channel.

**Automated regression checks:** `npm test` passes typechecking, smoke tests,
the output/context checks in `scripts/websocket-regression.mjs` and the local
continuation scenarios in `scripts/websocket-continuation-regression.mjs`.
These cover explicit no-store handling, streamed text/tool item recovery,
nested errors, modern/legacy context adaptation, warmup input, same-socket
continuation, explicit/automatic reconnect, rejected-ID recovery with and without
socket close, bounded retry, no retry after text/tool output, and exactly one
logical stream start and terminal event. A new stream-lifecycle assertion failed
before its fix (`2 !== 1` starts during recovery), then passed. Earlier output
and transport-boundary tests also failed against upstream main before applying
the repair. Local fixtures do not substitute for the separate live results above.

Azure, maximum reasoning effort, a full Pi 1.x SDK migration, and direct-provider
post-remote-compaction continuity were not validated by this repair.

## Earlier Responses compaction v2 validation

The earlier full live Pi RPC suite passed with both:

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
