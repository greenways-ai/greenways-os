# `greenways-substrate/0-alpha`

An existing `greenways-local/0-alpha` connection first completes `client.session.open`. The same connection may then send one JSON operation:

```text
connection.substrate.upgrade
```

Its argument protocol is `greenways-substrate/0-alpha`. A successful JSON result reports request, response, subscription, queue, and connection-generation limits. The response newline is the final JSON byte on that connection.

## Binary frame

```text
4-byte unsigned big-endian payload length
one canonical HTA0 value containing one std.substrate frame
```

The length excludes its four-byte prefix. Zero is invalid. Client request payloads are at most 65,536 bytes. Server response and event payloads are at most 262,144 bytes. A receiver rejects an excessive length before reading the payload.

The HTA value must decode and re-encode to the exact same bytes. Trailing bytes, duplicate fields, unsupported values, and noncanonical field order fail.

## Reused frame kinds

Use the existing string-keyed shapes without another envelope:

```text
request      kind id space meta action args
response     kind id space meta reply_to status data error
stream       kind id space meta signal data cause
subscribe    kind id space signal meta
unsubscribe  kind id space signal meta
```

Initial actions are exactly:

```text
@greenways/session/hello
@greenways/resource/resolve
@greenways/data/query
@greenways/data/transact
```

The initial signal is `resource.changed`.

## Context and IDs

Connection context is added by the daemon after session setup; frame fields cannot replace it. Mutation frame IDs are durable and actor-bound. Exact replay returns the committed result. Reuse with different canonical bytes returns `request-id-collision`. Reads and subscriptions are connection-scoped.

## Subscriptions

A connection has at most 32 active subscriptions and 128 queued events. Overflow emits `resync-required`; the client resolves and requeries the current resource. Disconnect removes subscriptions. Reconnect requires a new session, upgrade, subscription, and query.

## Typed failures

Initial codes include `disconnect`, `timeout`, `cancelled`, `protocol-mismatch`, `malformed-hta`, `noncanonical-hta`, `request-too-large`, `response-too-large`, `unknown-frame`, `unknown-action`, `unknown-field`, `request-id-collision`, `stale-head`, `resync-required`, `resource-unavailable`, and `runtime-failed`.

Normative vectors are in `protocol/fixtures/workspace-substrate-0-alpha.json`.
