# Workspace architecture

> **Status: legacy/backlog.** Greenways OS is now only the Tahto-backed Chrome
> folder-mirror plugin. This Flow-first architecture is retained as historical
> evidence and must not guide active implementation. See [Chrome plugin
> architecture](chrome-plugin-architecture.md) and [#207](https://github.com/greenways-ai/greenways-os/issues/207).

The current product direction is Greenways Flow delivered and grounded by the
Greenways Fabric. Flow is what a person opens. Foreman remains Flow's internal
coordination engine and durable domain implementation.

Flow is a project-centred control plane for coordinating work across people,
local agents, remote agents, ChatGPT, GitHub, Emacs, Hara runtimes, and future
providers. It presents projects, queues, work graphs, evidence, history, and
truthful actions such as approve, resume, hand off, or open the relevant source
record.

The Fabric underneath Flow owns signed application delivery, application and
provider identities, host-issued capability grants, storage, replication,
work-runtime integration, and derived application indexes. Foreman owns the
durable project model and coordination rules exposed through Flow.

The earlier workspace/Chats design is retained as historical implementation
evidence. Names such as `ChatsService`, `ChatRepository`, and the
`greenways.chats/0-alpha` profile describe reusable transport and storage
primitives; they do not become Flow product navigation or a second application
identity.

Current architecture and technology mapping:

- [Greenways Fabric and Flow architecture](./fabric-architecture.md)
- [Greenways Fabric technology map](./fabric-technology-map.md)
- [Flow, Build, and Foreman compatibility](./flow-build-foreman-compatibility.md)
