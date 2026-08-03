# `id.greenways.ai` service boundary

`id.greenways.ai` is the public resolver and discovery service for Greenways
identities. It is important infrastructure, but it is not an identity owner,
certificate authority, global chain, or recovery custodian.

## Responsibilities

- Resolve a stable identity ID or signed handle to the current public key,
  signed key history, public service endpoints, and voluntary authority claims.
- Publish signed handle claims and key rotations after verifying their
  controller signatures.
- Return content-rooted responses that clients verify independently.
- Cache public witnessed Hestia checkpoint references for freshness and fork
  detection without receiving private chain payloads.
- Provide discovery indexes without assigning a universal trust score.

## HTTP profile

```text
GET  /.well-known/greenways-identity
GET  /v1/identities/{identity-id}
GET  /v1/handles/{handle}
POST /v1/claims
POST /v1/rotations
POST /v1/checkpoints
```

Every successful identity or handle response uses:

```json
{
  "protocol": "greenways-identity-resolution/1",
  "identityId": "identity/...",
  "handle": "river.studio",
  "currentKey": { "keyId": "sha256:...", "publicKey": {} },
  "keyHistory": [],
  "serviceEndpoints": [],
  "witnessedCheckpoints": [],
  "resolutionRoot": "sha256:..."
}
```

`resolutionRoot` covers every other response field using the Greenways
canonical JSON profile. A client trusts the returned key only after validating
the signed key history from a key it already accepts, a directly exchanged
identity card, or a workflow-selected authority. TLS protects transport but is
not the identity proof.

Handle collisions are returned as search results rather than silently choosing
a winner. Stable identity IDs and verified key histories remain canonical.
