# Greenways Beacon

**Greenways Beacon** is the local Hoplite gateway between Greenways OS browser profiles and [`greenways.space`](https://greenways.space).

Beacon is deliberately smaller than the earlier Greenways Home Node experiment. It does not implement a second Hestia authority, duplicate private rooms, or pretend that local service advertisements are the services themselves.

```text
Greenways OS browser
        |
        | local Beacon protocol
        v
Greenways Beacon
Hara handlers on Hoplite/Nginx
        |
        | fixed HTTPS route
        v
greenways.space
        |- Hestia: private office, identity, mandates, rooms and receipts
        |- Ignatius: agent/service execution
        `- other Space services
```

## Responsibilities

Beacon owns:

- a small local discovery and health surface;
- the approved fixed route to `greenways.space`;
- the future browser-device link and local signed outbox boundary; and
- a local place for route quality, offline state and service availability.

Greenways Space owns the remote/private service composition. Hestia, Ignatius and later services publish their capabilities through Space; they are not embedded into Beacon.

Greenways OS remains the browser kernel. Pairing a Beacon must never let Space install extension code, approve browser applications, or replace browser-local Hara state.

## Hoplite application

The product and project identity is `greenways.beacon`. Greenways OS reserves implementation namespaces beneath `gw.*`, so the Hara application is `gw.beacon`:

```clojure
:project/id greenways.beacon/service
:project/main gw.beacon
:profile/main gw.beacon/app
```

The public descriptor still reports `"id": "greenways.beacon"`; `gw.beacon` is an implementation namespace, not a second product name.

Local routes are handled by Hara:

| Route | Purpose |
| --- | --- |
| `GET /` | Beacon descriptor |
| `GET /.well-known/greenways-beacon` | Local discovery |
| `GET /beacon/v1/health` | Hoplite readiness |
| `GET /beacon/v1/status` | Configured Space relationship |

The immutable Hoplite proxy maps:

```text
/space/*  ->  https://greenways.space/beacon/v1/*
```

The destination cannot be selected by a request header or query parameter. Hoplite strips ambient cookies, browser origin and forwarding headers before proxying. Space authentication must use an explicit signed or bearer protocol.

## Operate Beacon

Install a Hoplite build that supports static upstreams, then run:

```sh
services/beacon/bin/greenways-beacon check
services/beacon/bin/greenways-beacon run
```

In another terminal:

```sh
curl http://127.0.0.1:58100/.well-known/greenways-beacon
curl http://127.0.0.1:58100/space/discovery.json
```

Other commands delegate to Hoplite:

```sh
greenways-beacon build
greenways-beacon start
greenways-beacon status
greenways-beacon reload
greenways-beacon stop
greenways-beacon install
greenways-beacon uninstall
```

`greenways-home` is retained in this directory only as a compatibility alias that prints the new name and invokes `greenways-beacon`.

## Migration from Home Node

`services/home-node/` remains the compatibility implementation for the existing `greenways-home/0-alpha` extension wire protocol while the browser migrates to Beacon. New service composition, remote routing and product language belong in Beacon.

The migration must preserve user-controlled browser keys and require an explicit decision before replacing a previously pinned node identity. The legacy Node HTTP router is not the target runtime.

See [`../../protocol/beacon.md`](../../protocol/beacon.md) for the product and trust boundary.
