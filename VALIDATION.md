# Validation

## Current Responses compaction v2 validation

The full live Pi RPC suite passes with both:

- `openai/gpt-5.4-nano` through the direct OpenAI Responses API
- `openai-codex/gpt-5.4` through the ChatGPT Codex subscription backend

The validated compaction request uses the normal Responses endpoint with a trailing `{ "type": "compaction_trigger" }`. Both backends returned an opaque `compaction` output item, persisted as `details.remoteCompaction` with `implementation: "responses_compaction_v2"`.

Validated continuity includes same-process recall, reduced-plaintext replay, fork safety, resume/reload, and model-switch round trips. The reduced-plaintext test recovered a generated secret that was absent from all visible retained history and from the portable Pi summary.

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
