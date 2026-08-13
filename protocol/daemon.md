# Greenways daemon and local-client protocol

Status: executable daemon with authenticated clients, signed application/capability authority, profile identity, vault, and typed provider boundary
Local request protocol: `greenways-local/0-alpha`
Local result protocol: `greenways-local-result/0-alpha`
Daemon state protocol: `greenways-daemon-state/0-alpha`

## Purpose

Greenways is migrating from a browser-kernel-first system to one authoritative local service:

```text
Greenways Desktop (Flutter) ─┐
greenways CLI                ├─ closed local IPC ─► greenwaysd
Chrome Native Messaging      ┘
```

Greenways Desktop and Greenways Server package the same daemon binary and storage semantics. Flutter presents state and collects user intent. The Chrome extension retains reviewed browser-specific effects. `greenwaysd` validates, authorises, executes, signs, persists, and synchronises durable Greenways operations.

The current executable boundary establishes daemon recovery, local IPC, enrolled client credentials, connection-bound sessions, actor-bound receipts, provider credential custody, one daemon-owned P-256 profile identity, signed application approvals, signed capability grants, one exact combined capability decision, and typed provider invocation.

## Local endpoint

On macOS and Linux the endpoint is a Unix-domain socket:

```text
$GREENWAYS_HOME/run/greenwaysd.sock
$HOME/.greenways/run/greenwaysd.sock
```

The containing directories are mode `0700`; the socket and state file are mode `0600`. The daemon listens only on the local filesystem namespace. It does not open a TCP port, enable browser CORS, or infer authority from an IP address.

Windows must use a named pipe with equivalent user isolation before the Windows Desktop or Server package is released. The current implementation fails closed on non-Unix platforms.

## Request envelope

Public operations use a one-shot connection carrying one bounded JSON request and result. Authenticated clients first send `client.session.open` with a private enrolled-client credential, then carry bounded semantic requests on the same Unix connection until the session expires, is exhausted, or the connection closes. The credential is discarded after verification and is never copied into the session or durable state.

```json
{
  "protocol": "greenways-local/0-alpha",
  "requestId": "local/request/0123456789abcdef",
  "operation": "status",
  "arguments": {}
}
```

The current operation policy is:

| Operation | Public | Desktop | CLI | Browser bridge | Developer |
| --- | ---: | ---: | ---: | ---: | ---: |
| `status` | Yes | Yes | Yes | Yes | Yes |
| `paths` | Yes | Yes | Yes | Yes | Yes |
| `client.whoami` | No | Yes | Yes | Yes | Yes |
| `identity.status` | No | Yes | Yes | Yes | Yes |
| `identity.public-card` | No | Yes | Yes | Yes | Yes |
| `authority.clients.list` | No | Yes | Yes | No | Yes |
| `vault.status` | No | Yes | Yes | No | Yes |
| `provider.invoke` | No | Yes | Yes | No | Yes |
| `capabilities.status` | No | Yes | Yes | No | Yes |
| `capabilities.list` | No | Yes | Yes | No | Yes |
| `capabilities.check` | No | Yes | Yes | Yes | Yes |

Roles come from the daemon-owned local-client registry. Request JSON cannot select or expand them. Local roles authenticate an installation process; they are not Greenway membership, room membership, source mandates, application grants, or provider grants.

Current inventory reads accept an empty argument object. `capabilities.check` accepts one closed `greenways-capability-check/0-alpha` value containing the exact signed application subject and one operation capability. `provider.invoke` accepts only the closed, bounded provider invocation value and fixed provider adapters. Unknown fields, operations, protocols, malformed request IDs, unauthenticated privileged operations, and role-denied operations fail closed. Request bytes are limited to 64 KiB; responses are limited to 256 KiB.

## Durable request semantics

Before returning an ordinary semantic result, the daemon stores a bounded receipt containing:

```text
exact canonical request
SHA-256 request digest
exact result
request ID
authenticated local client ID and fixed role, when present
commit time
```

An exact request replays only for the same authenticated actor. Reusing a request ID with different bytes or from another client or role returns `request-id-collision`. Session IDs and credential tokens are never durable. Authentication and role denial happen before durable request ownership.

Provider invocation uses a separate bounded claim ledger. The daemon durably claims an actor-bound request before external execution, replays definitive results and provider errors without calling the provider again, and retains an uncertain claim when the external outcome cannot be known. An uncertain request is not retried automatically because doing so could duplicate a billable effect.

State is written to a private temporary file, fsynced, atomically renamed, and followed by parent-directory sync.

## Daemon identity

The daemon creates one persistent random node identity:

```text
node/<32 lowercase hexadecimal characters>
```

Each successful process start increments `generation`. Node identity survives restart. A copied state directory must not later be interpreted as permission to run two active copies of the same node; enrolment, backup, restore, and identity replacement are tracked separately.


## Application and capability authority

`greenwaysd` validates two private immutable record sets at startup:

```text
state/applications.json   signed approval and revocation evidence
state/capabilities.json   signed grant and revocation evidence
```

An exact capability decision evaluates application approval first. Grant lookup occurs only after the approval root, application fields, effective time, revocation state, and signed declared-capability set all pass. The result is bounded and identifies the exact grant root only when grant evaluation was reached.

Browser Bridge may request one exact decision but cannot enumerate either authority. Local process roles remain separate from application and future room/source authority.

Application approvals and capability grants are mutated only through offline administration while the daemon is stopped. Ordinary local IPC has no mutation or arbitrary-signing operation.

## Profile identity and vault

`greenwaysd` owns one stable P-256 profile identity. Its public identity ID, public JWK, SHA-256 key ID, typed subject root, and opaque provider handle are stored as daemon metadata. The private scalar remains in the operating-system credential store and is never serialized into daemon state.

The daemon also owns provider-profile metadata while provider credentials remain in the operating-system credential store behind opaque identifiers. Ordinary IPC never returns private key material, provider credentials, opaque handles, recovery secrets, generic credential lookup, arbitrary signing, caller-selected provider endpoints, or raw provider response bodies.

## Authority boundary

The local socket is a transport boundary, not a universal root API. The ordinary client protocol must remain semantic and closed. It must never grow generic operations such as:

```text
database.query
filesystem.read-arbitrary
key.export-private
credential.read
browser.call
kernel.eval-arbitrary
http.request-arbitrary
```

A separate root developer interface may exist, but it must be explicitly privileged and must not be the protocol used by Flutter, the browser bridge, or ordinary local applications.

## Migration rules

1. Daemon mode and extension-only portable mode are explicit; connection loss never silently changes the writable authority.
2. The existing extension Keyring remains writable until a prepare–verify–commit migration has compared daemon projections and explicitly committed cutover.
3. The daemon signs only closed, fully validated Greenways subjects; there is no generic signing route.
4. Node enrolment, Greenway or room membership, source mandates, and application grants are separate signed records. A local-client role does not imply any of them.
5. Browser effects remain in the extension and are independently revalidated there.
6. Flutter never receives raw secrets or direct database access.
7. Desktop and Server use the same protocol, state records, and daemon binary.

See issue #49 for the release train, issue #51 for daemon authority migration, and issue #63 for signed room and application authority records.
