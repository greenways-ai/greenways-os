# Greenways OS extension

The extension is the first Greenways OS host: a local launcher, Hara-owned app
lifecycle, closed host-effect and capability vocabulary, and set of trusted
browser surfaces. It starts without an account or network service. Identity,
participation, Hestia sync, Historia, and other services are installed or
connected explicitly.

The background service worker owns the browser-wide Hara kernel authority.
Installed applications and request receipts are profile-wide; active apps,
surfaces, and Studio tracks live in isolated document contexts. Launcher and
world pages are thin kernel clients. The host serializes all transitions and
atomically commits each global projection, context checkpoint, installed-app
snapshot, and request acknowledgement in IndexedDB.

Manifest V3 may stop the worker when it is idle, so no security or durability
claim depends on a resident process. Clients reconnect with Chrome's unique
document-lifetime ID, and the host rehydrates before serving the next request.
Chrome's active `documentId` binds each client to its context record; the host
never trusts a message-supplied context key. It registers Chrome listeners
synchronously before the bundled Hara Wasm finishes loading. See
`../protocol/kernel.md` for the message and state boundary.

The bundled application catalog is declarative. Catalog entries can open a
packaged surface, a normal browser tab, or a connector implemented by code that
ships with the extension. They cannot inject downloaded JavaScript into the
extension origin. Digest-locking fetched source proves integrity but does not
make it executable by the kernel; remote catalogs remain declarative data. See
`../protocol/apps.md` for the application contract.

An installed manifest is the approval record for that exact version,
publisher, launch binding, and capability set. A catalog update cannot silently
reuse an earlier approval. Page roles are derived from Chrome's active packaged
document metadata, never from an app ID or role asserted by a message.
Packaged pages and the service worker remain one Chrome extension principal;
document contexts isolate trusted UI state but are not sandboxes for compromised
extension code. This is why executable UI stays bundled and remote code remains
forbidden.

The Manifest V3 extension requests `sidePanel` and `storage`. Network origins
are optional permissions so Home Link, Hestia, public resolvers, and GitHub are
only contacted after an explicit user action.

```sh
npm install
npm run build
npm test
npm run test:browser
```

For local use, enable developer mode at `chrome://extensions` and load this
directory unpacked. Run `npm run build` whenever the launcher, world viewer, or
one of their imports changes; generated bundles under `dist/` are intentionally
ignored.

The build rewrites PlayCanvas's Gaussian-splat sorters to packaged static
workers so the viewer stays within Manifest V3's extension-page CSP. The unused
dynamic Draco and Basis decoder paths are disabled in this host; the world
contract accepts SOG assets only.

## Launcher

The toolbar action opens the local launcher. Greenways Home and Worlds are
protected system applications. Historia, Hestia Connector, and Hara Playground
exercise the first native-hybrid, packaged-connector, and web-app install
classes. Installing a catalog entry records local enablement; native software
such as Historia still requires its verified platform companion because Chrome
extensions cannot install or start operating-system executables.

Home Link is a host-level bridge rather than a remote application. It pairs the
current browser with a private home server by one-time code, stores a
non-extractable per-browser signing key, pins the node's self-signed identity,
and uses mutually signed presence records to show the other paired browsers and
bounded local-service descriptions. The home server cannot dispatch kernel
transitions or add executable UI. See `../protocol/home-link.md` and
`../services/home-node/`.

Greenways Home can navigate to Hestia Connector but contains no Hestia network
client of its own. Pairing, sync, credential storage, and optional origin access
remain in the installed connector; disconnecting or removing it revokes that
exact origin before its credential is deleted.

The 0.3 upgrade signs the earlier prototype's unsigned personal-chain
inclusions and hardens an extractable stored controller key. It retains an
owner-signed old→new hash bridge and queues the complete rebuilt chain once.
Invalid legacy state fails closed and exposes a public-key recovery export; it
is not silently reset.

## GitHub worlds

Choose **Open a GitHub world** from the side panel. This route is available
before identity or project onboarding. The first load asks for access to the
GitHub API and raw-content hosts, then accepts a public repository URL and an
optional branch, tag, or commit.

The welcome page also provides one-click featured projects for Apartment,
Playbot, and the composed Splat Garden. Each card links to its source and
attribution; the generic repository form remains available below the gallery.

- Dev mode resolves a branch, tag, or the default branch to a commit.
- Strict mode accepts only full 40-character commit SHAs, including imports.
- Imported project failures leave the remaining scene visible with an
  **incomplete** diagnostic.
- Left-drag or one-finger drag orbits; right-drag, Shift-drag, or two fingers
  pan; wheel or pinch zooms.

Only `.sog` and streamed SOG `lod-meta.json` assets are accepted. The root
project controls the camera and background. See `../protocol/worlds.md` for a
complete `project.edn` example and the security limits.
