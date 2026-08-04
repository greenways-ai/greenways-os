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
are installed from strict declarative manifests. A
manifest may select code already shipped with Greenways OS, connect through a
known adapter, or open a web application in an ordinary tab; it cannot download
or execute remote JavaScript, Wasm, HAL, or another form of remotely hosted code
inside the extension.

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
2. **Installed applications.** The launcher keeps a local, inspectable registry
   of enabled applications and their capabilities.
3. **Optional connectors.** Historia, Hestia, GitHub, and later services connect
   only after a deliberate install, pairing, or permission gesture.
4. **Optional participation.** Identity resolution, sharing, social spaces, and
   public services sit above the local kernel. Turning them off does not remove
   the person's applications or data.

Hestia supplies durable personal evidence chains, agent identity and recovery.
Historia supplies local, Git-native memory. Neither becomes a central account
required to enter Greenways OS.

## Layout

- `protocol/` — normative Greenways-owned records and conformance cases.
- `extension/` — the low-permission Chrome MV3 launcher, browser host, and
  trusted application surfaces.
- `services/identity/` — runnable development slice of `id.greenways.ai`.

`id.greenways.ai` resolves signed handles, key histories, service endpoints,
and witnessed checkpoint references. Personal histories and private keys
remain with the user's Hestia infrastructure.

## Extension development

```sh
cd extension
npm install
npm run build
npm test
npm run test:browser

cd ../services/identity
npm test
```

Load the repository's `extension/` directory as an unpacked extension at
`chrome://extensions`.

The launcher and **Open a GitHub world** surface work before identity setup.
The world viewer reads a public repository's root `project.edn`, resolves every ref to an
immutable Git commit, and renders its local and imported SOG layers. See
[`protocol/worlds.md`](protocol/worlds.md) for the manifest contract.

The viewer features three maintained examples from
[`greenways-worlds`](https://github.com/greenways-worlds): Apartment (single
SOG), Playbot (streamed SOG), and Splat Garden (immutable repository imports).

## First vertical slice

An artist can create a key-controlled identity and project, add digest-addressed
contributions, run the Release Steward, accept service proposals, publish a
signed release checkpoint, and export a self-verifying evidence bundle. Every
action is included in that artist's local personal chain and can later be sent
to their Hestia server.

The Release Steward performs named checks with visible limitations. It cannot
edit artifacts, accept its own proposals, publish, or turn its advice into a
global quality score. Rights records are attributable claims and permissions;
they are not declarations of legal title or jurisdiction-specific legal advice.

`id.greenways.ai` verifies self-signed public registrations and returns
content-rooted resolutions. A handle collision stays visible. The resolver
does not receive private keys or become the identity authority.
