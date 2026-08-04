# Hestia Home Node

## Product definition

A **Hestia Home Node** is a user-controlled service host that gives one or
more Greenways OS browser profiles a stable private home.

Greenways OS remains useful with no server and no account. Pairing a home node
adds durable services, shared state and remote reachability without moving the
browser kernel's authority into a cloud account.

The product vocabulary is:

- **Greenways OS** — the browser-resident local participation kernel and shell;
- **Hestia Home Node** — the user-facing home server and signed service registry;
- **Hestia node runtime** — the native service installed on the home machine;
- **Home Link** — the authenticated relationship between a browser profile and
  a Hestia Home Node;
- **Home Service** — a capability advertised by the node, such as Historia,
  an agent runtime, files, models or a Hara execution service.

Hestia is the home authority: it owns node identity, signed state, rooms and the
service registry. Historia, Hara, agents, files and other modules are Home
Services advertised through it. Home Link transport remains replaceable.

## Goals

1. Every browser profile is an independently identifiable Greenways device.
2. Several browsers can pair with one home node without sharing extractable
   secrets.
3. Local-only operation remains complete enough to launch apps, work offline
   and queue signed records.
4. Home services are discovered and authorized individually.
5. Remote access works over user-selected transports rather than requiring one
   network vendor.
6. Public participation is separate from private home connectivity.

## Non-goals

The first Home Link release is not:

- a general replacement for an operating-system VPN;
- a public reverse proxy;
- an implicit backup of all browser data;
- a cloud account that becomes authoritative over the local kernel;
- permission for every installed Greenways app to call every home service.

## System model

```text
┌──────────────────────── Browser profile ────────────────────────┐
│ Greenways OS                                                    │
│ ├─ non-extractable browser device key                           │
│ ├─ local Hara kernel                                             │
│ ├─ installed app approvals                                       │
│ ├─ signed outbox                                                 │
│ └─ Home Link client                                              │
└─────────────────────────────┬────────────────────────────────────┘
                              │ signed HTTPS / WebSocket requests
                              │ over a selected transport
┌─────────────────────────────▼────────────────────────────────────┐
│ Hestia Home Node                                                  │
│ ├─ node identity, pairing authority and device registry           │
│ ├─ signed records, documents and private rooms                    │
│ ├─ service registry, capability grants and revocation log         │
│ └─ Home Services                                                  │
│    ├─ Historia: local conversation archive                        │
│    ├─ Hara: execution sessions and package cache                  │
│    ├─ Agents: supervised jobs and receipts                        │
│    └─ Files / models / media                                      │
└──────────────────────────────────────────────────────────────────┘
```

The browser kernel and the home node have different responsibilities. The
browser decides which app may request an operation. The home node decides
whether that browser device may use the requested service and capability.
Neither side treats a network location alone as identity.

## Pairing

Pairing should replace the current long-lived manually entered Hestia token.

1. The home node creates a single-use pairing invitation containing:
   - node identity and public key;
   - reachable origins;
   - expiry;
   - requested browser label;
   - a random challenge.
2. The user opens the invitation as a QR code, short code or local discovery
   result inside Greenways OS.
3. The browser signs the challenge with its non-extractable device key.
4. The home node records the browser public key and returns a signed device
   grant scoped to the Home Link protocol.
5. The browser stores the node identity, signed grant and approved origin. It
   does not store a reusable administrator credential.
6. Service capabilities are granted separately after pairing.

A browser profile can be revoked without rotating the keys of other browsers.
A browser can also remove its local Home Link while leaving server-side audit
records intact.

## Service discovery

After pairing, Greenways OS requests a signed service catalogue:

```json
{
  "node": "home:cedar",
  "revision": 12,
  "services": [
    {
      "id": "hestia.records",
      "version": "1",
      "transport": "https",
      "endpoint": "/services/hestia/records",
      "capabilities": ["append", "query"]
    },
    {
      "id": "historia.archive",
      "version": "1",
      "transport": "https",
      "endpoint": "/services/historia/archive",
      "capabilities": ["collect", "search"]
    }
  ],
  "signature": "..."
}
```

App manifests declare service requirements by stable service identifier, not by
hard-coded host or port. Greenways OS intersects three approvals before calling
a service:

1. the app's locally approved capability;
2. the browser device's grant from the home node;
3. the currently advertised service capability.

## Transport adapters

Home Link is an application protocol and must not be coupled to a single route.
A node can advertise several transports in preference order.

### Same-machine and LAN

The first route is explicit HTTPS to loopback or a trusted LAN origin. Local
network discovery may suggest nodes, but discovery never grants trust. Pairing
still requires a signed challenge and user action.

### Existing private mesh

Tailscale, Headscale, WireGuard and similar private networks can carry Home Link
traffic. Greenways OS should treat these as route providers, not as identity or
application authorization. A `.ts.net` origin is one valid route, not a required
Greenways account dependency.

### Optional Greenways relay

A later relay may connect two already-paired endpoints when direct networking is
unavailable. The relay sees encrypted frames and routing metadata, but does not
hold Home Link device authority or service plaintext.

### Native browser bridge

Arbitrary browser-profile routing, SOCKS/HTTP proxying, SSH and raw port access
require a native companion under current browser extension constraints. The
experimental Tailscale browser extension uses Native Messaging and a local
proxy for the same reason.

The Hestia node runtime can expose a narrowly scoped Native Messaging host to
Greenways OS. This is a later transport mode. The initial Home Link should use ordinary
extension-approved HTTPS/WebSocket origins and avoid intercepting unrelated web
traffic.

## Offline and synchronization semantics

The browser remains authoritative for uncommitted local work.

- Operations that can be replayed are written to a signed local outbox.
- The home node acknowledges accepted event hashes.
- Acknowledged records are removed from the outbox only after the response is
  committed locally.
- An unavailable node never prevents local app launch.
- Non-replayable effects use prepared receipts and explicit uncertain outcomes.
- The launcher displays local, pairing, connected, degraded and revoked states
  separately.

## Launcher model

The Home Node is a top-level OS object above the app catalogue.

The launcher should always answer:

- Is this browser's local kernel ready?
- Is a home node paired?
- Which route is active?
- Which browser profile is this?
- Which services are available?
- What is waiting to synchronize?
- Which devices and apps have grants?

The app catalogue remains below this Home section. The Hestia connector is the
control surface for the node relationship; Historia and future Home Services
may also appear as user-facing apps. Pairing the node is not represented as
installing an ordinary app.

## Security requirements

- Device private keys are non-extractable where the browser platform permits.
- Pairing invitations are single use and short lived.
- Node identity changes require an explicit re-pairing decision.
- Origin permission and device authorization are separate checks.
- Service responses are signed or bound to the authenticated session.
- Every capability grant is inspectable and revocable.
- Home services listen on loopback by default when fronted by a private routing
  layer.
- Public invitations are service-specific and never imply home administration.
- Removing a connector revokes its browser origin access.

## Delivery sequence

### 0.4 — Home-shaped launcher

- Apply the shared precision-material visual language.
- Promote Home Node state above the app catalogue.
- Reframe the existing Hestia origin connector as the first Home Link surface.
- Preserve current explicit-origin and signed-outbox behavior.

### 0.5 — Device pairing and service registry

- Add home-node identity and browser challenge-response pairing.
- Replace stored reusable tokens with signed device grants.
- Add service discovery, device naming, revocation and capability inspection.
- Package the Hestia Home Node runtime for macOS and Linux through the
  Greenways Homebrew tap.

### 0.6 — Private route adapters

- Add LAN discovery as a suggestion mechanism.
- Document and test Tailscale/Headscale routes.
- Add connection quality, route failover and degraded-state handling.

### 0.7 — Native bridge

- Add the reviewed Native Messaging host.
- Support explicitly selected browser-only proxy and port-forward sessions.
- Keep unrelated browser traffic outside the bridge by default.
