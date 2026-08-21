# hara-chrome

A Chrome MV3 DevTools extension that embeds the Hara WASM runtime in a panel,
exposes a local RESP REPL, and provides a closed DOM-control surface.

```clojure
(require [browser.dom :as dom])
(require [chrome.api :as api])
```

## Guides

- [Browser control examples](browser-control-examples.md) — forms, scrolling,
  mouse and keyboard input, network observation, interception, blocking, and
  request headers.
- [ChatGPT web-app REPL map](chatgpt-webapp-repl.md) — a read-only-first,
  fail-closed design for chats, projects, pinned chats, search, composer
  control, and later reversible organization actions.
- [ChatGPT capability manifest](chatgpt-webapp-capabilities.edn) —
  machine-readable entities, operations, risk levels, confirmation contracts,
  selector policy, and delivery phases.

## Remote Hara execution host

The first language-owned execution-host slice is a closed, outbound-only
client for the local `mcp.hara-lang.org` relay vocabulary. It validates exact
`hara.execution-host/0-alpha` values, polls only an explicit
`http://127.0.0.1:<port>` endpoint, de-duplicates commands, propagates
cancellation, and retries one immutable terminal result. See
[Remote Hara execution host](remote-hara-host.md).

This is transport infrastructure only. The current extension does not start
the client, request loopback host permission, or route remote work into the
trusted browser runtime. A subsequent slice must supply a fresh restricted
Rust/Wasm Sandbox executor before the host can become a real Hara execution
surface.

## Runtime features

- **Panel Studio** — the shared Hara Studio environment running the raw Hara
  WASM runtime in Web Workers.
- **`browser.dom`** — panel-bound query, snapshot, refresh, focus, fill, click,
  and detach operations using opaque backend node references.
- **`chrome.api`** — lower-level Chrome and CDP calls for reviewed development
  workflows.
- **Target binding** — `make dev URL=...` resolves one exact CDP target to one
  exact Chrome tab ID before opening the panel.
- **Home directory** — pick a local directory and load or require `.hal` files.
- **RESP endpoint** — a loopback RESP TCP to WebSocket bridge lets editor tools
  evaluate Hara inside the browser runtime.

See the repository README for build, test, lifecycle, and trust-boundary
details.
