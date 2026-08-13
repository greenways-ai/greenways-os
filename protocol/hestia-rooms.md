# Hestia room authority import

Status: first import and conformance gate for
[`greenways-ai/greenways-os#63`](https://github.com/greenways-ai/greenways-os/issues/63)
and [`greenways-ai/hestia#29`](https://github.com/greenways-ai/hestia/issues/29)

## Authority law

Hestia owns room authority. Greenways OS imports it.

`greenwaysd`, Greenways Desktop, the Chrome bridge, Tahto adapters, routes, and
provider adapters must not define a parallel room descriptor, membership,
source mandate, room application grant, revocation, or room decision protocol.

```text
local Greenways authority
  exact application approval
  active local capability grant
            +
imported Hestia authority
  current room governance root
  active exact membership and epoch
  active exact source mandate
  active exact room application grant
            |
            v
only then durable invocation ownership and execution
```

A Greenways local-client role authenticates an installed process. It never
implies Hestia membership or permission to use a host source.

## Pinned import

`extension/hestia-room-authority.lock.json` binds:

- `greenways-ai/hestia` as the authority owner;
- one exact Hestia commit;
- the Hestia package and export;
- the import manifest, module, and fixture paths; and
- the SHA-256 digest of every imported file.

The `Verify Hestia room authority import` workflow checks out that exact commit,
verifies the revision and digests, validates the closed import manifest, loads
the Hestia-owned module, and executes every published conformance case.

This is an import gate, not a vendored copy. No room decision implementation is
committed to Greenways OS.

## Runtime boundary

The first gate proves package identity and decision equivalence. The following
runtime adapter must preserve the same ordering:

```text
closed local request
  -> authenticated local actor
  -> local application approval
  -> local capability grant
  -> verified pinned Hestia package
  -> Hestia room decision
  -> durable invocation claim
  -> route and source lookup
  -> browser/provider execution
  -> result and receipt binding
```

Hestia denials occur before provider claims, vault lookup, browser delivery, or
network access. Greenways OS may cache bounded verified projections for routing,
but it must retain the exact canonical Hestia membership, source-mandate, and
grant roots returned by an allowed decision.

## ChatGPT web source

The imported fixture includes a reviewed host-mediated
`greenways.chatgpt-web` source. It may expose semantic operations such as
`conversation.create`, `message.submit`, and `response.read`, while retaining
`requiresUserInteraction = true`.

The host keeps ChatGPT cookies, account credentials, tab authority, visible Send
control, and response-return control. The guest receives a bounded result and
receipts, not the host browser session.

## Next slice

After the Hestia authority PR merges, advance the lock to its reviewed merge
commit and add an internal `greenwaysd` adapter that consumes allowed decisions
without translating them into a Greenways-owned room policy.
