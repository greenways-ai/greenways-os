# Greenways Desktop local connection

Status: `0-alpha`

Greenways Desktop is a visibility and recovery shell around `greenwaysd`. It is not another identity, key, credential, provider, room, or capability authority implementation.

## Process boundary

```text
Flutter window and menu bar
  │ closed connect / refresh / disconnect commands
  ▼
bundled greenways-desktop-bridge
  │ fixed Desktop credential and private Unix socket
  ▼
greenwaysd
  │ bounded public projection
  ▼
Flutter state reducer and UI
```

The child process is used deliberately instead of exposing credential parsing, connection-bound session state, or generic local-protocol calls through Dart FFI. Compromise of the Flutter view process therefore does not automatically reveal the local-client token or daemon session ID.

## Request

```json
{
  "protocol": "greenways-desktop-bridge/0-alpha",
  "requestId": "desktop/request/…",
  "command": "connect"
}
```

The exact commands are `connect`, `refresh`, `disconnect`, and internal lifecycle command `quit`. Unknown fields and commands fail closed.

## Result

```json
{
  "protocol": "greenways-desktop-bridge-result/0-alpha",
  "requestId": "desktop/request/…",
  "snapshot": {
    "protocol": "greenways-desktop-connection-status/0-alpha",
    "state": "connected",
    "daemon": {},
    "actor": {},
    "identity": null,
    "session": {},
    "error": null,
    "observedAtUnixMs": 1
  }
}
```

Connection states share the Chrome Connection Center vocabulary:

```text
connecting
connected
daemon-unavailable
credential-unavailable
authentication-rejected
session-expired
protocol-mismatch
disconnected
```

A connected projection requires an exact active Desktop actor. Public identity may be absent while the daemon remains connected.

## Confidentiality

The bridge and Flutter validators reject projections containing credential, token, private-key, key-handle, provider-handle, or session-ID fields. Values beginning with `gwc_` or `local/session/` are also rejected.

The diagnostic copy action serializes only the validated public projection.

## Lifecycle

Closing the macOS window hides the shell. It does not stop `greenwaysd`. The menu-bar item can reopen the window and reports only the bounded connection state.

## Deliberate limits

This protocol does not provide rooms, Hestia authority, provider invocation, browser page forwarding, application approval, capability inventory, recovery-key export, or generic daemon calls.
