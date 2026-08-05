# Greenways OS

Greenways OS turns a browser profile into a small, locally installed operating
environment. Its Hara kernel, application state, keys, and private work remain
on the person's machine. Participation, social discovery, hosted services, and
sync are adapters that a person may add; none are prerequisites for starting or
using the local system.

The Chrome extension is the first host. Its Manifest V3 service worker owns one
browser-wide Hara kernel authority, while each launcher or world document keeps
an isolated logical UI context. The host persists committed profile state,
per-document checkpoints, and bounded request receipts in IndexedDB, so Chrome
may suspend the worker without making page globals authoritative. Applications
are installed from strict declarative manifests. A manifest may select code
already shipped with Greenways OS, connect through a known adapter, or open a
web application in an ordinary tab; it cannot download or execute remote
JavaScript, Wasm, HAL, or another form of remotely hosted code inside the
extension.

Application lifecycle is Hara-owned inside the kernel host. Installed apps are
profile-wide; active apps, surfaces, and Studio tracks are document-scoped so
two pages cannot clobber one another. The host serializes transitions, commits
the global and context projections atomically, and targets UI effects only to
the initiating document. Origin-wide locks continue to serialize the separate
personal evidence chain. See [`protocol/kernel.md`](protocol/kernel.md).

## Sovereign-first architecture

1. **Local kernel.** Hara owns portable application and workflow state. A
   rehydratable browser-wide host supplies bounded effects such as storage,
   tabs, files, and explicit network connections.
2. **Greenways Beacon.** A local Hara application on Hoplite gives the browser
   one inspectable ingress and an immutable route to `greenways.space`.
3. **Greenways Space.** Hestia, Ignatius, Historia and later services are
   composed behind a signed service catalogue rather than embedded into the
   browser or Beacon.
4. **Installed applications.** The launcher keeps a local, inspectable registry
   of enabled applications and their capabilities.
5. **Optional participation.** Identity resolution, sharing, social spaces, and
   public services sit above the local kernel. Turning them off does not remove
   the person's applications or data.

Beacon is not a second Hestia node. It owns the local gateway boundary, route
health and the future browser-device link. Hestia remains the private-office
and evidence authority; Ignatius and other services remain part of Greenways
Space. A browser may be offline from both Beacon and Space and still launch
local applications and retain signed work. See [`protocol/beacon.md`](protocol/beacon.md)
and [`services/beacon/`](services/beacon/).

The first Beacon profile exposes local discovery, health and status through
Hara handlers and maps `/space/` to a fixed HTTPS path on `greenways.space`
through Hoplite/Nginx. The upstream cannot be selected by request data, and
ambient local cookies, browser origin and forwarding headers are not forwarded
as authority.

The earlier `greenways-home/1` browser-pairing prototype remains under
[`services/home-node/`](services/home-node/) while paired browser identities
migrate deliberately. It is compatibility code, not the target service
runtime. Existing keys must not be silently replaced merely because Beacon has
a new product name or implementation.

Historia supplies local, Git-native memory. Hestia supplies private offices,
mandates, signed approvals and selective receipts. Neither becomes a central
account required to enter Greenways OS.

## Layout

- `protocol/` — normative Greenways-owned records and conformance cases,
  including the browser kernel, Beacon and legacy Home Link boundaries.
- `extension/` — the low-permission Chrome MV3 launcher, browser host, and
  trusted application surfaces.
- `services/beacon/` — the `greenways.beacon` Hara application on Hoplite and
  its operator wrappers.
- `services/home-node/` — compatibility implementation of the first signed
  browser-pairing wire profile.
- `services/identity/` — runnable development slice of `id.greenways.ai`.

`id.greenways.ai` resolves signed handles, key histories, service endpoints,
and witnessed checkpoint references. Personal histories and private keys
remain with participant-controlled Hestia infrastructure.

## Development

Build and test the extension:

```sh
cd extension
npm install
npm run build
npm test
npm run test:browser
```

Validate and run Beacon with a Hoplite build that supports static upstreams:

```sh
services/beacon/bin/greenways-beacon check
services/beacon/bin/greenways-beacon run

curl http://127.0.0.1:58100/.well-known/greenways-beacon
curl http://127.0.0.1:58100/space/discovery.json
```

The old protocol remains testable during migration:

```sh
cd services/home-node
npm test
```

The identity development service remains separate:

```sh
cd services/identity
npm test
```

Load the repository's `extension/` directory as an unpacked extension at
`chrome://extensions`.

The launcher and **Open a GitHub world** surface work before identity setup or
Beacon enrolment. The world viewer reads a public repository's root
`project.edn`, resolves every ref to an immutable Git commit, and renders its
local and imported SOG layers. See [`protocol/worlds.md`](protocol/worlds.md)
for the manifest contract.

The viewer features three maintained examples from
[`greenways-worlds`](https://github.com/greenways-worlds): Apartment (single
SOG), Playbot (streamed SOG), and Splat Garden (immutable repository imports).

## First vertical slice

An artist can create a key-controlled identity and project, add digest-addressed
contributions, run the Release Steward, accept service proposals, publish a
signed release checkpoint, and export a self-verifying evidence bundle. Every
action is included in that artist's local personal chain and can later be sent
to their Hestia service through an explicitly approved Space capability.

The Release Steward performs named checks with visible limitations. It cannot
edit artifacts, accept its own proposals, publish, or turn its advice into a
global quality score. Rights records are attributable claims and permissions;
they are not declarations of legal title or jurisdiction-specific legal advice.

`id.greenways.ai` verifies self-signed public registrations and returns
content-rooted resolutions. A handle collision stays visible. The resolver
does not receive private keys or become the identity authority.
