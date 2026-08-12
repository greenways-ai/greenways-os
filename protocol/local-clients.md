# Greenways local client enrolment

Status: durable enrolment slice for issue #51.

## Purpose

A private Unix socket proves only that a process runs as the same operating-system user. It does not identify whether the caller is Greenways Desktop, the CLI, the reviewed Chrome bridge, or explicit developer tooling.

`greenwaysd` therefore owns a closed local-client registry before privileged local IPC is introduced:

```text
greenways-admin client issue
        │
        ├── private one-time credential file
        │
        └── daemon registry with SHA-256 digest only
                         │
                         ▼
                 future session.open
```

## Fixed roles

The first role vocabulary is closed:

```text
desktop
cli
browser-bridge
developer
```

A role is selected by offline administration, persisted by the daemon authority, and included in the credential file. A client request cannot select, replace, or expand it.

## Registry record

The private daemon registry stores:

```json
{
  "protocol": "greenways-local-client-registry/0-alpha",
  "revision": 1,
  "clients": [
    {
      "protocol": "greenways-local-client/0-alpha",
      "id": "local/client/…",
      "role": "browser-bridge",
      "label": "Chrome bridge",
      "tokenDigest": "sha256:…",
      "createdAtUnixMs": 1,
      "revokedAtUnixMs": null
    }
  ]
}
```

It never stores the credential token.

## Credential file

Issuance writes one new mode-0600 file and refuses to overwrite an existing path:

```json
{
  "protocol": "greenways-local-client-credential/0-alpha",
  "clientId": "local/client/…",
  "role": "browser-bridge",
  "token": "gwc_…",
  "issuedAtUnixMs": 1
}
```

The token is not printed, logged, placed in command-line arguments, returned through ordinary IPC, or copied into daemon request receipts. Its in-memory Rust string is zeroised on drop.

## Administration

```sh
greenways-admin client issue   --role desktop   --label "Greenways Desktop"   --output ~/.greenways/clients/desktop.json

greenways-admin client list

greenways-admin client revoke   --id local/client/…
```

Issuance and revocation require `greenwaysd` to be stopped so the offline administrator and daemon never become concurrent metadata writers. Read-only listing may occur while the daemon is running.

## Revocation and verification

- Credential verification binds protocol, client ID, fixed role, issue time, and token digest.
- Digest comparison is constant-time after closed-shape validation.
- Revocation is final and survives daemon restart.
- A changed token, role, issue time, or client ID is rejected with one non-diagnostic credential error.
- Registry and credential files are closed, versioned, bounded, atomically written, and private to the operating-system user.

## Current exclusion

This slice creates durable enrolment only. It does not yet authenticate socket requests or expose privileged operations.

The next slice will add a connection-bound, expiring `greenways-local-session/0-alpha` created from a valid credential. Session authority will be derived from the daemon registry, never from caller JSON.
