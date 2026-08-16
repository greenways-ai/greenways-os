# hara-chrome

Chrome (MV3) DevTools extension for inspecting live Hara browser kernels and
bridging them to Emacs or VS Code over Hara RESP protocol 4.

The panel contains its own shared Studio environment, and its toolbar scans the
inspected page for every kernel exposed through either:

- `globalThis[Symbol.for("hara.devtools.registry.v1")]`, the preferred stable
  page debugging contract; or
- `window.hara = { broker, ... }`, the compatibility adapter used by existing
  Hara browser applications.

Selecting a page kernel makes it the target used by the RESP bridge and by
`window.hara.evalSource`. Local DevTools kernels remain available under
**DevTools Local**.

## Meta-workspace layout

The build resolves Hara from the Greenways meta-workspace rather than from the
standalone Greenways OS repository:

```text
$HARA_WORKSPACE_ROOT/
  application/greenways-os/extension/hara-chrome
  technology/hara
```

`HARA_WORKSPACE_ROOT` is detected by walking up from this directory. Set it
explicitly when invoking the extension from another checkout layout.

## Long-lived headless development runtime

From `application/greenways-os/extension/hara-chrome`:

```sh
make dev
```

This command:

1. installs missing npm dependencies and Playwright's bundled full Chromium;
2. builds the VM WASM artifact with
   `technology/hara/scripts/runtime/build-hara-wasm-raw`;
3. stages the browser runtime with the native `scripts/sync-runtime.hal`
   workflow;
4. starts the loopback RESP and token-protected WebSocket bridge;
5. launches the unpacked extension in a persistent, full headless Chromium
   context;
6. opens the local panel, waits for its WASM kernel and bridge connection, and
   evaluates `(+ 40 2)` through protocol 4; and
7. prints `HARA RESP 127.0.0.1:7355` and remains alive until Ctrl-C.

The default profile is disposable. Supply `PROFILE_DIR` only when browser state
must survive between runs:

```sh
make dev RESP_PORT=7355 WS_PORT=7356 PROFILE_DIR="$HOME/.hara-chrome-profile"
```

Other supported overrides are:

```sh
make dev HARA_WORKSPACE_ROOT=/path/to/greenways-workspace
make dev RESP_PORT=17355 WS_PORT=17356
```

`make dev` builds once. File watching and automatic extension reload are not
part of this workflow.

## Build

```sh
make build
```

`npm run build` delegates to the same Makefile-owned build. To stage assets
without rebuilding WASM, use `make sync` or `npm run sync`.

The native sync copies the current HTA package tree, host support, Studio tree,
VM WASM artifact, and versioned Hara UI files. This preserves current relative
module imports such as `hta.js -> packages/hta/index.js` and
`studio/broker.js -> host/broker.js`.

## Load manually

`chrome://extensions` -> developer mode -> **Load unpacked** -> select this
directory. Open DevTools and choose the **hara** panel.

## Emacs connection

No `hara-emacs` changes are needed. Configure the external browser runtime:

```elisp
(setq hara-host "127.0.0.1"
      hara-port 7355
      hara-auto-start nil)
```

`hara-mode` negotiates `HELLO 4`, attaches to the browser's `ROOT` session, and
uses the existing `EVAL`, `SESSION`, `DOC`, and `COMPLETE` commands.

## Test

```sh
make test
make test-sync
make test-browser
```

`make test-sync` uses separate Hara processes to evaluate the native sync
candidate, execute the written workflow, and validate focused staged assets.
`make test-browser` builds first, installs full Chromium when absent, and runs
the Playwright suite directly in unified headless mode; Xvfb is not required.

The page-target and protocol tests can still run without built WASM vendor
files:

```sh
node --test test/page-target.test.js test/resp-protocol.test.js
```

Browser integration covers a real unpacked extension on isolated bridge ports,
protocol-4 negotiation, `ROOT` attachment, and an Emacs-framed
`(+ 40 2) -> 42` evaluation. The launcher lifecycle test terminates the
long-lived process and checks that Chromium cleanup has completed and both
listener ports are closed.

## Kernel inspection contract

A page can expose multiple brokers through a registry:

```js
const key = Symbol.for("hara.devtools.registry.v1");
globalThis[key] = {
  describe: async () => ({
    version: 1,
    brokers: [{
      id: "app",
      label: "My Hara app",
      activeKernel: "ROOT",
      kernels: [{ name: "ROOT", state: "running", active: true }],
      documents: [],
    }],
  }),
  eval: ({ brokerId, session, source }) => appBroker.eval(session, source),
  listKernels: ({ brokerId }) => appBroker.list(),
  inspectKernel: ({ session }) => ({ name: session }),
  createKernel: ({ session }) => appBroker.create(session),
  closeKernel: ({ session }) => appBroker.close(session),
};
```

For a single broker, exposing `window.hara.broker` is enough for discovery,
evaluation, creation and closure. The explicit registry is recommended because
it can provide richer telemetry, documentation, completion and multiple broker
identities without exposing internal objects.

## RESP bridge

The development launcher owns the bridge automatically. It can also be started
on its own:

```sh
node bridge/resp-bridge.mjs
```

Defaults:

- RESP: `127.0.0.1:7355`
- extension WebSocket: `127.0.0.1:7356`

The bridge implements Hara protocol 4 framing used by `hara-mode`, including
`HELLO`, `INFO`, `TARGET`, `SESSION`, `EVAL`, `LOAD`, `DOC`, `COMPLETE`, `PING`
and `QUIT`. It also keeps legacy `EVAL <session> <source>`, `SESSION CREATE` and
`SESSION DELETE` aliases for the current VS Code client.

Typical protocol flow:

```text
HELLO 4 CLIENT EMACS
TARGET LIST
TARGET ATTACH page:app
SESSION LIST
SESSION ATTACH game
EVAL REQ-1 "(+ 1 2)"
```

### Bridge token

`make dev` generates an ephemeral WebSocket token and places it only in the
panel URL. For a manually launched bridge, set `HARA_BRIDGE_TOKEN` and include
the same token in the toolbar URL:

```sh
HARA_BRIDGE_TOKEN=secret node bridge/resp-bridge.mjs
```

```text
ws://127.0.0.1:7356/?token=secret
```

## Home directory

The panel can load `.hal` sources from a local directory:

- **choose home** picks a directory and restores it when permission remains.
- `project.edn` or `project.hal` supplies `:source-paths`.
- **run .hal file** evaluates the file in the selected page or local kernel.
- Namespace preloading from the chosen home applies to local DevTools kernels;
  page kernels resolve resources using the page application's own loader.

## Trust boundaries

Both listeners bind to `127.0.0.1`. A connected editor can evaluate code in the
selected Hara kernel, and a local DevTools kernel can use the extension's
privileged Chrome host calls. Page inspection uses
`chrome.devtools.inspectedWindow.eval`, so the extension does not request broad
page host permissions.

Targets are rescanned after navigation. A pending request fails with
`HARA_PAGE_RELOADED` when the inspected document changes before it completes.
