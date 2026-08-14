# Greenways browser bridge

`ai.greenways.browser_bridge` is the narrow Chrome Native Messaging companion for the daemon-first Greenways architecture.

The production Greenways Desktop path packages a self-contained Rust executable named `greenways-browser-bridge-host`. It connects the exact packaged extension to the private local `greenwaysd` Unix socket using one pre-enrolled `browser-bridge` credential. The extension can request only a bounded connection snapshot through the closed `connect`, `status`, and `disconnect` commands.

The host does **not** expose the Developer RESP bridge, `kernel.eval`, arbitrary daemon calls, filesystem access, HTTP access, capability inventory, provider credentials, private keys, key-store handles, the local-client token, its digest, or the daemon session ID.

## Production Desktop installation

Greenways Desktop setup exposes one no-argument semantic operation:

```text
install-browser-bridge
```

The request remains the exact four-field `greenways-desktop-setup/0-alpha` object and requires `handle: null`. Flutter cannot supply a browser, extension ID, origin, Greenways home, credential, manifest, host, runtime, command, socket, role, or label.

The reviewed macOS target is fixed:

```text
browser:           Google Chrome stable
extension ID:      iignnnidjioameihobbmbeimdgampooj
Native host:       ai.greenways.browser_bridge
client role:       browser-bridge
client label:      Chrome browser bridge
credential file:   ~/.greenways/clients/browser-bridge.json
installed host:    ~/.greenways/bin/greenways-browser-bridge-host
manifest:          ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.greenways.browser_bridge.json
```

The extension ID is derived from the committed public key in `extension/manifest.json`. `extension/extension-identity.json`, source packaging, archive verification, and loaded-extension browser tests all verify that same immutable public identity. No private extension signing key is stored in the repository.

Desktop verifies the packaged host before mutation, stops only `ai.greenways.greenwaysd`, issues exactly one distinct browser credential, atomically installs the exact host and manifest, verifies one fixed `allowed_origins` entry, and restores the daemon. Unsafe existing files, symlinks, wrong ownership or modes, host/manifest drift, duplicate active browser clients, and mixed partial installations fail closed.

The host is a standalone Rust executable. A clean installation does not require Node, Homebrew, `nvm`, `PATH`, a source checkout, or the runtime used to build Greenways Desktop.

Browser installation is optional. Deferring it creates no durable opt-out and does not mark the component ready. Successful installation also does not claim that the later connection/substrate `verify` operation has run.

## Development and manual tooling

The JavaScript implementation under this directory remains development/manual tooling for protocol tests and non-Desktop experiments. Its generic installer accepts explicit selectors and must not be called by Flutter or treated as the production Desktop authority boundary.

For a manual development installation, stop `greenwaysd`, issue a dedicated browser client, and restart the daemon after the offline registry mutation:

```sh
greenways-admin --state-dir ~/.greenways \
  client issue \
  --role browser-bridge \
  --label "Chrome browser bridge" \
  --output ~/.greenways/clients/browser-bridge.json
```

The manual installer may then target a development browser and extension identity explicitly:

```sh
node services/browser-bridge/bin/greenways-browser-bridge-install.mjs \
  --extension-id <development-extension-id> \
  --browser chrome
```

Its Chrome Beta, Chromium, Brave, Linux, custom-home, and custom-credential options are not part of the reviewed Greenways Desktop setup contract.

## Test

```sh
npm --prefix services/browser-bridge ci
npm --prefix services/browser-bridge test

cargo +1.85.1 test -p greenways-browser-bridge-host --all-targets
cargo +1.85.1 clippy -p greenways-browser-bridge-host --all-targets -- -D warnings
```
