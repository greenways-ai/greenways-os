# Hestia boundary

Hestia is a person's append-only signing history. It is not a shared global
blockchain and Greenways OS never searches for or elects a universal head.

Greenways OS signs an action first. A person may then include that same action
root in their Hestia chain. Collaborators and chosen authorities may include
the same root in their own chains or retain encrypted backups. Each inclusion
has its own sequence, previous hash, timestamp, and signature.

The minimal server discovery and append contract is:

```text
GET  /.well-known/hestia
POST /greenways/v1/actions
```

Discovery identifies the Hestia instance, supported protocol versions, append
endpoint, and public checkpoint endpoint. Append accepts a signed action plus
the owner's personal-chain inclusion. A server must reject an invalid action
signature, a broken previous hash, or an inclusion signed by a key that is not
authorized for that personal chain.

The browser outbox stores and sends entries in this shape:

```json
{
  "protocol": "greenways-sync-entry/1",
  "action": { "protocol": "greenways-action/1", "root": "sha256:…", "signature": "…" },
  "inclusion": { "protocol": "greenways-personal-chain/1", "actionRoot": "sha256:…", "eventHash": "sha256:…", "signature": "…" }
}
```

The append body uses `greenways-sync/1` and an `entries` array. Greenways OS
removes a batch from the local outbox only when Hestia acknowledges the exact
full count. Redirects are rejected so a scoped device token is never forwarded
to another origin. Entries are sent in personal-chain order. A Hestia node must
treat an already retained action root or inclusion event hash idempotently, so a
lost acknowledgement or a one-time chain migration can safely resend it.

Version 0.3 replaces the prototype's unsigned local inclusions. A valid legacy
profile is upgraded under the personal-chain lock: the controller key becomes
non-extractable, every inclusion is owner-signed, and the complete rebuilt chain
is queued once so Hestia can observe every new link. The identity record retains
an owner-signed `@greenways/personal-chain-migrated` action containing the old
and new heads, an old→new hash mapping for every action root, and the roots that
were pending before migration. Evidence and recovery exports carry this bridge.
Invalid or mixed legacy state is never rewritten; Home instead offers a
private-key-free recovery export.

Backups are witnesses, not consensus participants. A witness receipt says
which action root or personal checkpoint the authority retained, when it did
so, and under which published retention policy. It does not make the witness
the owner of the identity or contribution.
