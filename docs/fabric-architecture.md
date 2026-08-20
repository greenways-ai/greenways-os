# Greenways Fabric architecture

## Status

This document records the current product direction. It supersedes the earlier
Chats-first workspace architecture as the north-star design. Existing daemon,
Desktop, browser, Chats, and compatibility code remains implementation and
migration evidence; it is not automatically the final product boundary.

## Product boundary

Greenways OS is a private personal Fabric installed on Windows, Linux, and
macOS. It lets a person control storage on their own devices, connect trusted
clients, collaborate with other people, and run applications and AI agents
against explicitly granted authority.

Greenways OS is not the foreground product interface. It is the installed
foundation that delivers and grounds applications. A person installs
Greenways OS; setup installs the required Fabric components, connects the
device, installs the bundled Foreman application, and opens Foreman without
asking the person to understand the kernel, service, runtime, keychain, or
identity protocols.

Public publication and multi-channel delivery belongs to the separate
`greenways-platform` product. Greenways OS may prepare an immutable release for
publication, but it does not own public channel delivery.

The enabling technologies used to implement storage, synchronization,
identity, automation, history, databases, servers, and interfaces are not part
of the Greenways product vocabulary. They remain replaceable behind product
contracts and adapters.

Their intended internal composition is documented separately in
[Greenways Fabric technology map](fabric-technology-map.md). In short, Tahto
owns portable semantic, authority, and synchronization contracts; Hestia owns
source-grounded knowledge graphs, evidence, and retrieval; Hodos is a
client-only Hara package catalogue and materializer; and Hoplite and Ignatius
are effectful serving and shared-finality executors. Historia is a migration
source for Hestia, not a permanent peer service. Greenways OS retains local key
custody, enforcement, provider selection, installation trust, and product
composition.

## Product vocabulary

The user-facing model uses ordinary terms:

| Term | Meaning |
| --- | --- |
| Fabric | A person's private Greenways environment |
| Fabric Server | The trusted service that owns durable Fabric state |
| Client | A Desktop, CLI, browser, or other enrolled interface |
| Device | A trusted computer participating in the Fabric |
| Person | A human identity presented by name and profile |
| Agent | A named AI profile with its own permissions and history |
| App | A product installed on the Fabric, such as Foreman |
| Project | A bounded body of work and its external references |
| Work item | A requested outcome, such as a feature or GitHub issue |
| Run | One bounded execution performed by an agent session |
| Session | A live connection to an AI provider or tool |
| Message | A durable request, response, progress event, or cancellation |
| Approval | A human decision authorising a consequential operation |
| Activity | The attributable history of Fabric operations |

Keys, signatures, credentials, certificates, grants, protocol frames, and
provider tokens are implementation details. Users see people, agents, devices,
connections, permissions, approvals, and recovery.

## Experience hierarchy

The product hierarchy is:

```text
Foreman                              what the person opens and uses
  <- Greenways application host      installs, verifies, updates and presents it
    -> Greenways Fabric Server       grounds identity, storage, messages and work
      -> operating system            supplies process, filesystem and key storage
```

Foreman is presented as the application name in window titles, installers,
launchers, browser surfaces, commands, and ordinary help. Greenways appears as
the trusted product family and connection status, not as an operating-system
console.

Fabric controls remain available where a person expects them:

- **Settings > Devices** for connected computers and revocation;
- **Settings > People and agents** for profiles and permissions;
- **Settings > Connections** for providers and external tools;
- **Settings > Storage** for local locations, replicas, and recovery; and
- **Help > Diagnostics** for technical runtime and protocol detail.

There is no ordinary Keychain, Kernel, Provider, Capability, Receipt, Hara,
Hestia, Tahto, or daemon navigation. Those concepts are translated into Access,
Connections, Activity, Storage, and Diagnostics.

## System shape

```text
               Foreman
        +----------+-----------+
        |          |           |
     Desktop      CLI       Browser
        \          |          /
         +---- Greenways client host
                    |
           +--------v---------+
           |  Fabric Server   |
           |                  |
           |  Embedded kernel |
           |  Fabric services |
           |  App services    |
           +--------+---------+
                    |
     +--------------+---------------+
     |              |               |
  Storage       Other Fabrics    External tools
```

An ordinary installation may run the Fabric Server and Desktop client on the
same computer. A home server may run the Fabric Server continuously while
laptops, phones, browser extensions, and command-line tools connect as clients.
The distinction is authority, not physical hardware.

## Fabric Server

The Fabric Server is a cross-platform background service. It owns:

- Fabric identity and recovery state;
- person, device, client, app, and agent enrolment;
- local storage locations and durable records;
- permissions and approval decisions;
- secure client and Fabric-to-Fabric messaging;
- application installation and lifecycle;
- durable work, run, message, artifact, and activity records;
- background scheduling and resumable jobs;
- connector credentials through operating-system secret storage; and
- bounded APIs used by clients and installed applications.

The server may use an embedded programmable runtime, but clients invoke loaded,
versioned application operations rather than submitting arbitrary source to the
server. The runtime and its implementation language are not exposed as product
concepts.

One Fabric generation has one active writable authority. Backups and replicas
do not silently promote themselves. Promotion and recovery are explicit and
produce visible activity records, preventing two disconnected writable copies
from both claiming to be current.

## Fabric Client

A client is an enrolled interface to a Fabric. Initial clients are:

- Desktop, for installation, recovery, permissions, projects, agents, and
  application interfaces;
- CLI, for terminals, automation harnesses, and local development tools; and
- Browser, for reviewed interaction with web applications and browser-only
  provider sessions.

These are delivery surfaces rather than separate product centres. Foreman owns
the user experience presented through each surface. The generic client host
handles connection, app loading, permissions, secure messages, updates, and
local capability brokering underneath it.

Clients hold only the credentials and permissions required for their role.
They do not receive Fabric root keys, raw provider credentials, or an
unrestricted database interface. Losing a client can revoke that client
without replacing the person's identity or other devices.

The connection experience should resemble a private network product: install
Greenways, name the device, approve the connection, and arrive in Foreman. The
cryptographic and transport details remain invisible unless a user opens
diagnostics.

## People and AI agents

A person has one understandable Greenways identity with recovery and trusted
devices. An AI agent is a separate named profile owned or admitted by a person.
For example:

```text
Person: Alex
Agents:
  Builder       may edit code and run tests
  Reviewer      may read changes and submit review findings
  Publisher     may prepare releases but requires approval to publish
```

An agent profile is stable across providers. It contains presentation,
instructions, project access, tool permissions, approval policy, and activity
history. It does not equate to a provider account or one running conversation.

The model separates:

- **provider connection** — access to Codex, Kimi, ChatGPT, or another service;
- **agent profile** — the stable Greenways identity and policy;
- **session** — one live provider or tool conversation; and
- **run** — one bounded unit of work assigned to that session.

Changing provider does not erase the agent's Greenways identity, project
history, or authority policy.

## Application model

The kernel supplies identity, permissions, records, messaging, jobs, storage,
and application isolation. Product behavior lives in installed applications.
The first application is Foreman.

An installed application has two ordinary parts:

```text
Foreman frontend
  Desktop, browser and CLI presentation
          |
          v
Foreman application service
  projects, buildouts, runs, messages and external-tool coordination
          |
          v
Greenways Fabric API
  identity, access, content, storage, sync, messaging, work and connections
```

Foreman builds on the Greenways Fabric API. It does not call Hoplite, Historia,
Tahto, Hestia, Ignatius, Hara, Hodos, a database, or a keychain directly. The
Fabric Server composes those implementation technologies behind the API.

The frontend receives bounded view models and sends closed application events.
It does not reconstruct authority, merge synchronized state, interpret chain
records, or possess provider credentials. Those responsibilities remain in the
Foreman application service and Greenways Fabric services.

An application declares its operations and required permissions. Installation
does not grant every requested permission. Consequential operations are checked
at execution time and may require a visible human approval.

Applications interact through versioned Fabric contracts rather than importing
the implementation details of the technologies beneath the Fabric.

The first Fabric API should remain small and product-oriented:

```text
people        current person, agents and collaborators
access        permissions, approvals and revocation
content       records, ancestry, attachments and search
storage       local availability, replicas and recovery
sync          availability and synchronization state
messages      durable requests, replies, progress and cancellation
work          work items, runs, checkpoints, artifacts and outcomes
connections   available provider, browser, CLI and external-tool sessions
activity      attributable history and external verification
```

These names are stable Greenways product contracts. Their implementations may
compose several infrastructure services and may evolve without forcing Foreman
to adopt infrastructure-specific records.

## Application delivery

Foreman is delivered by Greenways OS as its preinstalled default first-party
application, but it remains architecturally separate from the kernel:

```text
Greenways OS installer or update
  -> installs or verifies the Greenways Fabric Server
  -> installs the application host for this operating system
  -> verifies and installs the signed Foreman application package
  -> enrols this device through ordinary setup
  -> opens Foreman
```

The Fabric Server can start, recover, synchronize, and enforce permissions
without Foreman running. Foreman can update or restart without replacing the
person's Fabric identity or durable history. Future Greenways applications use
the same installed foundation rather than shipping another private service,
identity system, or data authority.

Greenways OS owns Foreman installation, update, rollback, and launch. Foreman
does not update or replace the kernel beneath itself. The application package
is independently versioned so its interface and coordination behavior can
evolve without treating the Fabric as disposable application state.

A Foreman application release contains only the pieces required by its
declared surfaces and service operations:

- shared application metadata and permissions;
- project, work-item, buildout, run, and message operations;
- Desktop views;
- CLI commands;
- browser companion views and reviewed browser commands;
- provider and tool adapter declarations; and
- migrations for Foreman-owned records.

The Greenways client host verifies, loads, and connects those pieces. Foreman
does not receive unrestricted access to the Fabric database, root identity, or
other installed applications.

## Foreman

Foreman is the frontend and application service for unified work and agent
coordination. It is broader than a terminal coding harness: it presents CLI
sessions, browser sessions, desktop tools, provider APIs, GitHub work, build
systems, and other web applications around the same project outcomes.

Its primary views are intentionally ordinary:

- Projects;
- Work items;
- Buildouts;
- Agents;
- Sessions;
- Approvals;
- Outputs; and
- Activity.

A **buildout** groups work performed across multiple platforms toward the same
project outcome. It can include GitHub issues, agent runs, provider sessions,
branches, pull requests, CI jobs, browser interactions, artifacts, decisions,
and unresolved blockers. Foreman presents one status without pretending that
all platforms share the same native lifecycle.

Foreman owns its project model, coordination rules, and user-facing
projections. The Fabric API supplies identity, authorisation, content history,
durable messaging, synchronization, shared commits, connections, and
attributable records without exposing which infrastructure service implements
each operation.

The default Foreman navigation should reflect its work model:

```text
Today
Projects
Buildouts
Work items
Agents
Sessions
Approvals
Activity
```

Fabric state appears contextually—a disconnected device, a pending permission,
an unavailable browser session, or a storage recovery warning—rather than as a
separate control plane that displaces the work.

## Relationship to the visual-language prototypes

The existing Greenways OS V2 visual-language work is a useful interaction
prototype for Foreman. Its buffer model, split panes, Today view, contextual
browser companion, agent progress, approval cards, and activity stream map well
to Foreman.

The hierarchy and vocabulary need to change:

| Prototype concept | Foreman presentation |
| --- | --- |
| Greenways OS window | Foreman window |
| Greenways Desktop | Foreman |
| Workspace / release | Project / buildout |
| Publishing room | Current project |
| Studio and campaigns | Separate publication product or later apps |
| Workrooms | Buildouts |
| Providers | Connections or available sessions |
| Keyring | People and agents / Access |
| Receipts | Activity |
| `greenwaysd`, runtime, and protocol status | Connection status; detail in Diagnostics |
| Technical capability route | Plain-language permission explanation |

The current prototypes are located in the sibling visual-language project,
including `GreenwaysOsV2NativeDesktop.astro`,
`GreenwaysOsV2ExtensionDesktop.astro`, and the popup and side-panel surfaces.
They should inform Foreman rather than define a user-facing Greenways OS shell.

## Agent-to-agent communication

Agents do not exchange provider credentials or call one another through an
unrecorded side channel. Communication is mediated by the Fabric:

```text
Kimi CLI session
  -> Foreman request
  -> Fabric permission and availability check
  -> durable message recorded for the target
  -> ChatGPT browser session adapter
  -> bounded provider interaction
  -> structured result and artifacts recorded
  -> reply delivered to the Kimi session
```

Every live session advertises a bounded set of capabilities, such as:

- accept a prompt;
- answer a question;
- inspect a visible web application;
- run a local command;
- read project files;
- propose a patch; or
- request an external action.

A request names the target agent or session, expected result shape, deadline,
project and work-item context, and authority required. The Fabric assigns a
stable request ID so retries do not create duplicate work.

Messages have durable lifecycle states:

```text
queued -> accepted -> running -> completed
                  \-> rejected
                  \-> cancelled
                  \-> timed-out
```

Progress, results, artifacts, errors, cancellations, and approval requests are
causally linked to the originating message. A caller can observe status without
receiving the target session's private provider context.

The receiving session uses the intersection of:

1. the caller's permission;
2. the target agent profile's policy;
3. the receiving client's role;
4. the session adapter's advertised capabilities; and
5. any required human approval.

Calling a more powerful session never allows the caller to inherit all of that
session's authority.

## Provider and tool adapters

Foreman uses adapters for Codex, Kimi CLI, ChatGPT in a browser, GitHub, CI
systems, and future tools. Each adapter translates a platform's native events
into the common Foreman model while preserving the original identifiers and
URLs.

An adapter owns only its connection and platform translation. It cannot bypass
Fabric permissions or write fabricated completion evidence. Browser adapters
are constrained to reviewed browser actions and the user's existing signed-in
session. CLI adapters are constrained to enrolled processes and declared
working directories.

Provider-specific material remains visible in diagnostics and links, but it
does not determine the product hierarchy.

## GitHub and external effects

GitHub issues, branches, pull requests, reviews, and checks are external
records linked to a Foreman project and work item. Foreman preserves GitHub as
the authority for GitHub state and reads changed state back after mutations.

Creating an issue, commenting, pushing a branch, opening a pull request,
merging, or changing repository settings are distinct permissions. A general
request to investigate or write code does not implicitly authorise any of
those external actions.

Every authorised mutation records:

- the person or agent requesting it;
- the project, work item, run, and originating message;
- the exact action and bounded arguments;
- the approval or standing permission used;
- the external identifier and returned state; and
- verification performed after the action.

## History and projections

The durable history underneath Foreman records facts rather than mutable status
summaries. Foreman builds current views of projects, runs, sessions, approvals,
and buildouts from attributable events and external read-back.

The underlying history implementation is enabling infrastructure. Product
contracts refer to activity, messages, runs, artifacts, decisions, and
checkpoints rather than its technology name.

## Greenways Platform boundary

Foreman and the private Fabric do not publish public content directly across
many channels. A Fabric application may prepare an approved immutable release
and hand it to Greenways Platform. Greenways Platform owns public pages,
channel configuration, transformations, delivery, retries, reconciliation, and
unpublishing.

Private agent conversations, project history, source files, provider
credentials, and Fabric authority do not move to Greenways Platform merely
because a release is published.

## Architecture laws

1. A person's Fabric remains useful without Greenways Platform.
2. The Fabric Server is the only writable authority for its current generation.
3. Product contracts use ordinary Greenways terms, not enabling-technology
   names.
4. Foreman is the foreground application; the Fabric is an invisible grounding
   and delivery layer during ordinary use.
5. Cryptographic details are invisible during ordinary use but inspectable in
   diagnostics and recovery.
6. Human, agent, client, app, and provider identities are distinct.
7. A provider session never becomes a Fabric authority.
8. Agent-to-agent communication is durable, attributable, bounded, and gated.
9. Receiving agents do not lend their complete authority to callers.
10. External actions require their own permissions and verified read-back.
11. Apps depend on versioned Fabric contracts; the kernel remains minimal.
12. Foreman can stop or update without invalidating Fabric identity or history.
13. Private source and work history do not become public publication state.
14. Infrastructure implementations remain replaceable behind adapters.
15. Tahto owns portable semantics, authority, and synchronization; Hestia owns
    source-grounded knowledge, evidence, and retrieval; Hodos remains
    client-only; and Hoplite and Ignatius remain serving and shared-finality
    executors. Historia enters Hestia through an explicit compatibility
    migration rather than remaining a peer technology.

## First product proof

The first end-to-end proof is Foreman coordinating two different provider
surfaces:

1. A person installs Greenways OS; it verifies the Fabric components, installs
   Foreman, and opens directly into the Foreman experience.
2. Setup creates a person, names the device, and completes recovery without
   presenting cryptographic terminology or an OS administration dashboard.
3. The person installs Foreman and creates a project linked to a GitHub
   repository.
4. A Builder agent profile is allowed to read that project and request work
   from approved sessions.
5. A Kimi CLI session sends a bounded question to an available ChatGPT browser
   session through Foreman.
6. The ChatGPT session returns a result through the Fabric without revealing
   its browser credentials or unrelated conversation state.
7. Foreman records the request, progress, result, artifacts, and both session
   identities in one buildout view.
8. The agent proposes creating a GitHub issue; Foreman pauses for the required
   permission or approval.
9. After approval, GitHub returns a real issue identifier and Foreman reads it
   back before showing it as created.
10. Restarting the Fabric Server preserves the project, buildout, causal
    history, and unresolved work without repeating completed external effects.

This proof establishes the Fabric boundary, invisible identity, app model,
cross-provider agent messaging, authorisation, history, and verified external
effects before broader workspace or publication work.
