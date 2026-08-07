# Greenways OS extension

This directory is the loadable Chrome Manifest V3 host for Greenways OS. The extension owns one rehydratable, browser-wide Hara kernel in its service worker and ships one fixed root application, **Kernel DevTools**.

For the complete developer installation, Native Messaging setup, RESP verification, troubleshooting, and uninstall steps, start with [`../README.md`](../README.md).

## Build and load

Use the repository root as the working directory:

```bash
node --version
npm --prefix extension ci
npm --prefix extension run build
```

Node.js 22 or newer is required. Then:

1. open `chrome://extensions`;
2. enable **Developer mode**;
3. select **Load unpacked**; and
4. choose the repository's `extension/` directory.

The build writes reviewed bundles to `extension/dist/`. The unpacked directory, not `dist/` by itself, is the extension root.

## First distribution

The first extension distribution is:

```text
Greenways OS root host
├── resident Hara kernel
├── local durable store
├── capability and consent authority
├── identity and keyring
├── package lifecycle and trust
├── declarative surface host
└── Kernel DevTools                       preinstalled root app
```

`greenways-devtools` is packaged with the extension, preinstalled, non-removable, and separate from the ordinary application catalogue. A registry, preview package, or HAL module cannot claim its identifier, packaged page, host principal, or methods.

Kernel DevTools attaches to the existing service-worker kernel. It does not embed a second Hara runtime. It provides:

- an explicit namespace Hara REPL;
- bounded calls into reviewed kernel methods;
- module generation and lock-digest inspection;
- resident core-service inspection; and
- explicit controls for the optional authenticated RESP bridge.

## Resident services

A core service is a permanent authority boundary, not necessarily a permanent UI. The current `greenways-core-service/1` registry reserves ten non-removable services:

```text
kernel · store · capabilities · identity · keyring
packages · surfaces · receipts · connectors · work
```

Kernel, Store, Capability and Consent, Identity, Keyring, Package Lifecycle, and Surface Host are active. Receipt Journal, Connector Broker, and Work Supervisor are registered as stable foundation boundaries while their complete implementations arrive.

The service catalogue and closed capability vocabulary are defined in JavaScript and HAL and tested for parity. Packages cannot register new core services, host effects, Chrome permissions, or capability definitions.

### Capability authority

A package manifest declares broad installation requirements. Consequential operations such as `key/sign`, `credential/use`, and `model/generate` additionally require a durable `greenways-capability-grant/1` record bound to the exact app ID, version, publisher, and HAL lock digest.

A stored grant is not sufficient by itself. The service worker verifies that the exact approval is still current. A HAL module must also have a matching durable module record and appear in the immutable runtime index created only after boot-time archive re-verification and successful namespace registration. A corrupt or unrestored module cannot recover authority through an old grant.

Grant constraints are bounded data. Secret-like fields such as API keys, passwords, bearer tokens, private keys, and authorization values are rejected before persistence. Capability evidence exposes public approval identity and runtime verification only; it does not expose package archives, credential values, or private keys.

See [`../protocol/core-services.md`](../protocol/core-services.md).

## Module runtime

`greenways-app/1` remains the exact runtime approval record. Digest-verified `.hal` packages are loaded through the locally shipped `hal-module` handler and rewritten into fresh app-owned namespace generations:

```text
app.<id>.g<generation>.*
```

Install and reload stage a fresh generation and swap it only after verification and evaluation succeed. A failed reload leaves the previous generation active. Module lock and archive bytes are re-verified whenever the service worker restores the package.

Remote JavaScript, HTML, CSS, arbitrary WebAssembly, host handlers, browser permissions, and manifest-embedded source remain forbidden. A content hash proves exact bytes; it does not grant extension authority.

See [`../protocol/packages.md`](../protocol/packages.md) and [`../protocol/apps.md`](../protocol/apps.md).

## Keyring

The Keyring remains a resident authority service even when its management surfaces become applications.

- The controller identity uses a non-extractable ECDSA P-256 `CryptoKey` retained in IndexedDB.
- Provider credentials are currently session-scoped records in `chrome.storage.session`.
- Public status contains identity ID, handle, key ID, provider, label, and creation time only.
- There is no operation that returns a private signing key or provider credential.

A future System Keychain application can add a replaceable native credential provider while the core Keyring continues to enforce opaque references, signing operations, policy, and receipts.

See [`../protocol/keyring.md`](../protocol/keyring.md).

## RESP bridge

Chrome extension pages do not own raw listening sockets. The optional TCP listener is supplied by `services/devtools-node` through Chrome Native Messaging.

The bridge:

- starts only from the fixed Kernel DevTools page;
- binds only to `127.0.0.1`;
- requires a fresh one-session 256-bit token;
- supports a closed RESP2 command vocabulary;
- limits requests and responses to 1 MB; and
- closes and invalidates the token when the native connection stops.

Install the native companion from the repository root after loading the extension and copying its ID:

```bash
node services/devtools-node/bin/greenways-devtools-install.mjs \
  --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --browser chrome
```

Accepted browser names are `chrome`, `chrome-beta`, `chromium`, and `brave`. The installer currently supports macOS and Linux. See [`../services/devtools-node/README.md`](../services/devtools-node/README.md).

## Permissions

The required extension permissions are:

```text
sidePanel
storage
nativeMessaging
userScripts
```

`nativeMessaging` allows the reviewed DevTools page to connect to the separately installed `ai.greenways.devtools` companion. It does not allow an extension page to execute arbitrary native commands.

`userScripts` allows the bundled Userscripts app to register user-authored scripts with Chrome's `chrome.userScripts` API. Scripts run in the isolated `USER_SCRIPT` world on their declared match patterns. Chrome additionally requires its own developer-mode **Allow User Scripts** toggle for this extension before any registration takes effect, and every management operation requires an active `userscripts/manage` capability grant bound to the exact installed app approval. Script source is entered locally and is never fetched from a remote origin; durable records stay in the profile's IndexedDB store and Chrome registration is a rebuildable projection of them. This permission raises the minimum Chrome version to 120.

Loopback and HTTPS origins remain optional host permissions. They are requested only when a user activates Beacon, Hestia, Historia, GitHub Worlds, or another reviewed connector.

## Runtime boundary

The Manifest V3 service worker owns kernel authority. Installed package state, capability grants, module records, and prepared receipts are profile-wide. Active package and surface state remains isolated by Chrome document identity.

Listeners are registered synchronously and durable state is rehydrated before requests are served, so MV3 suspension does not make a launcher page authoritative. The launcher, World viewer, Kernel DevTools, and other packaged pages are clients of the service-worker host.

The build verifies that the reviewed Hara Wasm runtime and `gw.os.kernel` occur only in `dist/background.js`.

## Tests

From the repository root:

```bash
npm --prefix extension ci
npm --prefix extension test
npm --prefix extension run build
```

For the Playwright suite:

```bash
npm exec --prefix extension -- playwright install chromium
npm --prefix extension run test:browser
```

For the Native Messaging companion:

```bash
npm --prefix services/devtools-node ci
npm --prefix services/devtools-node test
```

Generated bundles under `dist/`, Playwright results, and installed dependencies are intentionally not committed.
