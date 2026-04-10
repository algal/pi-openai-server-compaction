# pi-openai-server-compaction

Pi extension that adds **Codex-style remote compaction** for OpenAI models, giving you better continuity across compaction boundaries while preserving all of Pi's normal features.

Why would you want this? Codex seems to compact better than Claude Code, and Codex compacts by using OpenAI's server-side compaction endpoint. Although this endpoint returns encrypted outputs, so that it is hard to know _how_ it is compacting, it is a public endpoint and you can call it yourself. This extension configures Pi to use that endpoint for OpenAI models, instead of Pi's native compaction logic.

But is Codex's compaction _actually_ better? Is OpenAI doing something special in its server-side compaction endpoint? I thought so when I started this extension, but then I found this clever reverse engineering which shows that, apparently, they are not: https://x.com/alexisgallagher/status/2042396986327060736?s=20 .

So if OpenAI's remote compaction endpoint is not doing anything special, then using it instead of Pi's compaction logic might provide little benefit. In this case, you don't need this extension at all! But if you still believe Codex is doing something special with compaction, and you want to configure your Pi to mimic what Codex does as closely as possible, then this extension is for you. Or, if OpenAI changes what their compaction endpoint does beneath the cover of encryption, then you can use this extension to use it within Pi.

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
pi -e ./src/index.ts --model openai/gpt-5.4-nano
```

## Requirements

- Node `>= 22`
- Pi installed and working
- Auth/config for the model you want to use must already work in Pi
- A supported OpenAI Responses model, e.g. `openai/gpt-5.4-nano` or `openai-codex/gpt-5.4`

## What it does

On compaction, the extension calls OpenAI's `/v1/responses/compact` endpoint in parallel with generating a portable Pi text summary. This gives you both:

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
2. Calls `POST /v1/responses/compact` with the conversation history, system prompt, tools, reasoning config, and text config
3. Stores the returned opaque replacement history in `CompactionEntry.details.remoteCompaction`
4. Persists remote compaction usage metadata when the backend returns it

The compaction request mirrors the shape of surrounding normal requests (reasoning effort, text settings, tool definitions) rather than using endpoint defaults.

## Safety

The extension clears live continuation state on: session start/reload/resume, switch/fork, tree navigation, compaction completion, model selection, and shutdown.

Remote compaction history is only replayed for compatible models. Cross-model turns are filtered from reconstructed replay history to prevent contamination after resume or tree navigation.

## Data handling

Users should be aware:

- For direct `openai/*` models, the extension sets `store: true` on requests, meaning OpenAI retains conversation data server-side
- Conversation context is sent to OpenAI's remote compaction endpoint
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
PI_OPENAI_SERVER_COMPACTION_TEST_MODEL=openai-codex/gpt-5.4 npm run test:live
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
| `src/remote-compaction.ts`                 | `/responses/compact` integration and replacement-history handling |
| `src/openai-ws-stream.ts`                  | WebSocket continuation path                                       |
| `src/openai-ws-connection.ts`              | WebSocket connection manager                                      |
| `src/openai.ts`                            | Model detection and payload patching                              |
| `src/custom-stream.ts`                     | Provider override entrypoint                                      |
| `src/config.ts`                            | Configuration loading                                             |
| `src/state.ts`                             | Ephemeral per-session runtime state                               |
| `src/stream-message-shared.ts`             | Shared assistant message builders                                 |
| `tests/live/openai-compaction-rpc-live.ts` | Live Pi RPC regression test                                       |
| `scripts/smoke.mjs`                        | Offline smoke test with peer-package bootstrapping                |
| `ARCHITECTURE.md`                          | Design and control-flow documentation                             |
| `TESTPLAN.md`                              | Manual and automated test plan                                    |
| `CHANGELOG.md`                             | Version history                                                   |

## License

MIT. See `LICENSE.md`.
