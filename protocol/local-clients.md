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

## Authenticated connection sessions

An enrolled credential may now open `client.session.open` as a connection-level operation. The credential is verified against daemon authority and immediately dropped; its token is never copied into the session or durable receipt.

The returned `greenways-local-session/0-alpha` projection contains only the session ID, daemon-derived client ID and role, label, opening/expiry times, and bounded remaining-request count. The session remains attached to that Unix connection, expires after five minutes, and permits at most 128 requests.

The first authenticated semantic operations are:

```text
client.whoami
authority.clients.list
```

`client.whoami` is available to every enrolled role. `authority.clients.list` is available only to Desktop, CLI, and explicit Developer roles; the browser bridge is denied.

Durable request receipts now bind replay ownership to the authenticated client ID and fixed role. Reusing the same request ID from another client is a collision even when the semantic request bytes are identical. Session establishment is never persisted because it contains the credential proof.
