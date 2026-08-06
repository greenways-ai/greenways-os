# Greenways OS extension

The Chrome extension is the first Greenways OS host. Its first product remains a local **Keyring** plus a strict **Package Manager**, but those products now sit on an explicit resident service graph coordinated by one browser-wide Hara kernel.

## Resident core services

A core service is a permanent authority boundary, not necessarily a permanent UI. The current `greenways-core-service/1` registry reserves ten non-removable services:

```text
kernel · store · capabilities · identity · keyring
packages · surfaces · receipts · connectors · work
```

Kernel, Store, Capability and Consent, Identity, Keyring, Package Lifecycle, and Surface Host are active. Receipt Journal, Connector Broker, and Work Supervisor are registered as foundation services so apps can depend on stable boundaries as those implementations arrive.

The service catalogue and closed capability vocabulary are defined in both JavaScript and HAL and tested for exact parity. Packaged pages can inspect the public service graph, but only the trusted launcher can create or revoke operation grants.

### Capability and Consent

A manifest requests broad installation capabilities. Consequential operations such as `key/sign`, `credential/use`, and `model/generate` additionally require a durable `greenways-capability-grant/1` record bound to the exact app ID, version, publisher, and HAL lock digest. Grants are stored in the same two-phase IndexedDB transaction as kernel state, survive service-worker suspension, expire at their declared time, and are automatically revoked when an app is updated or removed.

Grant constraints are bounded data and may name opaque profile references, models, budgets, or purposes. Secret-like fields such as API keys, passwords, tokens, private keys, or authorization values are rejected before persistence.

A grant is not sufficient by itself. Before a grant is created or returned by `capabilities/check`, the service worker verifies that the exact app approval is still current. HAL modules must also have the same durable module record and lock digest in an immutable runtime index created only after boot-time archive re-verification and successful namespace registration. A stored module that failed to restore therefore cannot regain authority through an old grant.

Capability authority evidence contains only public approval identity, lock digest, generation, and namespace root. It never projects lock source, package archives, provider credentials, or private keys.

See `../protocol/core-services.md`.

## Core 01: Keyring

The launcher presents Keyring before every package or network connection.

- A controller identity uses a non-extractable ECDSA P-256 `CryptoKey` stored with the existing local identity record in IndexedDB.
- Model-provider credentials are session-only records in `chrome.storage.session`.
- Keyring status returns public metadata only: identity ID, handle, key ID, provider, label, and creation time.
- There is no operation that returns a private signing key or provider credential. A later allowlisted provider host will consume credentials behind the keyring boundary.

The current UI supports creating the controller, adding/removing OpenRouter, OpenAI, and Anthropic session profiles, and clearing all provider credentials. It intentionally does not expose an external website bridge yet. A future System Keychain app will provide a replaceable companion UI and provider while the Keyring authority remains resident. See `../protocol/keyring.md`.

## Core 02: Package Manager

The existing Hara-owned app lifecycle now appears as a package manager. `greenways-app/1` remains the exact runtime approval record; `greenways-package/1` projects records into these product kinds:

- `system`
- `hal-module`
- `bundled-module`
- `companion`
- `web-application`

The catalogue is declarative. Entries may select a packaged surface, launch a known local companion, open an allowlisted website, or select the locally shipped `hal-module` handler. Remote JavaScript, arbitrary Wasm, HTML, CSS, and host handlers remain forbidden. HAL is accepted only from a digest-verified HARP graph, rewritten into an app-owned namespace generation and executed by the already-packaged Hara runtime. A changed version, publisher, launch binding, capability set, or module lock digest requires fresh local approval. See `../protocol/packages.md`.

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

## Root OS and Kernel DevTools

The first extension distribution is the resident Greenways OS plus one fixed root app,
`greenways-devtools`. It is packaged with the extension, preinstalled, non-removable, and separate
from the ordinary application catalogue. The DevTools page does not embed another Hara runtime;
it attaches to the single service-worker kernel.

DevTools provides an explicit namespace REPL, bounded calls into reviewed kernel methods, module
and service inspection, and an optional authenticated RESP2 bridge. The TCP listener is provided
by `services/devtools-node` through Chrome Native Messaging because extension pages do not own raw
listening sockets. It binds only to `127.0.0.1`, requires a fresh session token, and shuts down with
the native connection.

```bash
npm --prefix services/devtools-node test
node services/devtools-node/bin/greenways-devtools-install.mjs \
  --extension-id <id-from-chrome-extensions> \
  --browser chrome
```

See `../protocol/devtools.md` for the authority and wire-level boundaries.
