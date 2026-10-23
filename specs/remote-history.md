# Remote history

## Scope

Kind: technical
Capability: remote-history
Owns: request configuration, persisted context, and tool-call replay across native history replacement.

Related: [Architecture](../ARCHITECTURE.md).

## Operations

- `applyRemoteHistoryPayloadPatch({ payload, explicitHistory })` returns a new
  Responses payload. It discards the replaced conversational input, retains
  request-local configuration, and clears `messages` and `previous_response_id`.
- `messageToResponseItems(message)` converts Pi conversation and extension messages
  into Responses history. Invalid grammar-tool input throws rather than silently
  changing its format.
- `messagesToResponseItems(messages, model?)` converts a message sequence. When a
  model is supplied, unsupported images become text placeholders. It does not
  remove tool results whose calls belong to an earlier response.

## Requirements

### Include persisted context

`req~remote-history.persisted-context~1`

WHEN remote history is reused for a request or compaction, the extension SHALL include persisted post-compaction context messages from the active branch without duplication.

Needs: impl, itest

### Preserve request configuration

`req~remote-history.request-configuration~1`

WHEN substituting compacted conversation history, the extension SHALL retain Pi-generated instructions, tool declarations, tool availability notices, and reasoning configuration in their original relative order.

Needs: impl, utest, itest

### Do not mutate caller inputs

`req~remote-history.nonmutating-replacement~1`

The extension SHALL replace conversation input without mutating the supplied payload or history, preserving unrelated request fields and removing stale continuation identifiers.

Needs: impl, utest

### Preserve tool-call replay

`req~remote-history.tool-replay~1`

The extension SHALL preserve custom-tool inputs, call identifiers, and tool namespaces when replaying post-compaction tool calls and results.

Needs: impl, utest, itest
