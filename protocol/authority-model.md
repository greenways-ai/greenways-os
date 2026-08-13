# Greenways authority model

Greenways uses several independent security decisions. They must not be
collapsed into a single `auth` flag because each has a different issuer,
lifetime and failure meaning.

## Vocabulary

| Term | Meaning | Does not imply |
| --- | --- | --- |
| Verification | A signature, digest, timestamp, canonical encoding or other fact is valid. | Permission to perform an operation. |
| Authentication | A live connection or signed request is bound to an enrolled identity. | Application approval, a capability grant or room membership. |
| Approval | A person or profile accepts one exact subject, such as an application build or action root. | A reusable operation grant. |
| Grant | A durable, bounded delegation of named operations to an exact subject. | Installation, identity or possession of provider credentials. |
| Authorization decision | Current approvals, grants, revocations, limits and observation time produce an allow or deny result. | Successful request admission or data visibility. |
| Admission | Verified and authorized evidence is accepted into a state machine with replay and idempotency rules. | Access to unrelated records in the same physical store. |
| Resource scope | A record or object is reachable through the exact application, namespace and collection coordinate. | Caller permission; that decision must already exist. |
| Resource ownership | A host binds an opaque handle to exact work and a finite lifetime. | User, application or room authority. |

Integrity and semantic validation are also distinct from authorization. A
provider can prove that bytes match a digest and decode as canonical HTA while
remaining unable to decide which application may read them.

## Ownership

### Greenways OS and `greenwaysd`

Greenways OS owns local client authentication, installed profile identity,
exact application approval, local capability grants, key and credential
custody, and the final composition of all authority required for an execution.
A local role identifies an installed process; it is never an application grant
or Hestia membership.

### Hestia

Hestia owns shared private-room governance: membership, source mandates, room
application grants, exact-root human approval, revocation and attributable
authority receipts. Hestia authority is an additional requirement for a shared
or room-scoped action. Purely local personal operations do not require a Hestia
decision.

### Tahto

Tahto consumes an allowed, request-bound authority decision. It authenticates
the signed request against its enrolled device record, admits the request under
nonce and idempotency laws, and enforces application/namespace/collection
scope. Tahto does not issue local application grants, create Hestia membership
or reinterpret either authority system.

### Hoplite and installed providers

Hoplite supplies bounded transport and generic host calls. Installed providers
verify cryptographic and byte-integrity facts and own ephemeral resource
handles. Neither makes user, application or room authorization decisions.

## Required order

```text
verify request evidence
  -> authenticate the live caller or enrolled device
  -> evaluate the exact local application and capability authority
  -> evaluate Hestia room authority when the action is shared
  -> project one request-bound allowed decision
  -> admit the request and replay evidence in Tahto
  -> enforce Tahto coordinate and namespace reachability
  -> invoke the generic provider
  -> validate provider integrity and semantic evidence
```

Denial, unavailable authority, pending user interaction, admission failure,
out-of-scope data and provider-integrity failure remain separate results.

