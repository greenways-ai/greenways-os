# Greenways Fabric technology map

## Status and decision

This document records the ownership decision in
[`greenways-ai/greenways-os#154`](https://github.com/greenways-ai/greenways-os/issues/154).
It replaces the earlier peer-layer model in which Historia owned content,
Hestia owned authority, and Hodos had a broader portable application role.

The migration is deliberately staged:

- [Tahto #107](https://github.com/greenways-ai/tahto/issues/107) moves Hestia's
  portable authority profiles and deterministic authorization kernel into
  Tahto;
- [Hestia #47](https://github.com/greenways-ai/hestia/issues/47) recasts Hestia
  as the application-neutral knowledge graph, evidence, and retrieval system;
- [Historia #102](https://github.com/greenways-ai/historia/issues/102) migrates
  Historia's maintained archives, graph contracts, analyzers, providers, and
  retrieval compatibility into Hestia; and
- [Hodos #110](https://github.com/greenways-ai/hodos/issues/110) makes Hodos a
  client-only Hara package catalogue and browser materializer.

These issues define the target ownership now. Existing packages remain
compatibility and migration evidence until their individual parity gates pass;
this decision does not silently reinterpret completed acceptance or claim that
the migrations have already landed.

## Purpose

Greenways OS presents Flow, people, agents, projects, devices, connections,
permissions, approvals, storage, and activity. This document maps those product
concepts onto portable definitions, client packages, effectful executors, and
the Greenways product composition.

Technology names belong in architecture, dependency, diagnostics, migration,
and conformance material. They do not become Flow navigation, setup
terminology, or ordinary user-facing records. Foreman remains the internal
coordination engine behind Flow.

Flow does not import these implementations directly. The dependency
direction is:

```text
Flow frontend
  -> Foreman coordination service
    -> Greenways Fabric API
      -> Greenways OS product composition
        -> selected portable kernels, client packages and executors
```

## Package-kind and ownership matrix

| Technology | Kind | Permanent responsibility | Explicit non-responsibility |
| --- | --- | --- | --- |
| Tahto | Semantic standards and portable deterministic kernels | Values, stable identities, typed links, exact roots, revisions, heads, divergence, authority profiles, grants, mandates, approvals, revocation, pure authorization evaluation, closure, and synchronization | Private-key custody, provider credentials, ambient enforcement, work scheduling, graph search, HTTP serving, or product UI |
| Hestia | Knowledge-graph standards, Hara packages, and replaceable providers | Immutable sources and anchors, graph construction, assertions, evidence, candidates, lineage, traversal, retrieval, search, rebuildable indexes, and code/conversation/work/document profiles | Canonical Tahto application state, authority, pairing, synchronization, credential custody, work scheduling, serving, or shared finality |
| Historia | Migration source and compatibility surface | Preserving existing archives, identities, branches, provenance, analyzers, providers, consumers, and rollback paths while maintained knowledge capabilities move into Hestia | A permanent peer service or a second knowledge authority after migration |
| Hodos | Client-only Hara package catalogue and browser materializer | Inert descriptors, package coordinates and digests, deterministic client-side resolution, reviewed capability plans, browser component lifecycle, visible projections, and semantic events | Server process, daemon, database, privileged installer, native provider, credential store, authority, synchronization, or scheduling |
| Hoplite | Effectful serving executor | Production HTTP routing, request boundaries, streaming, workers, and prepared Hara application hosting | Product identity, application policy, semantic or knowledge ownership, authority, databases, or the complete Fabric Server |
| Ignatius | Effectful shared-finality executor | Ordered accepted shared transitions, exact roots, compare-and-set heads, immutable blocks, scoped refs, and receipts | Ordinary local work, bulk content, graph retrieval, authorization policy, transport, or product UI |
| Hara | Package and portable-kernel substrate | Portable programs, validators, reducers, package contracts, and runtime execution | Product vocabulary, host resource ownership, provider selection, or ambient authority |
| Greenways OS, Flow, and Foreman | Product composition and coordination service | Local key and credential custody, provider selection, consent, process lifecycle, installation trust, Fabric API composition, work coordination, and user experience | Re-exporting infrastructure internals as product concepts |

The architecture is not a linear request path through every technology. Tahto
and Hestia define reusable semantic and knowledge contracts. Hodos consumes
Hara packages entirely in the client. Hoplite and Ignatius are invoked only
when their effects are needed. Greenways OS selects providers, holds local
authority, and composes the installed product.

## Target model

```text
DEFINITIONS AND PORTABLE KERNELS

Tahto semantic fabric                 Hestia knowledge graph
values · links · roots · authority    sources · assertions · evidence
revisions · divergence · sync         graph construction · retrieval
             |                                      |
             +------------------+-------------------+
                                |
                    Hara packages and kernel
                                |
CLIENT                          |
Hodos catalogue + browser materializer
                                |
EXECUTORS                       |
Hoplite serving        Ignatius shared finality
                                |
PRODUCT                         v
                    Greenways OS + Flow
                    Foreman coordination engine behind Flow
```

The diagram classifies responsibilities; it does not require every operation
to traverse the diagram from top to bottom.

## Product-to-technology decisions

The boundary can be tested with ordinary questions:

| Question | Product owner | Internal implementation |
| --- | --- | --- |
| May this device or local client connect? | Greenways OS | Local enrolment, native key custody, and enforcement |
| May this installed app use a local capability? | Greenways OS | Local app approval and current capability decision |
| Who is this person or agent across projects and devices? | Greenways identity service | Tahto authority profiles combined with native key possession |
| May this agent perform this consequential project action? | Greenways Access | Tahto authority closure and deterministic decision; Greenways OS enforces the effect |
| What is the canonical project, run, message, artifact, or relationship value? | Flow | Foreman-owned schemas surfaced through Flow and expressed through Tahto values, links, roots, revisions, and sync |
| What sources, claims, evidence, lineage, and retrieval structures can be constructed? | Flow knowledge and search | Hestia knowledge profiles and providers, with exact anchors to sources and Tahto roots where applicable |
| Which shared transition was accepted and in what order? | Greenways collaboration service | Ignatius signed transaction and canonical receipt |
| How is a remote service exposed over HTTP? | Greenways Server | Hoplite routes, workers, request boundaries, streaming, and hosting |
| How is a visible client component found and instantiated? | Flow client | Hodos resolves an inert catalogue entry and materializes an approved Hara package in the browser |

## Semantic and knowledge boundary

Tahto and Hestia have different forms of truth:

```text
Authoritative source material
  files · conversations · GitHub records · documents · Tahto roots
                    |
                    v
Hestia knowledge graph
  exact anchors · derived facts · assertions · evidence · candidates · indexes
                    |
                    +---- references exact Tahto values and roots when relevant

Tahto semantic fabric
  canonical application values · identities · links · roots · revisions
  authority profiles · decisions · divergence · closure · synchronization
```

Tahto links express canonical application semantics. Hestia links express
source facts, derived relationships, accepted assertions, candidates, or
rebuildable projections with explicit evidence classes. Hestia does not
validate canonical Tahto application state or become its synchronization
engine. A Tahto adapter may store or synchronize selected Hestia records, but
it does not define Hestia graph meaning.

Historia's Git-native archives, conversation branches, source records,
analyzers, provenance, and rebuildable retrieval projections are maintained
migration inputs to Hestia. The transition must preserve source bytes, stable
identities, incomplete-source classifications, and active consumer entry
points. Until compatibility is proved, Historia remains an explicit legacy
coordinate; it does not remain a permanent architectural plane.

Physical disks, Git object stores, databases, and object stores retain bytes.
Neither Tahto nor Hestia becomes synonymous with physical storage merely
because its records reference those bytes.

## Authority and enforcement boundary

The user experiences one Greenways identity and access system. Internally, the
portable decision and the local effect are separated:

```text
Greenways OS
  private keys · credentials · enrolled clients · local app approval
        |
        | resolves exact semantic inputs
        v
Tahto authority kernel
  principals · delegation · mandates · grants · approvals · revocation
        |
        | permit · deny · require-approval + bounded evidence
        v
Greenways OS
  checks current local state and enforces or refuses the requested effect
```

The Tahto kernel is deterministic and effect-free. It cannot access a keychain,
database, network, clock, mutable URL, provider registry, or ambient process
state. Greenways OS retains private material, consent, local policy, and effect
enforcement. Moving authority semantics from Hestia to Tahto therefore does
not move operating-system custody into Tahto.

During migration, old Hestia authority packages are explicitly identified as
legacy compatibility surfaces. The unqualified Hestia name denotes knowledge
graphs only after those authority consumers have moved and the compatibility
window has been closed deliberately.

## Hodos client boundary

A Hodos catalogue entry is inert data. It may name an exact Hara package,
component export, revision or digest, compatible profile, and requested browser
capabilities. It cannot contain native paths, credentials, provider selectors,
mutable installer commands, or executable callbacks.

```text
catalogue descriptor
  -> deterministic package and capability plan
  -> Greenways OS or user approval
  -> already trusted package bytes
  -> browser Hara runtime
  -> mount · update · semantic events · dispose
```

All resolution and materialization occurs in the client. Hoplite or another
ordinary origin may serve package bytes and APIs, but it is not part of Hodos.
Greenways OS may inject a bounded Fabric client after approval; that does not
move Fabric authority, credentials, storage, or scheduling into Hodos.

## Executor boundaries

Hoplite is the production HTTP runtime, not the whole Greenways Fabric Server.
The Fabric Server is a Greenways OS product composition that includes local
service lifecycle, operating-system integration, storage providers, local IPC,
Fabric services, and application hosting. Hoplite supplies the network-facing
Hara/Nginx serving executor where HTTP and streaming are appropriate.

Ignatius supplies shared finality only when independently controlled
participants require one accepted ordering, compare-and-set head, workflow
checkpoint, or durable shared decision. It records small canonical state and
exact roots; it does not store ordinary files, provider transcripts, model
context, browser captures, Git repositories, or media payloads. Purely personal
work does not require an Ignatius transaction.

Hoplite and Ignatius remain independently understandable executors. Neither
defines Tahto semantics, Hestia knowledge, Hodos clients, or Flow product
behavior.

## Operation composition

A consequential Flow operation may compose only the capabilities it needs:

1. Flow submits a bounded Fabric operation against a project and work item.
2. Greenways OS authenticates the enrolled client and installed Flow app.
3. For a consequential action, Greenways OS resolves an exact Tahto authority
   closure and consumes the deterministic decision before enforcing the effect.
4. If source-grounded knowledge or retrieval is required, a Hestia package or
   provider constructs it with exact source anchors and authority classes.
5. If the interaction needs a catalogue component, Hodos resolves and
   materializes it inside the browser after capability review.
6. If a remote HTTP boundary is required, Hoplite executes that serving role.
7. If shared finality is required, Ignatius commits the accepted exact roots and
   returns a receipt.
8. Flow receives an ordinary result and attributable activity update.

An operation may use none, one, or several of these components. In particular,
Hestia is not in the authorization path, Hodos is not a server path, and
Ignatius is not in ordinary local or token-by-token message traffic.

## Agent-to-agent communication

For a Kimi CLI session calling a ChatGPT browser session, Flow sees one
application-level exchange:

```text
message.send
  target: ChatGPT browser session
  context: current project and work item
  expected result: answer with referenced artifacts
```

The Fabric may compose that exchange using:

```text
Flow application contract                      Flow
Foreman project and coordination schema        Foreman
canonical message, run and authority values    Tahto
source-grounded history and retrieval           Hestia, when required
visible browser component lifecycle             Hodos, when used
active browser endpoint and effect enforcement  Greenways OS client
HTTP service boundary                           Hoplite, when remote
accepted shared milestone                       Ignatius, only when required
```

The browser client invokes only reviewed provider commands. Tahto makes the
canonical message and exact authority closure available where required. Hestia
may construct attributable knowledge from exact source material, but it does
not authorize the exchange. Ignatius records only a shared milestone that
actually requires finality.

## Migration gates and open seams

The target architecture is settled by Greenways OS #154; implementation remains
an explicit migration train. Before old ownership can be retired, the projects
must prove:

1. a complete Hestia-authority-to-Tahto package/version ledger and decision,
   synchronization, restart, and revocation parity;
2. a complete Historia-to-Hestia package/version and consumer ledger, with
   source, identity, archive-open, graph, analyzer, retrieval, and rollback
   parity;
3. an unambiguous Hestia compatibility window in which legacy authority and new
   knowledge packages cannot be confused;
4. a client-only Hodos package graph with browser materialization, capability
   denial, offline pinned-package, and deterministic disposal evidence;
5. the exact Foreman durable schemas surfaced through Flow over Tahto and the
   Hestia profiles that construct knowledge over Flow, GitHub, conversation, code, and document
   sources;
6. the threshold and exact-root handoff for optional Ignatius finality;
7. the local IPC versus Hoplite HTTP boundary of the cross-platform Fabric
   Server; and
8. a real-process recovery proof across local custody, Tahto state and
   authority, Hestia knowledge projections, optional shared finality, and
   Foreman projections surfaced through Flow.

Do not remove legacy packages, rewrite archives, or repoint consumers merely
because this target map is documented. Protocol ownership and compatibility
ledgers move first; repository history, providers, and retirements follow in
separately reviewable changes with read-back evidence.
