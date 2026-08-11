# Greenways Kernel DevTools protocol

Status: root-OS draft
Root app protocol: `greenways-root-app/0-alpha`
DevTools protocol: `greenways-devtools/0-alpha`
Bridge protocol: `greenways-devtools-bridge/0-alpha`

## Purpose

The first Greenways OS extension is the resident browser operating system plus one preinstalled
root application: Kernel DevTools. Developer Tools allows the owner of the browser profile to
inspect and program the single service-worker Hara kernel before any optional application is
installed.

Developer Tools is not a registry package. It is shipped with the reviewed OS build, cannot be
removed, cannot be replaced by a release or preview package, and cannot delegate its root
authority to an ordinary app.

## Root application boundary

The fixed root application is:

```text
id          greenways-devtools
path        src/devtools.html
authority   kernel/inspect, kernel/evaluate, devtools/bridge
installed   always
removable   never
```

The root shell may open this exact packaged page. Package manifests cannot claim a root-app id,
path, principal, method, or authority. Registry signatures and package hashes never grant root
access.

The DevTools page contains no Hara runtime. It attaches to the same service-worker kernel used by
the rest of Greenways OS. Build checks reject a second Wasm kernel in the DevTools page bundle.

## Kernel console

The fixed DevTools principal may use the following host methods:

```text
devtools/status
devtools/modules
devtools/eval
devtools/call
core/services
capabilities/vocabulary
capabilities/list
capabilities/check
```

`devtools/eval` accepts an explicit namespace and at most 1 MB of Hara source. Evaluation is
serialized by the service-worker host, and the prior namespace is restored after the expression
completes or fails.

`devtools/call` invokes an existing reviewed kernel method. It cannot recursively call a
`devtools/*` method and it cannot add host handlers, effects, browser permissions, native
providers, or service definitions.

The root principal has no state-changing kernel dispatch vocabulary in v1. Changes to internals
are made by evaluating explicit Hara source or calling an already reviewed kernel method, so the
developer can see exactly which boundary is being crossed.

## Local RESP bridge

Manifest V3 extension pages do not open a raw TCP listener. The root app may start the separately
installed native host `ai.greenways.devtools` through Chrome Native Messaging. That host contains
no Hara runtime and receives no Keyring secrets. Its only duties are:

1. accept a one-session configuration message from the extension;
2. bind a RESP2 listener to `127.0.0.1` on the selected unprivileged port;
3. require the fresh session token with `AUTH`;
4. translate the closed RESP command vocabulary into typed native messages; and
5. terminate the listener when the extension disconnects or stops the bridge.

The token is generated with Web Crypto inside the extension, sent to the native host over its
private stdio channel, displayed only to the active root DevTools page, never persisted, and
destroyed when the bridge stops.

### RESP commands

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

All commands other than `PING`, `AUTH`, and `QUIT` require authentication. Successful Greenways
responses are RESP bulk strings containing JSON. Failures are RESP errors. Requests and responses
are bounded to 1 MB, and the bridge accepts at most 64 command arguments.

The listener cannot bind to `0.0.0.0`, `::`, a LAN address, or a remote interface. A future remote
programming service requires a separate protocol, identity proof, capability grant, and receipt
model; it is not an extension of this loopback bridge.

## Native-host installation

The native messaging manifest names one exact Chrome extension origin:

```json
{
  "name": "ai.greenways.devtools",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<exact-extension-id>/"]
}
```

Wildcards are forbidden. The installer writes a user-level host manifest and a small executable
wrapper for the current Node runtime. The native process cannot start Greenways OS, install apps,
read IndexedDB, inspect arbitrary tabs, access the Keyring, or evaluate Hara without an active
extension request.

## Laws

1. **Root app is fixed.** Only the reviewed OS build defines a root app or root principal.
2. **One kernel.** DevTools uses the service-worker kernel and never embeds another Hara runtime.
3. **Loopback only.** The RESP listener binds exactly to `127.0.0.1`.
4. **Fresh authentication.** Every bridge start generates a new memory-only token.
5. **Closed commands.** RESP and native messages cannot introduce methods or effects.
6. **No ambient secrets.** Status, evaluation, and bridge evidence contain no private keys or
   provider credentials.
7. **Companion is transport only.** The native host cannot evaluate Hara or grant itself authority.
8. **Disconnect closes authority.** Closing the native port terminates clients and invalidates the
   token.
