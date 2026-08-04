# Greenways Home Link wire profile

This document is the runnable first profile beneath the broader
[`home-node.md`](home-node.md) architecture. Greenways Home Link connects
separately installed browser profiles to a private Hestia Home Node without
turning that node into the Greenways OS browser authority. The browser-wide
Hara kernel, application approvals, private identity keys, and local records
remain on each browser.

Network transport and device authority are separate layers. Home Link may run
through loopback, a private LAN, or HTTPS carried by a private networking tool.
The transport makes the endpoint reachable; it does not decide which browser is
trusted. Each browser proves its own requests with a non-extractable device key,
and each node signs the records from which browsers learn its identity and
service state.

## Node identity and discovery

A home node owns an ECDSA P-256 node key and exposes:

```text
GET /.well-known/greenways-home
```

The response uses `greenways-home/1` and contains only:

- a stable node identifier, display name, public key and key identifier;
- whether a one-time pairing window is available;
- inert service descriptors containing an identifier, name, kind, version,
  capabilities, and availability;
- an issuance time; and
- a node signature over the canonical response body.

The browser verifies the self-signature before presenting the node. The
one-time pairing gesture binds that verified node identity to the selected
origin. Later status and unpair responses must use the same pinned key. A key or
node-identifier change requires a new pairing decision.

A service descriptor cannot contain a URL, script, module, entrypoint, source,
Wasm, HAL, executable UI, or another field that would extend the installed
browser runtime. Greenways OS may map a known service identifier to a separately
reviewed local adapter; discovery itself never installs code.

## Pairing

The user obtains an eight-character one-time code from the home node and enters
it in Greenways OS. The browser generates a fresh ECDSA P-256 key pair. The
private key is non-extractable and remains in the extension's IndexedDB; only
the public JWK, browser name, and random device identifier are sent to:

```text
POST /greenways/v1/pair
```

The request uses `greenways-home-pair/1`. A successful, node-signed
`greenways-home-paired/1` receipt binds the browser device to the verified node,
lists its scopes, and repeats the inert service descriptors. The receipt must
carry the same node key discovered before the code was submitted.

A pairing code is accepted once and expires after a bounded interval. Pairing
does not create a Greenways account and does not return a reusable bearer token.
Each browser profile receives a separate key and can be revoked independently.

## Signed browser requests

After pairing, the browser sends status and unpair requests as
`greenways-home-auth/1`. The signed envelope contains:

```json
{
  "protocol": "greenways-home-auth/1",
  "deviceId": "browser.…",
  "method": "POST",
  "path": "/greenways/v1/status",
  "timestamp": "2026-08-05T00:00:00.000Z",
  "nonce": "nonce/…",
  "bodyHash": "sha256:…"
}
```

The browser signature covers the canonical envelope. The node verifies the
registered public key, exact HTTP method and path, body hash, timestamp window,
and a single-use nonce. Replayed, modified, expired, unknown-device, or
incorrectly signed requests fail closed.

`POST /greenways/v1/status` returns a node-signed
`greenways-home-status/1` record containing paired browser names, last signed
presence times, and bounded service metadata. It does not expose browser
history, tabs, identity secrets, or local application state.

`POST /greenways/v1/unpair` removes the public device record and returns a
node-signed `greenways-home-unpaired/1` receipt. If the node is unreachable,
Greenways OS may still delete the local private key and revoke its origin
permission; the node is then left only with a stale public-key entry that can no
longer authenticate the removed browser.

## Current reference implementation

`services/home-node/` implements this profile as an in-memory development node.
It provides:

- signed discovery and node-key pinning;
- short-lived, single-use pairing codes;
- independent browser-device keys;
- signed browser presence and unpairing;
- method, path, timestamp, body-hash and nonce verification;
- replay and body-tampering rejection;
- extension-origin CORS at the HTTP boundary; and
- inert Hestia, Historia and Hara service advertisements.

The reference node deliberately does not yet provide persistent device records,
certificate issuance, a local administrator interface, key rotation, service
proxying, audited capability grants, WebSocket sessions, or production
packaging. Those belong to the Hestia node runtime rather than the browser
extension.

## Security laws

1. **Local kernel authority.** A home node cannot dispatch Hara transitions,
   approve applications, or mutate browser-local state merely because it is
   paired.
2. **No remote runtime extension.** Discovery and status responses are data;
   they never provide executable extension code or UI.
3. **Mutual device identity.** Browsers sign requests with per-profile keys;
   nodes sign discovery, pairing, status and unpair records with a pinned node
   key.
4. **No shared bearer secret.** Compromise or removal of one browser does not
   reveal another browser's signing key or require a shared home password to be
   rotated.
5. **Explicit origin access.** Chrome origin permission is requested during the
   pairing gesture and revoked when the local link is removed.
6. **HTTPS away from loopback.** Plain HTTP is accepted only for loopback
   development. A home node reached over LAN or a private overlay network must
   use HTTPS.
7. **Transport is replaceable.** LAN routing, private DNS, reverse proxies, and
   private networking products may carry the protocol, but none become the
   Greenways identity or application authority.
