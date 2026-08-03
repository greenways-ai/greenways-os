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

Backups are witnesses, not consensus participants. A witness receipt says
which action root or personal checkpoint the authority retained, when it did
so, and under which published retention policy. It does not make the witness
the owner of the identity or contribution.
