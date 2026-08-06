# Greenways OS extension

The Chrome extension is the first Greenways OS host. Its primary product is a local **Keyring** plus a strict **Package Manager**, both coordinated by one browser-wide Hara kernel.

## Core 01: Keyring

The launcher presents Keyring before every package or network connection.

- A controller identity uses a non-extractable ECDSA P-256 `CryptoKey` stored with the existing local identity record in IndexedDB.
- Model-provider credentials are session-only records in `chrome.storage.session`.
- Keyring status returns public metadata only: identity ID, handle, key ID, provider, label, and creation time.
- There is no operation that returns a private signing key or provider credential. A later allowlisted provider host will consume credentials behind the keyring boundary.

The current UI supports creating the controller, adding/removing OpenRouter, OpenAI, and Anthropic session profiles, and clearing all provider credentials. It intentionally does not expose an external website bridge yet. See `../protocol/keyring.md`.

## Core 02: Package Manager

The existing Hara-owned app lifecycle now appears as a package manager. `greenways-app/1` remains the exact runtime approval record; `greenways-package/1` projects each record into one of four product kinds:

- `system`
- `bundled-module`
- `companion`
- `web-application`

The catalogue is declarative. Entries may select a packaged surface, launch a known local companion, or open an allowlisted website. They cannot inject downloaded JavaScript, Wasm, HAL, HTML, or source into the extension. A changed version, publisher, launch binding, or capability set requires a fresh local approval. See `../protocol/packages.md`.

## Runtime boundary

The Manifest V3 service worker owns the browser-wide Hara kernel authority. Installed packages and request receipts are profile-wide; active package and surface state are isolated by Chrome document identity. The host registers listeners synchronously and rehydrates durable state before serving requests, so MV3 suspension does not move authority into a launcher page.

The launcher, World viewer, and other packaged pages are kernel clients. They do not embed a second Hara runtime. The build checks that the reviewed Hara Wasm and `gw.os.kernel` occur only in `dist/background.js`.

## Launcher hierarchy

The side panel is organized as:

```text
Keyring
Package Manager
  ├── Installed packages
  └── Package catalogue
Optional connections
  ├── Greenways Beacon
  └── Legacy Home Link / Hestia migration
```

Beacon and Home Link still use their existing reviewed clients and permission boundaries. The new core product decorator moves their cards below package management without replacing those implementations.

## Permissions

The required manifest permissions remain only:

```text
sidePanel
storage
```

Provider credentials use `chrome.storage.session`; no new network permission is required merely to manage a key. Loopback and HTTPS origins remain optional host permissions requested only when a user activates Beacon, Hestia, Historia, GitHub Worlds, or another connector.

## Development

```sh
npm install
npm run build
npm test
npm run test:browser
```

For local use, enable developer mode at `chrome://extensions` and load this directory unpacked. Generated bundles under `dist/` are intentionally ignored.
