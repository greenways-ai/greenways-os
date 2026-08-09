# Application state and control boundary

Greenways applications use two interfaces. They do not select storage,
signers, workers, connectors, or remote providers.

```text
application HAL
  |
  +-- tahto.semantic  ordinary semantic state
  |     open · get · query · heads · transact · sync
  |
  `-- hestia.control consequential operations
        propose · approve · execute · cancel · status · receipt
```

The application request envelope is closed:

```clojure
{:service "tahto.semantic" | "hestia.control"
 :operation <closed operation name>
 :arguments [...]}
```

Greenways OS resolves the installed app from its exact `project.edn`, checks
the operation's capability against both that project and the active grant, and
then dispatches to the installed service. An application cannot name a native
ABI, connector, key, database, filesystem path, worker, or provider.

## Ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| Application | domain behaviour, UI, domain merge policy | host effects or persistence providers |
| Greenways OS | installation, keys, consent, grants, host adapters, service selection | semantic history or workflow policy |
| Tahto | semantic collections, stable IDs, typed links, roots, divergence and sync planning | signing, work execution, accepted workflow outcomes or physical durability |
| Hestia | intent, approval, workflow policy and consequential-operation control | application content storage or native execution |
| `std.work` | execution, checkpointing, recovery and operational receipts | human approval or canonical evidence policy |
| Ignatius | immutable blocks, scoped refs, signed evidence and provenance verification | workflow scheduling, Git orchestration or application semantics |
| Host providers | bytes, transactions, transport and connector mechanics | policy or application meaning |

## State path

An ordinary edit goes directly through Tahto. Tahto validates the semantic
transaction, stores immutable content through the installed Ignatius storage
contract, and advances a small scoped collection ref. Tahto-local queues,
cursors, leases and caches are operational and rebuildable.

```text
app -> tahto.semantic -> Tahto -> Ignatius blocks + scoped refs -> provider
```

## Controlled-operation path

A consequential action goes through Hestia. Approval binds the exact subject
root reviewed by the person. Hestia queues execution through `std.work`, then
records the resulting generic work receipt as signed Ignatius evidence. Only a
trusted OS adapter may interpret the approved effect at the native edge.

```text
app -> hestia.control -> approval -> std.work -> connector
                                  -> Ignatius evidence
```

Ignatius re-verifies the generic evidence envelope, signature, signer scope,
sequence and idempotency key. It does not reinterpret the Hestia workflow.

## Application packaging

`project.edn` is the sole application descriptor. It binds project coordinate,
version, main HAL entry, source paths and requested capabilities. Catalog and
approval records are derived from the exact descriptor bytes and retain its
digest. A second manifest vocabulary is invalid.

Chats and Userscripts are the first conformance applications:

- Chats stores captures through `tahto.semantic`; sharing is proposed through
  `hestia.control`.
- Userscripts stores drafts through `tahto.semantic`; enabling or executing a
  script is controlled by Hestia. It cannot call a browser connector directly.
