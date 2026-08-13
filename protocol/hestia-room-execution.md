# Hestia room execution boundary

Status: first inert daemon adapter for Greenways OS issue #85.

Hestia is the private-room authority. Greenways OS is the installed application,
custody, routing and execution host. A room call can advance toward execution
only after both systems independently allow the exact application and request.

## Combined authority chain

```text
Greenways local authority
  exact application descriptor and approval subject
  + active exact local capability decision

Hestia room authority
  exact room invocation
  + allowed decision retaining membership, source-mandate and room-grant roots

both exact application identities agree
  -> greenways-prepared-room-execution/0-alpha
```

The prepared value is inert. It is not a work claim, queue entry, route
selection, provider invocation, browser delivery or receipt. A later daemon
operation must acquire durable ownership and recheck current authority before
any effect.

## Imported Hestia values

Greenways OS accepts the closed imported protocols:

```text
hestia-room-invocation/0-alpha
hestia-room-authority-decision/0-alpha
```

It does not reconstruct the Hestia room policy. The adapter checks only the
closed envelope, exact decision/invocation correlation and exact roots already
returned by the pinned Hestia implementation.

An allowed decision must identify the same request, room and operation as the
invocation and retain the exact:

```text
membership root
source-mandate root
room-application-grant root
```

A denied decision is rejected and cannot project successful authority roots.

## Local Greenways evidence

`greenways-local-room-authority-evidence/0-alpha` contains:

- the exact locally installed application descriptor;
- a validated `greenways-capability-check/0-alpha`; and
- an allowed `greenways-capability-decision/0-alpha` with reason `granted`.

The local application ID, version, publisher and lock must match its approval
subject. The Hestia application identity must additionally match the local
manifest digest and exact local approval root. The local capability and its
signed grant root remain independently attributable.

A Hestia room grant therefore cannot install code or replace local application
consent. Conversely, a local application/capability grant cannot create room
membership or source authority.

## Prepared execution

`greenways-prepared-room-execution/0-alpha` retains only bounded execution and
authority metadata:

- request, room, member, source, application and operation identity;
- arguments digest and per-call limits;
- expiry and required user-interaction flag;
- exact local application approval and capability-grant roots; and
- exact Hestia membership, source-mandate and room-application-grant roots.

It deliberately contains no:

```text
provider credential or provider profile
browser cookie, account or tab authority
route or endpoint
private key or key-store handle
work/claim/lease identifier
arbitrary signing request
cleartext application arguments
```

## Execution order after this seam

The later daemon implementation must preserve:

```text
closed local request
  -> current exact local application approval
  -> current active local capability grant
  -> verified pinned Hestia import
  -> current allowed Hestia room decision
  -> prepared room execution
  -> durable actor-bound invocation ownership
  -> route/source availability
  -> browser or provider effect
  -> result and receipt binding
```

Authority denial occurs before durable ownership, route lookup, browser
delivery, vault access or provider network activity. Availability, pending host
interaction, denied authority and completed execution remain distinct states.
