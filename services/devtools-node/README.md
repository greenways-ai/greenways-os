# Greenways DevTools native host

`services/devtools-node` is the narrow Native Messaging companion for the preinstalled Greenways OS Kernel DevTools app.

It contains no Hara runtime, package loader, keyring, credential store, or independent extension authority. Chrome starts it over Native Messaging. For the life of that connection, it may open an authenticated RESP2 listener on `127.0.0.1` so local editors and command-line tools can program the resident browser kernel.

The canonical end-to-end installation is in [`../../README.md`](../../README.md). The commands below also use the repository root as the working directory.

## Requirements

- Node.js 22 or newer;
- Greenways OS built and loaded unpacked in Chrome, Chrome Beta, Chromium, or Brave;
- macOS or Linux; and
- `redis-cli` or another RESP2 client for connection testing.

The extension and its in-browser REPL do not require this companion. The installer does not yet support Windows.

## Test the companion

```bash
npm --prefix services/devtools-node ci
npm --prefix services/devtools-node test
```

## Install

1. Build and load `extension/` from `chrome://extensions`.
2. Copy the exact 32-character ID displayed for Greenways OS.
3. From the repository root, run:

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

The installer rejects an invalid extension ID and writes one exact allowed origin:

```text
chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/
```

Wildcards are never used. After installation, reload Greenways OS from `chrome://extensions`.

## Installed files

The host wrapper is written to:

```text
~/.greenways/bin/greenways-devtools-host
```

The browser-specific Native Messaging manifest is named:

```text
ai.greenways.devtools.json
```

The installer prints the exact manifest location. Common Chrome locations are:

```text
macOS: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
Linux: ~/.config/google-chrome/NativeMessagingHosts/
```

Chrome Beta, Chromium, and Brave use their corresponding browser directories.

The wrapper currently points to the Node executable and `greenways-devtools-host.mjs` in the repository checkout used during installation. Keep both paths stable. Rerun the installer after moving the checkout, replacing that Node installation, changing browsers, or loading Greenways OS under a different extension ID.

## Start the bridge

1. Open the Greenways OS side panel.
2. Select **Open DevTools**.
3. In **RESP bridge**, select a loopback port such as `46379`.
4. Select **Start RESP**.
5. Copy the displayed session token.

The host refuses a non-loopback bind address. Stopping the bridge or closing the Native Messaging connection destroys the token and closes the listener.

## Connect

```bash
redis-cli -h 127.0.0.1 -p 46379
```

Then enter:

```text
AUTH <session-token>
PING
GW.STATUS
GW.MODULES
GW.SERVICES
GW.EVAL gw.devtools "(+ 20 22)"
GW.CALL core/services "[]"
QUIT
```

The closed command vocabulary is:

```text
PING [message]
AUTH <session-token>
GW.STATUS
GW.MODULES
GW.SERVICES
GW.EVAL <namespace> <source>
GW.CALL <kernel-method> [json-array]
QUIT
```

All `GW.*` commands require authentication. Namespace names, kernel methods, argument counts, and message sizes are validated before forwarding.

## Troubleshooting

### `Specified native messaging host not found`

Rerun the installer with the exact extension ID and the browser that is loading Greenways OS. Confirm that the printed manifest path belongs to that browser, then reload the extension.

### `Access to the specified native messaging host is forbidden`

The manifest's `allowed_origins` entry does not match the current extension ID. Rerun the installer with the ID shown at `chrome://extensions`.

### The bridge reports that the port is unavailable

Choose another port from 1024 to 65535. The listener always uses `127.0.0.1`; it never binds to all interfaces.

### RESP returns `NOAUTH` or rejects the token

Stop and restart the bridge, then use the newly displayed token. Tokens cannot be reused across sessions.

### The host worked before the repository or Node installation moved

Rerun the installer. The generated wrapper records the absolute Node and host-script paths active during installation.

### `redis-cli: command not found`

Install the Redis command-line tools or use another RESP2 client. A Redis server is not needed.

## Uninstall

Stop the bridge first, then remove the browser's `ai.greenways.devtools.json` manifest and the wrapper:

```bash
rm -f "$HOME/.greenways/bin/greenways-devtools-host"
```

For Chrome:

```bash
# macOS
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.greenways.devtools.json"

# Linux
rm -f "$HOME/.config/google-chrome/NativeMessagingHosts/ai.greenways.devtools.json"
```

Use the browser-specific directory printed by the installer for Chrome Beta, Chromium, or Brave.

## Security properties

- The listener binds only to loopback.
- A fresh random 256-bit token is required for every bridge session.
- Native and RESP messages are bounded to 1 MB.
- The command set is fixed; the native host cannot add kernel methods or browser privileges.
- The host transports typed requests to the fixed root DevTools principal; it does not evaluate Hara itself.
- Status and module inventory do not expose package archives, raw credentials, private keys, or source material.

See [`../../protocol/devtools.md`](../../protocol/devtools.md) for the normative authority and wire-level contract.
