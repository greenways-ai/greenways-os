# Greenways daemon capability grants

Status: signed authority-core slice for issue #51.

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

This slice establishes record semantics and durable authority storage. Local IPC and administration are added in a subsequent integration PR.

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

Possible reasons are closed and non-secret:

```text
granted
no-current-grant
grant-expired
grant-revoked
capability-not-grantable
```

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

The profile key can now sign only three explicit subjects:

```text
greenways-profile-identity-subject/0-alpha
greenways-capability-grant-subject/0-alpha
greenways-capability-revocation-subject/0-alpha
```

There remains no `crypto.sign`, `identity.sign`, arbitrary-byte signing, private-key export, or caller-selected protocol operation.
