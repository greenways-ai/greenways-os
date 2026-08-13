# Greenways daemon capability grants

Status: executable signed application-and-capability authority for issue #51 and repair issue #76.

## Purpose

Greenways application capabilities move from browser-resident mutable authority into an immutable, profile-signed daemon record set.

```text
exact application approval
          │
          ▼
closed capability policy
          │
          ▼
profile-key signed grant
          │
          ├── expiry
          └── separate signed revocation
```

The daemon now combines this grant authority with the signed application approval registry. A grant is usable only after the exact application approval is active and the operation is present in its signed declared-capability set.

## Exact application subject

A capability grant is bound to:

```json
{
  "kind": "app",
  "appId": "hara-playground",
  "version": "1.2.3",
  "publisherId": "hara-lang",
  "lockDigest": null,
  "approvalDigest": "sha256:…"
}
```

`approvalDigest` identifies the exact reviewed application approval. A changed manifest, package lock, publisher, version, or approval digest is another subject and cannot reuse the grant.

## Grant

The immutable grant body uses `greenways-capability-grant/0-alpha` and contains:

- a random grant ID;
- one closed operation capability;
- the exact application subject;
- bounded non-secret scalar constraints;
- issuance and optional expiry times;
- the issuing profile identity and key IDs.

The profile identity signs the exact typed subject:

```text
greenways-capability-grant-subject/0-alpha
```

The portable envelope includes the issuer’s self-signed public identity, the subject root, and a fixed-width P-256 signature. Independent readers can therefore verify the complete record without receiving a key handle or contacting the local key store.

## Revocation

A grant is never rewritten. Revocation is another immutable profile-signed record using:

```text
greenways-capability-revocation-subject/0-alpha
```

The revocation binds:

- the grant ID;
- the exact original grant subject root;
- a bounded non-secret reason;
- the revocation time;
- the same profile identity and key that issued the grant.

Only one revocation may exist per grant. Repeating the same administrative revocation returns the existing record.

## Closed policy

The first daemon vocabulary mirrors the operation-grantable capabilities already published by the Greenways Hara service graph:

```text
hestia/propose
hestia/approve
hestia/execute
chats/capture
userscripts/manage
key/public
key/sign
credential/manage
credential/use
model/generate
model/provide
mcp/pair
tahto/connect
tahto/read
tahto/write
```

Capabilities such as `kernel/eval`, `browser/call`, `storage/local`, `tabs/open`, or undeclared future operations cannot be issued by this authority.

Trusted-publisher restrictions are preserved for the privileged packaged services:

```text
chats/capture       greenways-ai
userscripts/manage  greenways-ai
credential/manage   greenways-ai
model/provide       greenways-ai
mcp/pair            greenways-ai
```

## Decisions

A decision compares the complete current application subject and capability against signed records at an explicit observation time.

The closed `greenways-capability-check/0-alpha` request contains exactly one application approval subject and one operation capability. `greenwaysd` first evaluates the signed application approval and only then evaluates the signed grant.

Possible reasons are closed and non-secret:

```text
approval-not-found
approval-subject-mismatch
approval-revoked
approval-not-yet-effective
capability-not-declared
granted
no-current-grant
grant-expired
grant-revoked
capability-not-grantable
```

An allowed decision also identifies the exact grant ID and grant subject root. Application denials contain no grant reference because grant lookup has not occurred.

A grant for an old approval digest is not a partial match and is never carried to an update.

## Persistence

The authority store uses a private, bounded JSON state file with:

- exact signed grants;
- exact signed revocations;
- unique record IDs;
- one revocation per grant;
- a revision equal to the number of committed records;
- signature, issuer, policy, reference, expiry, and root validation on every reopen;
- atomic temporary-file replacement, file synchronization, and private permissions.

Corrupt or edited records fail closed during startup. No key material, key handle, provider credential, browser token, or session authority is stored in the capability file.

## Signing boundary

The profile key can now sign only five explicit subjects:

```text
greenways-profile-identity-subject/0-alpha
greenways-application-approval-subject/0-alpha
greenways-application-revocation-subject/0-alpha
greenways-capability-grant-subject/0-alpha
greenways-capability-revocation-subject/0-alpha
```

There remains no `crypto.sign`, `identity.sign`, arbitrary-byte signing, private-key export, or caller-selected protocol operation.


## Daemon read integration

`greenwaysd` opens and validates both the private application and capability authority files during startup. Authenticated local operations are:

```text
capabilities.status
capabilities.list
capabilities.check
```

Desktop, CLI, and explicit Developer roles may inspect status and inventory. The browser bridge cannot list or count authority records, but it may request one exact `capabilities.check` decision for a reviewed application operation. All three remain actor-bound daemon requests with exact replay and request-ID collision semantics.


## Offline administration

`greenways-admin capability issue` and `capability revoke` are the first mutation surfaces. Both require the daemon socket to be inactive before opening the identity and capability metadata files. Issuance accepts only the exact capability and application approval fields; before signing, it reopens the signed application registry and requires an active exact approval that declared that capability.

`model/generate` adds one reviewed typed policy vocabulary rather than accepting arbitrary constraint JSON:

```text
provider.profile-id
provider.model
provider.max-output-tokens
provider.max-timeout-ms
```

All four fields are required for a new `model/generate` grant. Profile and model are exact; invocation limits must not exceed the signed maxima. Provider-prefixed constraints are rejected on other capabilities, and unknown or incorrectly typed provider fields fail closed. Older empty-policy `model/generate` grants remain verifiable for migration but cannot authorize provider execution. Revocation accepts only an existing grant ID and bounded reason.

The signed grant or revocation is committed before the command reports success. Re-running a revocation returns the existing immutable revocation. No corresponding mutation operation exists on ordinary local IPC.


See [`application-approvals.md`](application-approvals.md) for the signed manifest, lock, declared-capability, and revocation authority that precedes every grant decision.
