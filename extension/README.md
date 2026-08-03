# Greenways OS extension

The extension is the seamless client surface for artist-owned identity,
contribution proof, Release Steward checks, publishing checkpoints, and Hestia
sync. Its normal state is quiet: it records signed actions locally and exposes
proof only when the artist needs to inspect, export, verify, or back it up.

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
directory unpacked. Run `npm run build` whenever `src/world.js` or one of its
imports changes; the generated `dist/world.js` bundle is intentionally ignored.

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
