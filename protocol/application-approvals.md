# Greenways daemon application approvals

Status: executable daemon-owned application authority for issue #51 and repair issue #76.

## Purpose

An installed application is not authorised merely because its manifest can be parsed or because a local client can authenticate to `greenwaysd`. The daemon first commits one profile-signed approval for the exact reviewed application evidence:

```text
application ID + semantic version + publisher
                   +
        manifest digest + optional lock digest
                   +
        canonical declared capability set
                   │
                   ▼
   profile-signed application approval
                   │
          separate signed revocation
```

Local roles identify processes on one installation. They do not imply application approval, Greenway membership, room membership, provider access, or permission to use a host's ChatGPT source.

## Exact descriptor

The signed descriptor uses the closed `ApplicationDescriptor` shape:

```json
{
  "appId": "hara-playground",
  "version": "1.2.3",
  "publisherId": "hara-lang",
  "manifestDigest": "sha256:…",
  "lockDigest": "sha256:…"
}
```

`lockDigest` may be absent. Every digest is lower-case SHA-256 evidence. Application and publisher identifiers and semantic versions must already be canonical.

The approval body uses `greenways-application-approval/0-alpha` and also contains:

- a sorted, duplicate-free list of no more than 64 declared operation capabilities;
- the approval time;
- the issuing profile identity ID; and
- the issuing profile key ID.

The profile identity signs the complete typed subject:

```text
greenways-application-approval-subject/0-alpha
```

The resulting `subjectRoot` is the `approvalDigest` used by application capability grants and exact capability checks. The root therefore commits the manifest, lock, publisher, version, declared capabilities, approval time, and issuer—not only the visible application name.

## Durable authority

`greenways-applications` stores bounded immutable signed approvals and revocations in:

```text
$GREENWAYS_HOME/state/applications.json
```

The state file is private, atomically replaced, fsynced, and validated completely on reopen. Validation includes:

- signed profile identity and fixed-width P-256 signature verification;
- exact typed-subject root verification;
- canonical descriptor and capability validation;
- unique approval roots and revocation IDs;
- at most one active approval for an exact app/version/publisher coordinate;
- one revocation per approval; and
- issuer, application, timestamp, and referenced-root equality across revocation.

Editing a manifest digest, capability declaration, signature, issuer, application identity, or revocation target makes the authority fail closed at startup.

## Revocation

An approval is not rewritten. `greenways-application-revocation/0-alpha` names:

- one exact approval subject root;
- the complete application descriptor from that approval;
- a bounded reason;
- a revocation time; and
- the same issuing profile identity and key.

It is signed as:

```text
greenways-application-revocation-subject/0-alpha
```

Repeating the same revocation returns the existing immutable record. A different profile identity cannot revoke the approval, and a revocation cannot be redirected to another application.

## Exact authorisation

The internal authority exposes two closed decisions:

```text
authorize_subject(application approval subject, observation time)
authorize_exact(application approval subject, capability, observation time)
```

The second decision succeeds only when:

1. the supplied `approvalDigest` identifies a stored signed approval;
2. all visible application-subject fields exactly match that approval;
3. the approval is active and not revoked; and
4. the requested capability is in the signed declared-capability set.

Closed denial reasons are:

```text
approval-not-found
approval-subject-mismatch
approval-revoked
approval-not-yet-effective
capability-not-declared
```

The application decision does not itself grant the operation. A consequential operation must also obtain a matching active signed capability grant.

## Offline administration

Application mutation is deliberately offline while `greenwaysd` is stopped:

```sh
greenways-admin application approve \
  --app-id hara-playground \
  --app-version 1.2.3 \
  --publisher hara-lang \
  --manifest-digest sha256:… \
  --lock-digest sha256:… \
  --capability model/generate \
  --capability tahto/read

greenways-admin application revoke \
  --approval-digest sha256:… \
  --reason user-revoked
```

Status and list are read-only. The ordinary local protocol exposes no application mutation, arbitrary signing, private-key export, manifest rewrite, generic filesystem read, or provider credential operation.

Capability issuance now refuses to sign a grant unless this application authority first confirms the exact approval and that the requested capability was declared.

## Browser and room consequence

The browser bridge may ask for one exact combined capability decision through `capabilities.check`; it cannot enumerate approvals or grants. Future room sharing must sign room membership and per-application grants that reference this public approval/source evidence. It must never transfer the host's provider credential, keyring handle, browser cookie, or local client role.
