# Greenways OS reorganisation inventory

Status: active inventory for [#207](https://github.com/greenways-ai/greenways-os/issues/207). It classifies current code before any runtime moves. A classification is not evidence that the target implementation already exists.

## Target tree

```text
greenways-os/
  extension/       Chrome UI, mirror cache, approved website adapters
  native-host/     Native Messaging companion for the closed mirror protocol
  protocol/        Chrome-plugin and root-scoped mirror contracts
  docs/            product boundary and migration inventory
```

The existing paths remain in place during the inventory phase. Later commits
move one complete, tested boundary at a time; they do not copy old writable
authority into the new tree.

## Classification

| Current area | Disposition | Target boundary |
| --- | --- | --- |
| `extension/` | retain and reduce | Chrome plugin only: mirror UI, IndexedDB, explicit adapters, and browser permissions |
| `native-host/` | retained | packaged Native Messaging companion; replace its status-only bridge with the closed mirror surface |
| `protocol/browser-bridge.md` | rewrite in place | root-scoped manifest and bounded content reads |
| `services/greenwaysd/` and `crates/greenways-{authority,applications,capabilities,hestia,identity,local,protocol,provider,vault,workspace-contracts}` | migrate or freeze | Tahto Fabric/host work or backlog; none remain an OS-owned Fabric core |
| `cli/`, `repl/`, `services/devtools-node/`, and kernel/REPL-specific `src/gw/os/` code | separate or freeze | Greenways DevTool or backlog; never a normal plugin feature |
| `apps/greenways_desktop/` and desktop bridge | backlog | no desktop product in Greenways OS |
| `services/{assets,packages,mcp-gateway,identity,home-node,beacon,browser-bridge}` | backlog or owning product | no active Chrome folder-mirror responsibility |
| Flow, Spaces, Chats, rooms, provider, Hestia, package, and workspace protocol documents | backlog evidence | retain history, but do not extend as active OS design |
| generic `src/gw/os/adaptor.hal` | assess separately | Hara only if it is made genuinely product-neutral; otherwise freeze with legacy code |

## Migration rules

- Keep one authoritative copy of a writable concern. The extension must not
  retain a second Fabric store, sync engine, capability authority, or identity
  vault after Tahto owns that concern.
- Do not move a path merely because it uses Chrome. Browser developer tooling
  belongs to Greenways DevTool; user folder mirroring belongs to Greenways OS.
- Preserve legacy code and fixtures until a replacement passes its focused
  conformance checks. Mark it backlog rather than presenting it as current.
- A target-specific website adapter needs its own issue, origin allowlist,
  explicit confirmation step, and conformance fixture before being enabled.

## Documentation status

[Chrome plugin architecture](chrome-plugin-architecture.md) is the current
product authority. The earlier Fabric/Flow and five-surface documents remain
historical design and compatibility evidence only. Their linked issues are
closed in favour of #207.
