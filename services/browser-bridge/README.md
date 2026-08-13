# Greenways browser bridge

`ai.greenways.browser_bridge` is the narrow Chrome Native Messaging companion for the daemon-first Greenways architecture.

It connects the exact packaged extension to the private local `greenwaysd` Unix socket using one pre-enrolled `browser-bridge` credential. The extension can request only a bounded connection snapshot through the closed `connect`, `status`, and `disconnect` commands.

The host does **not** expose the Developer RESP bridge, `kernel.eval`, arbitrary daemon calls, filesystem access, HTTP access, capability inventory, provider credentials, private keys, key-store handles, the local-client token, or the daemon session ID.

## Prepare the browser client

Stop `greenwaysd`, then issue the fixed local client credential:

```sh
greenways-admin --state-dir ~/.greenways \
  client issue \
  --role browser-bridge \
  --label "Chrome browser bridge" \
  --output ~/.greenways/clients/browser-bridge.json
```

Start `greenwaysd` again after the offline mutation completes.

## Install the Native Messaging manifest

Use the exact packaged extension ID shown by `chrome://extensions`:

```sh
node services/browser-bridge/bin/greenways-browser-bridge-install.mjs \
  --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --browser chrome
```

Optional fixed paths can be supplied at installation:

```sh
  --greenways-home ~/.greenways \
  --credential ~/.greenways/clients/browser-bridge.json
```

The installer supports Chrome, Chrome Beta, Chromium, and Brave on macOS and Linux. The generated Native Messaging manifest has one exact `allowed_origins` entry. The extension cannot select another socket or credential path at runtime.

## Test

```sh
npm --prefix services/browser-bridge ci
npm --prefix services/browser-bridge test
```
