# pi-openai-server-compaction

This is a Pi extension which adds **Codex-style remote compaction** for OpenAI models, giving you better continuity across compaction boundaries while preserving all of Pi's normal features.

What does that mean? Why would you want it? My impression has been that Codex compacts better than Claude Code and better than Pi. And I supposed this was because Codex compacts by using OpenAI's server-side Responses compaction protocol. That protocol sends a `compaction_trigger` through `POST /v1/responses` and receives an encrypted `compaction` item. This extension configures Pi to use that protocol for OpenAI models alongside Pi's native compaction logic.

But is Codex's compaction _actually_ better? Since the OpenAI compaction endpoint compacts to encrypted binary blobs, no one can say what it is doing under the hood. However, we don't need to know how it works to determine if it works better. Anyone can call the endpoint. And since codex is an open source, we can mimic exactly how codex itself uses the endpoint. That is what this extension configures Pi to do.

So is native compaction better? Yes, I think so. I tasked GPT-5.6 Sol to run a controlled benchmark, and it found 100% recall from native compaction versus 82.8% for a balanced token-budget-matched text summary and 76.7% for a dense task-first variant. This shows a behavioral advantage in the tested regime. So this matches my own personal experience operating both these systems. 

This result does not prove the encrypted blobs use any clever latent-space representation. They might just be encrypted optimized text or structured state values of some kind. (A little reverse engineering suggests the blogs are produced through a textual prompt, for what it is worth: https://x.com/alexisgallagher/status/2042396986327060736?s=20 .) See the [standalone report](benchmarks/native-vs-text/REPORT.md) and [reproduction instructions](benchmarks/native-vs-text/README.md) for the protocol, retained evidence, and limitations.

> **Status:** experimental but live-tested against real Pi + real OpenAI backends.
> Recommended rollout: install project-local first, use for a week, keep rollback easy.

## Support matrix

| Provider/model family | Remote compaction           | `previous_response_id` continuity | Custom WS stream                 | Live-tested |
|-----------------------|-----------------------------|-----------------------------------|----------------------------------|-------------|
| `openai/*`            | Yes                         | Yes                               | Yes                              | Yes         |
| `openai-codex/*`      | Yes                         | No (built-in transport retained)  | No (built-in transport retained) | Yes         |
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
- Pi `>=0.80.9 <0.81.0`
- Auth/config for the model you want to use must already work in Pi
- A supported OpenAI Responses model, e.g. `openai/gpt-5.6-sol` or `openai-codex/gpt-5.6-sol`

## Grok CLI gateway

The package also ships an optional standalone gateway for official Grok CLI.
Grok replays its full Responses input on every turn but does not currently
initiate server-side compaction itself. The gateway watches those full replays,
compacts an old prefix through the same `compaction_trigger` protocol, and
replaces that exact prefix with the returned opaque item on later requests.

This path is separate from the Pi extension. It requires an upstream that
supports normal OpenAI Responses requests and `compaction_trigger`; provider
authentication remains the upstream's responsibility.

Start it from a checkout:

```bash
git clone https://github.com/algal/pi-openai-server-compaction.git
cd pi-openai-server-compaction && npm install
GROK_COMPACTION_UPSTREAM=https://api.openai.com/v1 \
GROK_COMPACTION_HELPER_MODEL=gpt-5.6-luna \
  npm exec -- grok-openai-server-compaction
```

Then point only the desired GPT model entries in `~/.grok/config.toml` at the
loopback gateway:

```toml
[model."gpt-5.6-luna"]
model = "gpt-5.6-luna"
base_url = "http://127.0.0.1:10532/v1"
env_key = "OPENAI_API_KEY"
api_backend = "responses"
context_window = 272000
```

The gateway is loopback-only by default. It uses Grok's session, conversation,
and agent headers to isolate branches; validates exact source-prefix hashes;
keeps tool calls with their outputs; and commits state only after a completed
main response. Compaction failures and history mismatches fail open. The state
file contains opaque `encrypted_content`, prefix hashes, and branch metadata,
not source conversation text.

| Variable | Default | Purpose |
|----------|---------|---------|
| `GROK_COMPACTION_UPSTREAM` | required | Responses-compatible upstream base URL |
| `GROK_COMPACTION_HOST` | `127.0.0.1` | Gateway bind host |
| `GROK_COMPACTION_PORT` | `10532` | Gateway port |
| `GROK_COMPACTION_STATE_FILE` | `~/.grok/openai-compaction-gateway/state.json` | Per-machine opaque state |
| `GROK_COMPACTION_THRESHOLD_TOKENS` | `180000` | Approximate input size that triggers compaction |
| `GROK_COMPACTION_KEEP_TOKENS` | `20000` | Recent input retained after compaction |
| `GROK_COMPACTION_HELPER_MODEL` | `gpt-5.6-luna` | GPT model used for Grok's stateless helper requests |

The gateway filters the Codex-only `response.metadata` SSE event that current
Grok clients reject and reconstructs empty terminal `output` arrays from
completed output items. Grok's local transcript remains unchanged and
human-readable; only model-bound context uses the opaque replacement. To roll
back, restore the model's previous `base_url`, stop the gateway, and retain or
delete its state file while stopped.

## What it does

On compaction, the extension requests Responses compaction v2 through `/v1/responses` in parallel with generating a portable Pi text summary. This gives you both:

- **An OpenAI-native opaque compaction artifact** for high-fidelity continuity on compatible future turns
- **A portable Pi text summary** so non-OpenAI models, session exports, forking, and tree navigation keep working

For direct `openai/*` models between compactions, the extension also:

- Patches requests with `store: true` and `context_management`
- Uses `previous_response_id` for live continuation when safe
- Provides a WebSocket-backed transport path with HTTP fallback

For `openai-codex/*` models, the extension preserves the built-in Codex transport and only injects reconstructed remote compaction history after compaction boundaries.

## How compaction works

On Pi compaction events for supported models, the extension:

1. Generates a **portable Pi text summary** (full-branch summary with fallback to Pi's built-in compaction helper)
2. Calls `POST /v1/responses` with the conversation history, a trailing `compaction_trigger`, system prompt, tools, reasoning config, and text config
3. Retains recent user messages and stores them with the returned opaque `compaction` item in `CompactionEntry.details.remoteCompaction`
4. Persists remote compaction usage metadata when the backend returns it

The compaction request mirrors the shape of surrounding normal requests (reasoning effort, text settings, tool definitions) rather than using endpoint defaults.

## Safety

The extension clears live continuation state on: session start/reload/resume, switch/fork, tree navigation, compaction completion, model selection, and shutdown.

Remote compaction history is only replayed for compatible models. Cross-model turns are filtered from reconstructed replay history to prevent contamination after resume or tree navigation.

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
| `src/grok/cli.mjs`                         | Standalone Grok compaction gateway entrypoint                      |
| `src/grok/server.mjs`                      | Grok Responses proxy, compatibility filtering, and commit gate     |
| `src/grok/core.mjs`                        | Prefix matching, tool-safe cuts, and opaque state persistence      |
| `tests/grok-gateway.test.mjs`              | Offline Grok gateway regression tests                              |
| `tests/live/openai-compaction-rpc-live.ts` | Live Pi RPC regression test                                       |
| `scripts/smoke.mjs`                        | Offline smoke test with peer-package bootstrapping                |
| `benchmarks/native-vs-text/`               | Controlled benchmark, retained evidence, and standalone report    |
| `ARCHITECTURE.md`                          | Design and control-flow documentation                             |
| `TESTPLAN.md`                              | Manual and automated test plan                                    |
| `CHANGELOG.md`                             | Version history                                                   |

## License

MIT. See `LICENSE.md`.
