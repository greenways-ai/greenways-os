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
    "hestiaImport": {
      "protocol": "greenways-hestia-import-status/0-alpha",
      "state": "pinned",
      "repository": "greenways-ai/hestia",
      "revision": "64707d7a38216d800bcc22b8da215c3e6946e1bb",
      "package": "@greenways/hestia-browser",
      "artifactCount": 12,
      "roomInvocationProtocol": "hestia-room-invocation/0-alpha",
      "authorityDecisionProtocol": "hestia-room-authority-decision/0-alpha",
      "preparedExecutionProtocol": "greenways-prepared-room-execution/0-alpha",
      "verificationScope": "compiled-lock",
      "roomProjectionsAdmitted": false,
      "admittedRoomProjectionCount": 0
    },
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

A connected projection requires an exact active Desktop actor and the exact compiled Hestia import status. Public identity may be absent while the daemon remains connected. Connecting, disconnected, and failed projections must set `hestiaImport` to `null` rather than carrying partial authority metadata.

## Compiled import readiness is not room authority

`hestiaImport.state = pinned` means that the reviewed Hestia browser package closure named by the committed lock is compiled into this build. `verificationScope = compiled-lock` deliberately does not claim that a live room, membership, source mandate, application grant, route, or provider is verified.

The bounded projection exposes only package identity, the exact imported artifact count, the inert cross-authority protocol versions, and the admitted room-projection count. Artifact names, paths, individual digests, Hestia record bodies, invitation material, membership proofs, roots, and canonical room receipts stay outside the Desktop protocol.

In this readiness slice, `roomProjectionsAdmitted` is `false` and `admittedRoomProjectionCount` is `0`. The two fields must agree. Admission of canonical room projections requires a later authority-owned protocol and durable store; package pinning cannot stand in for that evidence.

The daemon operation beneath this projection is the exact no-argument `hestia.import.status` request. It requires an authenticated local session. Desktop, CLI, and explicit Developer roles may read it; Browser Bridge is denied before metadata projection and before the ordinary durable request-receipt path.

## Confidentiality

The bridge and Flutter validators reject projections containing credential, token, private-key, key-handle, provider-handle, or session-ID fields. Values beginning with `gwc_` or `local/session/` are also rejected.

The diagnostic copy action serializes only the validated public projection.

## Lifecycle

Closing the macOS window hides the shell. It does not stop `greenwaysd`. The menu-bar item can reopen the window and reports only the bounded connection state.

## Deliberate limits

This protocol exposes bounded pinned-import metadata and an empty Rooms readiness surface. It does not provide canonical rooms or memberships, source mandates, room application grants, roots, invitation or join transport, provider invocation, browser page forwarding, application approval, capability inventory, recovery-key export, or generic daemon calls. It also does not evaluate Hestia governance policy or change the menu-bar status from local-daemon state.
