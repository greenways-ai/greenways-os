# Greenways OS

> **Current direction:** Greenways OS is the Chrome plugin for a self-hosted
> Tahto Fabric. It mirrors one explicitly selected Fabric folder into extension
> IndexedDB and, after confirmation, uses a reviewed website adapter to publish
> that snapshot. It is not a Fabric server, desktop suite, package runtime, or
> general programmable browser OS. See the [Chrome plugin architecture](docs/chrome-plugin-architecture.md)
> and [reorganisation inventory](docs/reorganisation-inventory.md).

The repository still contains the earlier browser-kernel, Desktop, Flow,
Hestia, package, and service experiments. They are legacy/backlog evidence,
not the current product direction; their associated planning issues were closed
in favour of [#207](https://github.com/greenways-ai/greenways-os/issues/207).

## Greenways Desktop development shell

The first Desktop management surface lives under `apps/greenways_desktop`. It
connects directly to `greenwaysd` through the unsafe-free
`greenways-desktop-bridge` Rust sidecar and renders the same explicit local
connection stages as the Chrome Connection Center. Flutter receives only
redacted daemon, actor, public identity and session-lifetime projections.

```bash
cargo +1.85.1 test -p greenways-desktop-bridge
cd apps/greenways_desktop
flutter pub get
flutter analyze
flutter test
tool/build_macos.sh
```

See [`protocol/desktop-connection.md`](protocol/desktop-connection.md) for the
closed request, projection and confidentiality boundary.

The current developer release contains:

- a non-removable root OS with local state, identity, keyring, capability, package, surface, receipt, connector, and work-service boundaries;
- **Kernel DevTools**, a preinstalled root application for inspecting and programming the resident kernel;
- digest-verified `.hal` application packages running in isolated Hara namespace generations; and
- an optional authenticated RESP2 endpoint for editor and command-line tooling.

```text
Greenways OS Chrome extension
├── resident Hara kernel
├── durable store and capability authority
├── identity and keyring
├── package lifecycle and declarative surface host
├── Kernel DevTools                         preinstalled root app
│   ├── namespace REPL
│   ├── kernel calls
│   ├── module and service inspection
│   └── authenticated RESP bridge
└── optional HAL apps and connectors
```

Kernel DevTools is packaged with the extension, is not part of the downloadable app catalogue, and cannot be removed or replaced by a registry package. It attaches to the existing service-worker kernel; it does not create a second Hara runtime.

## Developer installation

These instructions use the **repository root** as the working directory throughout.

### Prerequisites

- Git;
- Node.js **22 or newer**, including npm;
- Chrome, Chrome Beta, Chromium, or Brave;
- macOS or Linux for the Native Messaging companion; and
- `redis-cli` or another RESP2 client only when testing the local programming port.

The extension and in-browser Kernel DevTools can run without the native companion. The RESP bridge installer does not yet support Windows.

### 1. Clone, install, and build

```bash
git clone https://github.com/greenways-ai/greenways-os.git
cd greenways-os

node --version
npm --prefix extension ci
npm --prefix extension run build
```

`node --version` must report v22 or newer. The build creates the reviewed bundles under `extension/dist/`.

### 2. Load the unpacked extension

1. Open `chrome://extensions` in the target browser.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository's `extension/` directory.
5. Confirm that **Greenways OS** appears and copy its exact 32-character extension ID.
6. Open the Greenways OS side panel and confirm that the **Kernel DevTools** root card is present.

The extension manifest requests `sidePanel`, `storage`, and `nativeMessaging`. Network origins remain optional and are requested only when a connector needs them.

### 3. Install the optional native DevTools companion

Run this from the repository root, substituting the ID copied from `chrome://extensions`:

```bash
node services/devtools-node/bin/greenways-devtools-install.mjs \
  --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --browser chrome
```

Accepted browser values are:

```text
chrome
chrome-beta
chromium
brave
```

The installer prints the Native Messaging manifest path and the exact allowed extension origin. Reload Greenways OS from `chrome://extensions` after installing or changing the native host.

### 4. Start the RESP bridge

1. Open the Greenways OS side panel.
2. Select **Open DevTools**.
3. In **RESP bridge**, keep port `46379` or choose another free port from 1024 to 65535.
4. Select **Start RESP**.
5. Copy the displayed one-session authentication token.

The extension itself never listens on a TCP socket. Chrome launches `ai.greenways.devtools` through Native Messaging; that companion binds only to `127.0.0.1` for the active DevTools session.

### 5. Verify the programming connection

```bash
redis-cli -h 127.0.0.1 -p 46379
```

Then enter:

```text
AUTH <session-token>
PING
GW.STATUS
GW.SERVICES
GW.MODULES
GW.EVAL gw.devtools "(+ 20 22)"
GW.CALL core/services "[]"
QUIT
```

A successful session accepts `AUTH`, returns `PONG` for `PING`, and returns bounded Greenways status for `GW.STATUS`. Stopping the bridge or closing its Native Messaging connection invalidates the token.

## What the native installer writes

The installer creates:

```text
~/.greenways/bin/greenways-devtools-host
```

and one browser-specific Native Messaging manifest named:

```text
ai.greenways.devtools.json
```

The wrapper currently points to the Node executable and host script used during installation. Keep that Node installation and repository checkout in place. After moving the checkout, changing Node installations, or loading Greenways OS under a different extension ID, rerun the installer.

## Development checks

From the repository root:

```bash
npm --prefix extension ci
npm --prefix extension test
npm --prefix extension run build

npm --prefix services/devtools-node ci
npm --prefix services/devtools-node test
```

For browser tests:

```bash
npm exec --prefix extension -- playwright install chromium
npm --prefix extension run test:browser
```

The CI workflow also builds the public web target and tests Home Link, identity, the package registry, the Native Messaging companion, and Playwright browser behaviour.

## Troubleshooting

### `Specified native messaging host not found`

Rerun the native-host installer with the exact extension ID shown by the browser and the correct `--browser` value, then reload the extension. The browser selected during installation must be the browser loading Greenways OS.

### `Access to the specified native messaging host is forbidden`

The Native Messaging manifest contains a different extension ID. Rerun the installer with the current ID. The installer intentionally uses one exact `chrome-extension://<id>/` origin and never a wildcard.

### `Port is already in use`

Stop the other process or choose another port in Kernel DevTools. The bridge accepts ports from 1024 to 65535 and always binds to `127.0.0.1`.

### `NOAUTH` or an invalid token

Stop and restart the bridge, then copy the newly displayed token. Tokens are deliberately scoped to one bridge session.

### Kernel DevTools remains on `Starting kernel`

Reload Greenways OS from `chrome://extensions`. Open the extension's service-worker inspection link to review startup errors if the state does not become ready.

### `redis-cli` is unavailable

Install the Redis command-line client or connect with another RESP2 client. Redis server is not required.

### Windows

The Chrome extension and in-browser REPL can be used, but the included user-level Native Messaging installer currently supports only macOS and Linux.

## Uninstall

1. Stop the RESP bridge in Kernel DevTools.
2. Remove or disable Greenways OS from `chrome://extensions`.
3. Delete the Native Messaging manifest for the browser used during installation.
4. Remove the wrapper if no other Greenways installation uses it:

```bash
rm -f "$HOME/.greenways/bin/greenways-devtools-host"
```

Common Chrome manifest locations are:

```bash
# macOS
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.greenways.devtools.json"

# Linux
rm -f "$HOME/.config/google-chrome/NativeMessagingHosts/ai.greenways.devtools.json"
```

For Chrome Beta, Chromium, or Brave, use the corresponding browser directory printed by the installer.

## Security boundary

- The single service-worker Hara kernel remains the source of runtime authority.
- Remote packages cannot become root apps, register DevTools methods, add Chrome permissions, or introduce native handlers.
- The native companion contains no Hara runtime, package loader, keyring, or independent browser authority.
- The RESP listener binds only to loopback and requires a fresh 256-bit session token.
- RESP and Native Messaging requests are bounded to 1 MB.
- Module inventory and status do not expose archive bytes, credential values, private keys, or package source.

See [`protocol/devtools.md`](protocol/devtools.md), [`protocol/core-services.md`](protocol/core-services.md), [`protocol/packages.md`](protocol/packages.md), and [`protocol/keyring.md`](protocol/keyring.md) for the authority and wire-level contracts.

## Repository layout

- `extension/` — the retained Chrome-plugin boundary; its current kernel and
  package code is legacy until reduced to the folder mirror and website adapters.
- `native-host/` — the packaged Native Messaging companion for the closed
  Tahto-to-extension mirror boundary.
- `protocol/` — the retained plugin contracts, led by the future root-scoped
  mirror protocol.
- `docs/` — the current plugin architecture and complete migration inventory.
- `crates/`, `apps/`, `cli/`, `repl/`, `services/`, and `src/gw/os/` — legacy
  or migration material; see [the reorganisation inventory](docs/reorganisation-inventory.md).
