# pi-openai-server-compaction

This is a Pi extension which adds **Codex-style remote compaction** for OpenAI models, giving you better continuity across compaction boundaries while preserving all of Pi's normal features.

What does that mean? Why would you want it? My impression has been that Codex compacts better than Claude Code and better than Pi. And I supposed this was because Codex compacts by using OpenAI's server-side Responses compaction protocol. That protocol sends a `compaction_trigger` through `POST /v1/responses` and receives an encrypted `compaction` item. This extension configures Pi to use that protocol for OpenAI models alongside Pi's native compaction logic.

But is Codex's compaction _actually_ better? Since the OpenAI compaction endpoint compacts to encrypted binary blobs, no one can say what it is doing under the hood. However, we don't need to know how it works to determine if it works better. Anyone can call the endpoint. And since codex is an open source, we can mimic exactly how codex itself uses the endpoint. That is what this extension configures Pi to do.

So is native compaction better? For the user-facing comparison I care about,
the evidence says yes, with important price and reliability qualifiers. A
held-out benchmark of the real product defaults found 78.0% exact recall for
this extension's native policy versus 48.0% for Pi's default compactor; full
context scored 100%. Native did this while emitting 4.58x as many compaction
output tokens and leaving a 29% larger billed downstream context. It preserved
much more old state, but this is not evidence that it is better at the same
token budget.
Native was also highly variable: every large artifact scored perfectly, while
three small artifacts performed about as poorly as Pi.

Strictly, this directly compares Pi with this extension's reconstruction of
Codex-style compaction, not with an end-to-end run of the Codex CLI. The result
also does not show that the endpoint reliably detects when more capacity is
needed: its short artifacts were the failures. What it does show is that the
native default sometimes allocates far more context, and those large-allocation
runs drove its aggregate advantage.

An earlier benchmark reported 100% native recall versus 82.8% and 76.7% for two
text summaries at apparently matched downstream sizes. That procedure first
observed native's output usage and then imposed it as the text arm's maximum,
which is asymmetric and can favor native. Its same-budget interpretation is
therefore superseded. See the new [product-defaults report](benchmarks/product-defaults/REPORT.md)
and [reproduction instructions](benchmarks/product-defaults/README.md). The
[older matched-cap report](benchmarks/native-vs-text/REPORT.md) remains retained
with a methodological correction.

None of this proves the encrypted blobs use a clever latent-space
representation. They might be encrypted optimized text or structured state
values. (A little reverse engineering suggests the blobs are produced through
a textual prompt, for what it is worth:
https://x.com/alexisgallagher/status/2042396986327060736?s=20 .)

> **Status:** experimental but live-tested against real Pi + real OpenAI backends.
> Recommended rollout: install project-local first, use for a week, keep rollback easy.

## Support matrix

| Provider/model family | Remote compaction           | `previous_response_id` continuity | Custom WS stream                 | Live-tested |
|-----------------------|-----------------------------|-----------------------------------|----------------------------------|-------------|
| `openai/*`            | Yes                         | Yes                               | Yes                              | Yes         |
| `openai-codex/*`      | Yes                         | No (built-in transport retained)  | No (built-in transport retained) | Yes         |
| Custom Responses provider with an OpenAI model id | Yes | No | No | Yes (`isara/gpt-5.6-sol`) |
| Azure                 | Partial (opt-in via config) | Partial                           | No                               | No          |

## Install

Project-local (recommended):

```bash
pi install -l git:github.com/algal/pi-openai-server-compaction
```

Global:

```bash
pi install git:github.com/algal/pi-openai-server-compaction
```

One-shot, non-persistent:

```bash
git clone https://github.com/algal/pi-openai-server-compaction.git
cd pi-openai-server-compaction && npm install
pi -e ./src/index.ts --model openai/gpt-5.6-luna
```

## Requirements

- Node `>= 22`
- Pi `^0.80.9` or `^1.0.4` (virtual-model routing requires a Pi version with virtual-model support)
- Auth/config for the model you want to use must already work in Pi
- A supported OpenAI Responses model, e.g. `openai/gpt-5.6-sol`, `openai-codex/gpt-5.6-sol`, or an OpenAI model exposed by a custom `openai-responses` provider

## What it does

On compaction, the extension requests Responses compaction v2 through `/v1/responses` in parallel with generating a portable Pi text summary. This gives you both:

- **An OpenAI-native opaque compaction artifact** for high-fidelity continuity on compatible future turns
- **A portable Pi text summary** so non-OpenAI models, session exports, forking, and tree navigation keep working

For direct `openai/*` models between compactions, the extension also:

- Patches requests with `store: true` and `context_management`
- Uses `previous_response_id` for legacy WebSocket incremental continuation; full HTTP transcripts do not also get a previous-response pointer
- Provides a WebSocket-backed transport path with HTTP fallback; transcript-system contexts use Pi's built-in HTTP conversion to preserve current instructions and tool declarations

For `openai-codex/*` models, the extension preserves the built-in Codex transport and only injects reconstructed remote compaction history after compaction boundaries.

For custom or multi-model providers using the `openai-responses` API, remote compaction is enabled when the canonical model id identifies an OpenAI model (`gpt-*`, `o1-*`, `o3-*`, `o4-*`, `chatgpt-*`, or `codex-*`) and the effective model has an explicit `baseUrl`. Provider display names and model display names are intentionally ignored: the stable model id avoids opting an unrelated model into the protocol merely because a label contains “GPT.” Requiring the custom endpoint prevents a custom credential from accidentally falling back to `api.openai.com`. These providers retain their normal transport; the extension only calls their `<baseUrl>/responses` endpoint for compaction and injects replacement history after a successful compaction.

### Virtual models and routing

Virtual selections such as `model-switcher/auto` are supported on Pi versions that provide virtual models. Compaction uses the latest physical assistant response in finalized session context, not the virtual catalog entry. Request patching uses the outgoing Responses payload's model ID, so a new route does not inherit the previous turn's provider settings.

The request hook exposes a model ID but no provider. If multiple authenticated Responses providers offer the same ID, a validated native checkpoint identifies the provider to replay. Without a matching checkpoint, the extension leaves that request unchanged. Routers must not switch between different providers offering the same model ID while reusing a checkpoint; Pi does not expose enough request metadata to detect that switch. GPT/Claude routing with distinct model IDs is supported. Non-Responses requests, including Claude turns, are never patched.

## How compaction works

On Pi compaction events for supported models, the extension:

1. Generates a **portable Pi text summary** (finalized, compaction-aware context with fallback to Pi's built-in compaction helper)
2. Calls `POST /v1/responses` with the conversation history, a trailing `compaction_trigger`, system prompt, tools, reasoning config, and text config
3. Retains recent user messages and stores them with the returned opaque `compaction` item in `CompactionEntry.details.remoteCompaction`
4. Persists remote compaction usage metadata when the backend returns it

The compaction request mirrors the shape of surrounding normal requests (reasoning effort, text settings, tool definitions) rather than using endpoint defaults. Incomplete or empty portable summaries fall back to Pi's summary helper. If both portable summary attempts fail but remote compaction succeeds, the extension warns that switching models may lose summarized context.

## Safety

The extension clears live continuation state on: session start/reload/resume, switch/fork, tree navigation, compaction completion, model selection, and shutdown.

Remote compaction history is only replayed for a compatible, unchanged single-model suffix. A GPT → Claude → GPT switch invalidates the old remote checkpoint rather than silently dropping Claude's work. The extension then uses Pi's portable context until a new remote checkpoint is saved. Persisted context edits also invalidate replay. Reload and tree navigation reconstruct pending user messages, tool results, and extension messages such as background notifications, not just completed assistant turns.

## Data handling

Users should be aware:

- For direct `openai/*` models, the extension sets `store: true` on requests, meaning OpenAI retains conversation data server-side
- Conversation context is sent to OpenAI's Responses compaction protocol
- Returned opaque compaction artifacts are stored in Pi's local session JSONL
- These artifacts are provider-native and not human-readable

## Configuration

Config is read from:

- `~/.pi/agent/openai-server-compaction.json` (global)
- `.pi/openai-server-compaction.json` (project-local, takes precedence)

```json
{
  "enabled": true,
  "includeAzure": false,
  "thresholdRatio": 0.7,
  "compactThreshold": 0,
  "usePreviousResponseId": true,
  "notify": false
}
```

Environment overrides:

| Variable                                           | Effect                                                      |
|----------------------------------------------------|-------------------------------------------------------------|
| `PI_OPENAI_SERVER_COMPACTION_ENABLED`              | Enable/disable the extension                                |
| `PI_OPENAI_SERVER_COMPACTION_AZURE`                | Include Azure OpenAI models                                 |
| `PI_OPENAI_SERVER_COMPACTION_THRESHOLD`            | Explicit compact threshold (tokens)                         |
| `PI_OPENAI_SERVER_COMPACTION_RATIO`                | Compact threshold as ratio of context window (default: 0.7) |
| `PI_OPENAI_SERVER_COMPACTION_PREVIOUS_RESPONSE_ID` | Enable/disable `previous_response_id`                       |
| `PI_OPENAI_SERVER_COMPACTION_NOTIFY`               | Show UI notifications when features activate                |

### Pi's output reserve is separate

For custom providers such as Isara, Pi's own compaction threshold still decides when this extension runs:

```text
compaction threshold = physical context window − compaction.reserveTokens
```

Restoring routed-model support changes **how** compaction runs, not **when** Pi requests it. For a 272,000-token model, the default reserve of 16,384 triggers compaction above 255,616 tokens. A reserve of 40,000 triggers it above 232,000. The larger reserve is optional extra headroom for reasoning-heavy turns; it is not required to enable remote compaction.

`reserveTokens` also sizes Pi's built-in fallback summaries. It does not size the remote compaction artifact or this extension's initial 4,096-token portable summary. The extension's `thresholdRatio` applies to direct OpenAI server-managed requests, not to Isara's Pi-triggered compaction path.

A larger reserve does not fix inaccurate context estimates, failed compaction, or the provider's output clamping against context that will later be replaced by remote history. Under a virtual selection, Pi looks up overrides using the selected virtual model key, for example:

```json
{
  "compaction": {
    "modelOverrides": {
      "model-switcher/auto": { "reserveTokens": 40000 }
    }
  }
}
```

## Troubleshooting

If something goes wrong:

1. **Quick disable:** set `PI_OPENAI_SERVER_COMPACTION_ENABLED=0` or add `"enabled": false` to config
2. **Bypass entirely:** run Pi with `--no-extensions`
3. **Reload:** run `/reload` in Pi to re-initialize extensions
4. **Uninstall:** `pi remove pi-openai-server-compaction`
5. **Inspect:** check your session JSONL for `compaction` entries with `details.remoteCompaction` to see if remote compaction was recorded

## Testing

Smoke test (offline, verifies imports and key algorithms):

```bash
npm run smoke
```

Live end-to-end test (requires working Pi + OpenAI auth):

```bash
npm run test:live
```

Override the test model:

```bash
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai-codex/gpt-5.6-sol npm run test:live
```

## Limitations

- Pi's local JSONL/tree model remains authoritative
- Opaque remote compaction artifacts are only reused for compatible OpenAI Responses turns
- Model-id matching identifies likely OpenAI models behind custom providers, but cannot guarantee that a gateway implements compaction V2; unsupported endpoints fall back to Pi's portable summary
- Switching to a different provider/model falls back to Pi's text-summary portability path
- Compaction usage/cost is captured in details but not yet folded into Pi's `get_session_stats()` (requires Pi core changes)

## Repo layout

| File                                       | Purpose                                                           |
|--------------------------------------------|-------------------------------------------------------------------|
| `src/index.ts`                             | Extension wiring, compaction hook, lifecycle handling             |
| `src/remote-compaction.ts`                 | Responses compaction v2 integration and replacement-history handling |
| `src/openai-ws-stream.ts`                  | WebSocket continuation path                                       |
| `src/openai-ws-connection.ts`              | WebSocket connection manager                                      |
| `src/openai.ts`                            | Model detection and payload patching                              |
| `src/custom-stream.ts`                     | Provider override entrypoint                                      |
| `src/config.ts`                            | Configuration loading                                             |
| `src/state.ts`                             | Ephemeral per-session runtime state                               |
| `src/stream-message-shared.ts`             | Shared assistant message builders                                 |
| `tests/live/openai-compaction-rpc-live.ts` | Live Pi RPC regression test                                       |
| `scripts/smoke.mjs`                        | Offline smoke test with peer-package bootstrapping                |
| `benchmarks/product-defaults/`             | Current default-vs-default benchmark, retained evidence, and report |
| `benchmarks/native-vs-text/`               | Earlier matched-cap benchmark, retained with a correction          |
| `ARCHITECTURE.md`                          | Design and control-flow documentation                             |
| `TESTPLAN.md`                              | Manual and automated test plan                                    |
| `CHANGELOG.md`                             | Version history                                                   |

## License

MIT. See `LICENSE.md`.
