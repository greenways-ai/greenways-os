# Greenways OS

Greenways OS is a local **keyring and package manager** powered by a browser-resident Hara kernel.

The first product has two permanent responsibilities:

1. **Keyring.** Create and retain a non-extractable controller key, hold session-scoped model-provider credentials, and later perform typed signing or model operations without exposing raw keys to websites or packages.
2. **Package manager.** Install exact, attributable package manifests; show their capabilities before approval; preserve approved versions locally; and keep executable extension code bundled and reviewable.

Everything else—Hara Playground, Historia, Hestia, Worlds, Beacon, DevTools, and later Greenways services—sits above those two foundations as a package, companion, web application, or explicit connection.

```text
Greenways OS
├── Keyring
│   ├── non-extractable controller key
│   └── session-only provider credentials
├── Package manager
│   ├── exact manifest approvals
│   ├── capabilities and launch bindings
│   └── bundled / companion / web packages
└── Optional packages and connections
    ├── Hara Playground
    ├── Historia
    ├── Hestia
    ├── Worlds
    ├── Greenways Beacon → greenways.space
    └── later DevTools and agent modules
```

## Product boundary

The keyring is not an ordinary package. It is part of the trusted Greenways OS host. Packages may eventually request narrow operations such as `key/sign` or `model/generate`; they must never receive a private signing key or provider API credential.

The package manager is also core. The existing `greenways-app/1` manifest remains the execution approval record, while `greenways-package/1` is the product-facing projection used to classify system packages, bundled modules, native companions, and ordinary web applications. A package update cannot silently reuse an earlier approval when its version, publisher, launch binding, or capabilities change.

Manifest V3 executable logic remains self-contained. A digest can prove which remote resource was fetched, but it does not turn remote JavaScript, Wasm, HAL, HTML, or another executable entrypoint into installable extension code. Executable browser modules must ship in a reviewed Greenways OS release or a separately reviewed companion extension. See [`protocol/packages.md`](protocol/packages.md).

## Keyring storage model

Greenways OS currently uses two deliberately different key lifetimes:

- The controller is an ECDSA P-256 `CryptoKey` created as **non-extractable** and retained in the extension’s local IndexedDB state. Its public identity card and key ID can be exported; the private key cannot.
- OpenRouter, OpenAI, and Anthropic credentials added through the Keyring surface are stored only in `chrome.storage.session`. They are cleared when the browser restarts or the extension is reloaded, disabled, updated, or explicitly locked.

The current release manages these records locally. It does **not** yet expose a website-to-keyring forwarder. That transport will require exact origin grants, typed provider operations, request budgets, context disclosure, and an approval/audit path before Hara Playground can call it. See [`protocol/keyring.md`](protocol/keyring.md).

## Hara kernel

The Manifest V3 service worker owns one rehydratable, browser-wide Hara kernel. Installed package state and prepared request receipts are profile-wide; active surfaces and world state remain document-scoped. The host persists committed projections and bounded receipts in IndexedDB so Chrome may suspend the worker without making page globals authoritative.

The kernel owns lifecycle transitions. JavaScript supplies a closed host-effect vocabulary for storage, tabs, files, packaged surfaces, and explicit network connections. Packaged pages are clients of that authority rather than secondary kernels. See [`protocol/kernel.md`](protocol/kernel.md).

## Optional connections

Greenways Beacon, Greenways Space, Hestia, and the earlier Home Link remain supported, but they are no longer the product hierarchy.

- **Beacon** is a local Hara application on Hoplite that provides an inspectable route to `greenways.space`.
- **Greenways Space** describes Hestia, Ignatius, Historia, and later services through a bounded catalogue.
- **Hestia** remains the private-office and evidence authority.
- **Legacy Home Link** remains compatibility infrastructure while existing browser-device keys migrate deliberately.

None of these connections can install extension code, replace the local keyring, or grant a package capability. A browser may remain offline and still use the keyring, package manager, installed local packages, and signed work.

## Repository layout

- `protocol/keyring.md` — controller keys, session provider profiles, and the no-key-export contract.
- `protocol/packages.md` — package kinds, exact approvals, and executable-code boundaries.
- `protocol/kernel.md` — durable Hara kernel and document-context lifecycle.
- `extension/` — Chrome Manifest V3 host, Keyring surface, package catalogue, launcher, and trusted browser surfaces.
- `src/gw/os/` — Hara-owned kernel and adaptor namespaces.
- `services/beacon/` — optional `greenways.beacon` Hara application on Hoplite.
- `services/home-node/` — legacy signed browser-pairing compatibility implementation.
- `services/identity/` — development slice of `id.greenways.ai`.

## Development

Build and test the extension:

```sh
cd extension
npm install
npm run build
npm test
npm run test:browser
```

Load `extension/` as an unpacked extension from `chrome://extensions`.

Validate and run the optional Beacon service:

```sh
services/beacon/bin/greenways-beacon check
services/beacon/bin/greenways-beacon run

curl http://127.0.0.1:58100/.well-known/greenways-beacon
curl http://127.0.0.1:58100/space/discovery.json
```

The legacy Home Link and identity development services remain testable independently:

```sh
cd services/home-node && npm test
cd ../identity && npm test
```
