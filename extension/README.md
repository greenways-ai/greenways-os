# Greenways OS extension

The extension is the first Greenways OS host: a local launcher, Hara-owned app
lifecycle, closed host-effect and capability vocabulary, and set of trusted
browser surfaces. It starts without an account or network service. Identity,
participation, Hestia sync, Historia, and other services are installed or
connected explicitly.

The launcher owns one long-lived Hara session and persists its app records in
the extension's shared IndexedDB database. Other extension pages currently own
their own Hara sessions. Consolidating those page-local sessions behind one
durable browser-wide kernel host is a later architecture step. Until then,
origin-wide exclusive locks serialize app lifecycle and personal-chain writes
across open extension pages.

The bundled application catalog is declarative. Catalog entries can open a
packaged surface, a normal browser tab, or a connector implemented by code that
ships with the extension. They cannot inject downloaded JavaScript into the
extension origin. Digest-locking fetched source proves integrity but does not
make it executable by the kernel; remote catalogs remain declarative data. See
`../protocol/apps.md` for the application contract.

The Manifest V3 extension requests `sidePanel` and `storage`. Network origins
are optional permissions so Hestia, public resolvers, and GitHub are only
contacted after an explicit user action.

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

Greenways Home can navigate to Hestia Connector but contains no Hestia network
client of its own. Pairing, sync, credential storage, and optional origin access
remain in the installed connector; disconnecting or removing it revokes that
exact origin before its credential is deleted.

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
