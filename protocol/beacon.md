# Greenways Beacon

## Product boundary

**Greenways Beacon** is a user-controlled local gateway that connects Greenways OS browser profiles to [`greenways.space`](https://greenways.space).

Its product and code identity is `greenways.beacon`. The executable is `greenways-beacon`; `greenways-home` is a temporary compatibility alias during migration from the first Home Link prototype.

Beacon is built as a Hara application on Hoplite. Hoplite owns the HTTP/Nginx edge, immutable route plan and local management realm. Hara owns the inspectable discovery and gateway policy.

Beacon is not Hestia and does not contain a second private-office authority. Greenways Space composes Hestia, Ignatius and other Greenways services behind a signed service catalogue.

```text
┌────────────────────── Greenways OS ──────────────────────┐
│ browser-local Hara kernel, app approvals, keys, outbox   │
└────────────────────────────┬──────────────────────────────┘
                             │ local Beacon protocol
┌────────────────────────────▼──────────────────────────────┐
│ Greenways Beacon                                          │
│ Hoplite/Nginx ingress + Hara discovery and local policy   │
│ fixed route: /space/ -> greenways.space/beacon/v1/        │
└────────────────────────────┬──────────────────────────────┘
                             │ explicit signed service calls
┌────────────────────────────▼──────────────────────────────┐
│ greenways.space                                           │
│ ├─ Hestia: identity, private offices, rooms and receipts  │
│ ├─ Ignatius: agents and service execution                 │
│ └─ Historia and later Space services                      │
└───────────────────────────────────────────────────────────┘
```

## Authority split

### Greenways OS

The browser decides:

- which applications are installed and locally approved;
- which application may ask for a Beacon or Space capability;
- which browser key signs a request; and
- what remains in the local outbox while offline.

### Beacon

The local gateway decides:

- which Space origin and path are present in the built route plan;
- whether the local edge is ready;
- which future browser-device grants are active at this Beacon; and
- when local work may be forwarded, queued or marked degraded.

Beacon does not approve extension applications, receive executable UI from Space, or infer authority from a network address alone.

### Greenways Space

Space decides:

- which Hestia, Ignatius and other services are available;
- which signed service capabilities a browser or Beacon may use;
- how private rooms, mandates, jobs and receipts are persisted; and
- which public or private participation surfaces are exposed.

Space cannot mutate browser-local kernel state merely because Beacon can reach it.

## First Hoplite profile

Beacon exposes local Hara routes:

```text
GET /.well-known/greenways-beacon
GET /beacon/v1/health
GET /beacon/v1/status
```

The descriptor uses `greenways-beacon/1` and names the fixed Space relationship. It is public local metadata and contains no device key, bearer token, browser history or application state.

Hoplite also renders one immutable Nginx prefix:

```text
/space/ -> https://greenways.space/beacon/v1/
```

The method, query and body pass through Nginx. The request cannot choose another origin. Remote cleartext, user information, Nginx variables, query-bearing upstream configuration, fragments and traversal segments fail the Hoplite build.

Ambient local cookies, `Origin`, `Referer` and forwarding headers are removed before proxying. `Authorization` and explicit Greenways signature headers remain available for the Space protocol. A route is transport approval, not service authorization.

## Space discovery

The first Space endpoint is:

```text
GET https://greenways.space/beacon/v1/discovery.json
```

Through the local gateway this becomes:

```text
GET http://127.0.0.1:58100/space/discovery.json
```

The `greenways-space/1` record identifies Space and lists service descriptors for Hestia, Ignatius and later modules. Descriptors are inert data. They may include service IDs, protocol versions, capability names and status; they cannot contain JavaScript, Wasm, HAL, HTML, extension entrypoints or another executable payload.

A production Space catalogue will be signed by the Space identity and bound to an expiry/revision. Beacon and Greenways OS must reject a changed signing identity unless the user deliberately trusts the replacement.

## Browser-device migration

The legacy `greenways-home/1` prototype has a useful per-browser P-256 pairing model, but it also created a parallel Node-owned authority and service registry. Migration proceeds in stages:

1. Ship Beacon as the new Hoplite edge and product identity.
2. Keep the old Home Link implementation available only for existing paired browsers.
3. Define `greenways-beacon-device/1` using browser-held non-extractable keys and Hoplite-owned application authentication/store adapters.
4. Let a user explicitly bind or re-enrol each browser with Beacon.
5. Remove the Node HTTP service after exports, revocation and recovery have conformance coverage.

No migration silently copies a reusable administrator credential or treats possession of the old state file as permission to replace a pinned Beacon identity.

## Security laws

1. **Hoplite is the edge.** Beacon HTTP routing and fixed upstreams are built from the selected Hoplite project; a standalone Node router is not the target service.
2. **Space is the service plane.** Hestia, Ignatius and other remote/private services are composed by Greenways Space, not duplicated inside Beacon.
3. **The browser remains local authority.** Beacon and Space cannot install apps or dispatch browser-kernel transitions without a locally approved capability.
4. **No request-selected upstream.** The Space origin is immutable build data. Headers, paths and query values cannot turn Beacon into a forward proxy.
5. **No ambient authority forwarding.** Local cookies and browser-origin headers do not become Space credentials.
6. **Explicit service authentication.** Private Space calls use signed device/session records or another named protocol, never reachability alone.
7. **No remote code catalogue.** Beacon and Space descriptors remain inert data.
8. **Offline is valid.** An unavailable Space never prevents Greenways OS from launching local applications or preserving signed local work.

## Delivery sequence

### Beacon 0.1 — Hoplite ingress

- `greenways.beacon` Hara application;
- local discovery, health and status;
- fixed `/space/` HTTPS upstream;
- Greenways Space discovery record; and
- `greenways-beacon` operator wrapper with a temporary `greenways-home` alias.

### Beacon 0.2 — Device grants

- Hoplite application-realm browser enrolment;
- per-browser names, revocation and signed presence;
- explicit migration from legacy Home Link identities; and
- local device and route inspection in the Greenways visual language.

### Beacon 0.3 — Durable offline bridge

- signed local outbox;
- acknowledged Space event roots;
- route quality and failover state;
- bounded service capability grants; and
- direct/private route adapters without exposing Beacon administration.
