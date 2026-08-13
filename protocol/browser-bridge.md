# Greenways browser bridge protocol

Status: `0-alpha`

The Greenways browser bridge is the narrow local connectivity seam between the exact packaged Chrome extension and `greenwaysd`.

```text
reviewed extension page
  → Chrome Native Messaging
  → ai.greenways.browser_bridge
  → fixed private Unix-domain socket
  → authenticated browser-bridge local session
  → bounded public connection projection
```

It is not the Developer RESP bridge and does not provide generic daemon RPC.

## Native request

```json
{
  "protocol": "greenways-browser-bridge/0-alpha",
  "type": "request",
  "id": "bridge/request/...",
  "command": "connect"
}
```

The only commands are:

- `connect` — read the fixed private credential, open the fixed daemon socket, authenticate, and return the current bounded projection;
- `status` — refresh an existing connection without changing its authority;
- `disconnect` — destroy the connection-bound daemon session and clear all projected state.

Unknown fields and commands fail closed.

## Native result

```json
{
  "protocol": "greenways-browser-bridge-result/0-alpha",
  "type": "response",
  "id": "bridge/request/...",
  "ok": true,
  "status": {
    "protocol": "greenways-browser-bridge-status/0-alpha",
    "state": "connected",
    "daemon": {},
    "actor": {},
    "identity": {},
    "session": {},
    "error": null,
    "observedAtUnixMs": 1786500000000
  },
  "error": null
}
```

## States

The status state is one of:

```text
connecting
connected
daemon-unavailable
native-host-unavailable
credential-unavailable
authentication-rejected
session-expired
protocol-mismatch
disconnected
```

`native-host-unavailable` is synthesized by the extension when Chrome cannot open the exact installed host. All other states originate from the host’s bounded local connection result.

Only `connected` may carry daemon, actor, identity, or session projections. Every other state clears those fields so stale authority cannot remain visible.

## Projection boundary

The connected snapshot may contain:

- public daemon node/version/generation/revision and mode fields;
- the redacted enrolled local client ID, fixed `browser-bridge` role, label, creation time, and non-revoked state;
- the public Greenways identity card fields;
- session client/role/label, opening time, expiry, and remaining request budget.

It never contains:

```text
local-client token
daemon session ID
profile private key
provider credential
credential-store or key-store handle
capability or application inventory
room membership or source mandates
prompt or response content
arbitrary daemon operation names
arbitrary filesystem, HTTP, browser, or kernel authority
```

## Fixed installation authority

The Native Messaging installer binds:

- one exact packaged extension ID through `allowed_origins`;
- one Greenways home and daemon socket;
- one browser-bridge credential path.

Extension messages cannot replace those paths or select another credential. The credential must be a private regular file with protocol `greenways-local-client-credential/0-alpha` and role `browser-bridge`.

## Migration law

Connection failure does not reactivate the extension-resident compatibility kernel as daemon authority. The UI must show a disconnected or failed state. Browser-resident functionality remains explicitly compatibility-only until its separate prepare–verify–commit migration is completed.
