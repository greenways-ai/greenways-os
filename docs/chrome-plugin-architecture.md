# Greenways OS Chrome plugin architecture

Status: active architecture for [#207](https://github.com/greenways-ai/greenways-os/issues/207).

Greenways OS is one Chrome plugin for a self-hosted Tahto Fabric. It is not a
Fabric server, a desktop suite, a package host, a programmable browser kernel,
or a collection of product surfaces.

## Product

A person selects one local Fabric folder and explicitly mirrors an exact
snapshot into the extension. The plugin stores that snapshot in IndexedDB and,
after a second explicit confirmation, invokes one reviewed website adapter
through the person's existing browser session.

```text
selected local folder
        │ Tahto logical tree and exact root
        ▼
Tahto host / closed native boundary
        │ selected manifest and bounded bytes
        ▼
Greenways OS Chrome plugin
        │ IndexedDB mirror
        ▼
reviewed website adapter ──► user-confirmed website operation
```

Tahto is the Fabric. Hoplite and Ignatius are infrastructure selected by the
Fabric host when needed; the extension does not compose or name them as product
surfaces. The shared [Visual Language](https://github.com/greenways-ai/visual-language)
supplies design rules and assets, not runtime authority.

## Authority and state

The local Fabric root remains authoritative. Extension IndexedDB is a
disposable materialisation: it holds the selected root, manifest, file metadata,
and bounded content cache, and can be rebuilt from the exact root at any time.
It does not write back to Fabric in the first release.

The only active plugin states are:

```text
unconfigured → source-selected → mirror-ready
                                     │
                                     ▼
                         adapter-selected → awaiting-confirmation
                                                     │
                                  ┌──────────────────┴──────────────────┐
                                  ▼                                     ▼
                              published                               failed
```

`published` records the selected root, adapter identity, user-confirmed target,
request time, and bounded remote result. It never means that a remote website
became a Fabric source of truth.

## Closed boundaries

The future Tahto-to-plugin protocol is a versioned, root-scoped mirror surface:

- open one previously selected Fabric root;
- read its immutable manifest; and
- read bounded byte ranges covered by that manifest.

It rejects arbitrary local paths, directory enumeration, writes, daemon
operation names, credentials, private keys, provider data, and generic RPC.
Native Messaging binds the exact extension, native host, and local Fabric host;
web pages cannot select another endpoint or credential.

Each website adapter is separately reviewed. It receives only the selected
snapshot and its adapter configuration, requires user confirmation at the point
of external effect, and may use only the browser origin permissions required by
that adapter. An adapter cannot discover other folders, browse IndexedDB
outside its snapshot, or make a website session into an ambient capability.

V1 is manual, one-way publication. There is no background watcher, scheduled
push, remote deletion, remote import, or bidirectional conflict handling.

## Repository boundary

Greenways OS retains the extension, its Native Messaging companion, the mirror
protocol, IndexedDB materialisation, and website adapters. The source inventory
is maintained in [the reorganisation inventory](reorganisation-inventory.md).

**Greenways DevTool** is the name for the separate developer-tool direction
previously described as `greenways-chrome`. It is not a second user-facing
Chrome product and must not reintroduce a general Hara kernel, browser REPL, or
privileged developer transport into Greenways OS.

Hestia, Hodos, Flow, Search, Timeline, Cowork, Spaces, rooms, provider
automation, Desktop, asset/package registries, and hosted MCP work are backlog.
They are not active plugin dependencies.

## Conformance required before implementation

- selected-root manifest round trip and exact digest validation;
- bounded content reads and rejection of paths outside the manifest;
- IndexedDB cache deletion and deterministic rebuild from the selected root;
- adapter invocation only after target-specific user confirmation; and
- rejection of arbitrary native-host and website-adapter commands.
