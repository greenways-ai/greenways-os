# Greenways DevTools native host

This is the narrow native companion for the preinstalled Greenways OS Kernel DevTools app.
It contains no Hara runtime and has no independent extension authority. Chrome starts it over
Native Messaging; it then opens an authenticated RESP2 listener on `127.0.0.1` for the life of
the DevTools bridge session.

## Install

Load the extension, copy its exact extension id from `chrome://extensions`, then run:

```bash
node bin/greenways-devtools-install.mjs \
  --extension-id aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --browser chrome
```

Supported browser names are `chrome`, `chrome-beta`, `chromium`, and `brave` on macOS and Linux.
The installer writes an exact `allowed_origins` entry; wildcards are never used.

## Use

Start the bridge from Kernel DevTools and copy its one-session token:

```text
redis-cli -h 127.0.0.1 -p 46379
AUTH <session-token>
GW.STATUS
GW.MODULES
GW.SERVICES
GW.EVAL gw.devtools "(+ 20 22)"
GW.CALL core/services "[]"
```

Stopping the bridge destroys the token and terminates the native connection. The listener never
binds to a non-loopback address.
