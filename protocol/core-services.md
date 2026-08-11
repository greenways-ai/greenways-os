# Greenways OS core services and capability grants

Status: first authority implementation  
Core service protocol: `greenways-core-service/0-alpha`
Capability definition protocol: `greenways-capability-definition/0-alpha`
Capability grant protocol: `greenways-capability-grant/0-alpha`
Capability authority protocol: `greenways-capability-authority/0-alpha`
Capability decision protocol: `greenways-capability-decision/0-alpha`

## Purpose

Greenways OS separates permanent authority from replaceable product experience.
A **core service** is a browser-resident, non-removable authority boundary. A
screen, workflow, connector, or provider that uses that boundary can be a
bundled or installable app.

This distinction allows the Keychain, Package Manager, Settings, Task Monitor,
and Receipt Viewer interfaces to be progressively implemented as `.hal` apps
without allowing those apps to own private keys, IndexedDB transactions,
browser permissions, native messaging, executable DOM, or the system policy
that constrains them.

A manifest requests capabilities at installation. Declaration is necessary but
is not authority. Consequential operations additionally require an exact,
durable capability grant created by the trusted host consent surface.

## Resident service graph

Every core service record has this closed shape:

```text
protocol
id
name
version
status
resident
removable
dependencies
```

`resident` is always `true` and `removable` is always `false`. `status` is:

- `active` when the service has a callable first implementation; or
- `foundation` when its permanent authority slot and dependency boundary are
  reserved while the complete operation surface is still being built.

The current graph is:

| Service | Status | Authority |
| --- | --- | --- |
| `kernel` | active | Single Hara runtime, namespace isolation, invocation, and lifecycle |
| `store` | active | App state, blobs, package evidence, checkpoints, and atomic IndexedDB transitions |
| `capabilities` | active | Closed vocabulary, exact grants, expiry, revocation, and caller policy |
| `identity` | active | Controller and device identity, public projections, and authentication challenges |
| `keyring` | active | Non-exportable signing authority and opaque provider credential references |
| `packages` | active | Manifest, lock, publisher, archive, channel, update, and removal trust decisions |
| `surfaces` | active | Executable DOM, forms, secret entry, focus, dialogs, and declarative app rendering |
| `receipts` | foundation | Consequential system events, evidence roots, signatures, and recovery history |
| `connectors` | foundation | Typed mediation of HTTPS, OAuth, GitHub, files, native hosts, and browser APIs |
| `work` | foundation | Agent and workflow execution, cancellation, checkpoints, retries, and supervision |

A core service may expose its public status through an app, but an app cannot
replace the service record, change its dependencies, make it removable, or add
a new authority primitive.

## Public kernel methods

The initial authority surface is:

```text
core/services
capabilities/vocabulary
capabilities/list
capabilities/check
capabilities/grant
capabilities/revoke
```

`core/services` and `capabilities/vocabulary` are immutable projections.
`capabilities/list` and `capabilities/check` compose the current global grant
state with the caller's restored kernel context. Only the trusted packaged
launcher may dispatch grant and revoke transitions. Other packaged clients may
inspect the public registry or perform explicitly allowlisted checks.

A HAL application does not call these methods as an arbitrary launcher client.
The module invocation boundary will bind the calling app and package generation
before forwarding an operation request to the relevant core service.

## Capability definitions

A capability definition has this closed shape:

```text
protocol
id
service
risk
grantable
trustedPublishers
```

`service` identifies the resident authority that owns the operation. `risk` is
one of `low`, `medium`, `high`, or `critical`. `grantable` means the operation
requires an explicit durable grant in addition to manifest declaration.
`trustedPublishers` is empty unless the operation is restricted to reviewed
system publishers.

The first operation-grantable capabilities are:

| Capability | Service | Risk | Meaning |
| --- | --- | --- | --- |
| `key/public` | Keyring | low | Read public controller or key metadata only |
| `key/sign` | Keyring | critical | Ask the Keyring to sign a bounded payload; no private-key export |
| `credential/manage` | Keyring | critical | Create, update, or remove opaque profiles; initially Greenways-publisher only |
| `credential/use` | Keyring | critical | Use an opaque provider profile without revealing its secret |
| `model/generate` | Connector Broker | high | Perform a bounded model request using an approved profile |
| `model/provide` | Surface and Interaction Host | critical | Project one foreground request into a reviewed AI web application and return only an explicitly selected response |
| `chats/capture` | Surface and Interaction Host | critical | Observe rendered conversations on an approved AI chat origin; Greenways-publisher only |
| `userscripts/manage` | Surface and Interaction Host | critical | Register, update, or remove user-authored scripts in matching web pages; Greenways-publisher only |

Existing installation capabilities remain in the same closed vocabulary but are
not yet operation-grantable: `hara/evaluate`, `hara/module`, `hestia/connect`,
`historia/import`, `identity/local`, `network/github`, `network/https`,
`network/loopback`, `storage/local`, `tabs/open`, and `worlds/browse`.

A registry or `.harp` archive cannot define a capability. New definitions arrive
only in a reviewed Greenways OS host update and must be represented identically
in the JavaScript host and HAL kernel. Runtime tests compare those projections.

## Manifest declaration versus operation grant

There are two independent checks:

1. **Installation approval**: the exact app manifest declares a capability from
   the closed vocabulary.
2. **Operation consent**: a current grant authorizes one operation for the exact
   approved app identity under bounded constraints.

The first does not imply the second. For example, installing an app that declares
`key/sign` does not permit it to sign anything until the user approves a grant.

The host creates the grant from the locally installed manifest. A package cannot
supply its own grant record, choose another publisher identity, omit its lock
digest, or widen a capability through view events.

## Capability grant

A grant has exactly:

```text
protocol
id
subject
capability
constraints
issuedAt
expiresAt
revokedAt
```

The subject is an exact app binding:

```json
{
  "kind": "app",
  "appId": "signing-room",
  "version": "0.1.0",
  "publisherId": "example",
  "lockDigest": "sha256:..."
}
```

`lockDigest` is `null` for non-module packaged apps and is mandatory for a HAL
module. A grant is current only when all of the following remain true:

- the app is installed;
- ID, version, publisher, and lock digest still match;
- the manifest still declares the capability;
- the capability remains operation-grantable;
- a trusted-publisher restriction still matches;
- `revokedAt` is absent; and
- `expiresAt`, when present, is later than the current canonical UTC time.

Changing an app version or package digest therefore makes old grants stale even
before they are journalled as revoked. Update and removal transitions also revoke
all still-active grants for the app so reinstalling or rolling back cannot revive
old authority.

## Runtime verification for HAL authority

A current grant is necessary but is not, by itself, sufficient authority for a
HAL module. Before a grant may be created or used, the host also requires all of
the following runtime evidence:

- the exact installed manifest is backed by a valid durable module record;
- the record manifest matches the installed approval, including publisher,
  capability set, source provenance, and lock digest;
- the stored lock and every archive have been re-verified during the current
  service-worker boot; and
- that same lock digest successfully registered a fresh namespace generation in
  the single browser-resident Hara kernel.

The host keeps this evidence in an immutable runtime index. A missing record, a
failed archive verification, a failed namespace registration, a changed digest,
or a malformed generation makes the authority decision fail closed even when a
matching durable grant remains in state. Restarting the service worker therefore
cannot turn an unverified package into an authorised caller.

Capability decisions expose only bounded public evidence: approval identity,
lock digest, installation time, namespace generation, and namespace root. They
never expose lock source, archive bytes, private keys, provider credentials, or
secret-bearing constraints.

The launcher may inspect decisions by app ID while managing approvals. A future
consequential module call must derive its caller from host-owned invocation
context and the active namespace generation; request-selected identity is never
a substitute for caller binding.

## Constraints

Constraints are bounded JSON/EDN data. V1 permits null, booleans, finite numbers,
strings, arrays, and plain maps under these limits:

- 64 KB encoded size;
- depth at most 8;
- at most 64 entries per map or array;
- strings at most 4096 characters; and
- field names at most 80 characters.

Prototype-shaped fields are rejected. Secret-like fields such as `secret`,
`password`, `token`, `apiKey`, `privateKey`, `authorization`, and `bearer` are
also rejected. Constraints may hold opaque references such as `profileId`, a
model allowlist, a purpose, spending or token limits, recipient identities, or
evidence requirements. They never hold a provider credential or private key.

Later capability-specific schemas may narrow this generic bounded form. They may
not enlarge it or make secrets durable.

## Persistence and recovery

Capability grants are profile-wide state. IndexedDB version 5 adds a dedicated
`grants` projection. The kernel global envelope remains the source of truth, and
the projection is replaced in the same two-phase transaction as:

- the next global envelope;
- the page context checkpoint;
- exact installed app approvals; and
- the request receipt acknowledgement.

A partial grant commit is therefore not observable. On service-worker restart,
stored grants are schema-validated before entering Hara state. Duplicate IDs,
unknown or non-grantable capabilities, malformed subjects, invalid timestamps,
secret-bearing constraints, or publisher violations fail recovery rather than
becoming authority.

Older global envelopes without a `grants` field are migrated to an explicit
empty projection. Revoked grants remain as audit history. They are never deleted
merely because an app is removed.

## Time and revocation

Timestamps are canonical UTC strings. Expiry follows issuance. Revocation may be
recorded at issuance time but never before it.

Browser and operating-system clocks can move backwards. Revocation is still
final, so the host records the later of the current clock and the grant's
issuance time. A backwards clock cannot make a grant impossible to revoke or
turn a revoked grant current.

## Keychain and companion apps

Keyring is the core authority. A future **System Keychain** HAL app is a
replaceable management and provider integration:

```text
System Keychain app
    → Capability and Consent
    → Keyring
    → Connector Broker
    → reviewed native messaging host
    → macOS Keychain / Windows Credential Manager / Secret Service
```

The app may request `credential/manage`, `credential/use`, `key/sign`, or
`model/generate`. It receives public profile metadata and operation results, not
raw secrets. Host-owned secret inputs route directly to the Keyring or companion
broker without appearing in HAL view events, app state, grants, receipts, or
logs.

Removing that app disables its integration and revokes its grants. Deleting
operating-system keychain entries remains a separate explicit operation.

## Security laws

1. A core service is resident and non-removable; its UI may be modular.
2. A manifest requests authority but never grants it.
3. A grant is created by the trusted host from the exact installed approval.
4. Stale, expired, removed, updated, or revoked authority cannot be used.
5. Revocation is final even if the local clock moves backwards.
6. A grant contains constraints and opaque references, never a secret.
7. A HAL grant is usable only while the exact durable module approval is present
   in the current boot's verified runtime index.
8. Capability decision evidence contains public verification metadata, never
   lock source, archive bytes, private keys, or provider credentials.
9. Registry signatures and package hashes prove identity, not authority.
10. Core service, capability, effect, and caller vocabularies change only in a
    reviewed Greenways OS host update.
