# Flow Project Control Room contract

Status: Agent 1 A4.1 contract for `greenways-ai/greenways-os#163`.

This contract turns the merged Flow project aggregate into one deterministic,
host-neutral read and management projection. It is the data boundary for later
Desktop, browser, CLI, MCP, and Visual Language Control Room surfaces. It does
not implement those hosts or permit them to invent another project model.

## Inputs

The projection consumes one validated `FlowProjectSnapshot` and one closed
selection:

```text
project
work/<id>
buildout/<id>
```

The selected work or buildout must already belong to the project. Unknown,
orphaned, duplicated, or cross-project identities fail before a projection is
created.

## Projection

`FlowProjectControlRoom` contains:

- the exact Flow application and revision;
- the project identity, revision, lifecycle state, and timestamps;
- source and evidence reference counts without transferring source authority;
- direct project work;
- optional buildout lanes and their exact member work;
- deterministic work-state totals;
- attention records derived from paused/review/blocked/failed states; and
- a closed list of truthful operations for the current selection.

Direct work never carries a buildout ID. Grouped work names exactly the
buildout lane that contains it. The projection never rewrites `project/*`,
`work/*`, or `buildout/*` durable identities.

## Current actions

The Control Room exposes only operations already present in the merged Flow
catalogue:

```text
flow.project.list
flow.project.get
flow.project.update
flow.project.transition
flow.work.get
flow.work.create
flow.work.update
flow.work.transition
flow.buildout.get
flow.buildout.create
flow.buildout.update
flow.buildout.transition
```

`flow.project.create` belongs to the project collection surface, not an open
Control Room. The list/create operations for work and buildouts remain
project-scoped. There is no delete action.

Every mutating action keeps the merged exact-request idempotency law. Existing
record mutations carry the expected revision of the record being changed:

```text
project update/transition       -> project revision
work create                     -> project revision
work update/transition          -> work revision
buildout create                 -> project revision
buildout update/transition      -> buildout revision
```

Terminal project, work, and buildout records retain their read actions but
publish mutations as disabled with an explicit terminal-state reason. The
projection does not silently reopen a terminal record.

## Attention law

Attention is derived rather than authored independently:

- paused project or blocked work/buildout: `action-required`;
- review project/work/buildout: `informational`;
- failed work/buildout: `critical`.

Changing an attention entry without changing its owning record causes contract
validation to fail. A running or completed record is not presented as blocked
merely to make the interface look active.

## Authority law

The Control Room is an application-owned projection, not an authority token.
Every action sets `grantsApplicationAuthority: false`. It contains no provider,
credential, database, filesystem, network, process, native, eval, storage, MCP,
or generic Fabric handle.

Source and evidence observations remain governed by their existing
`SharedReference` records and `authorityTransfer: false`. Counts in the Control
Room do not confer access to the source application or its storage.

Foreman remains the internal coordination engine and durable implementation.
It is not a Control Room application ID, route, launcher, or operation
namespace. Legacy `build` remains `incompatible-blocked`.

## Future targets

Imagine and World do not appear in the Control Room projection or action
catalogue. Requests for those application targets continue to use Gate 0's
`unactivated-application` result. This slice does not activate, advertise, or
register either product.

## Canonical evidence

- `crates/greenways-workspace-contracts/src/flow_control_room.rs`
- `crates/greenways-workspace-contracts/tests/flow_project_control_room.rs`
- `crates/greenways-workspace-contracts/tests/fixtures/flow/project-control-room-buildout.json`
- existing source fixture
  `crates/greenways-workspace-contracts/tests/fixtures/flow/project-buildout.json`

## Deferred A4 slices

This contract deliberately withholds actions that are not yet in the merged
Flow catalogue, including approval, resume, claim, dependency, handoff,
intervention, provider execution, GitHub mutation, and host-restart controls.
Those require separate records and operations before a host may render them as
available.

Later slices may add:

1. project membership and agent mandates;
2. work dependencies and claims;
3. host/session presence and restart reconciliation;
4. handoff and intervention operations; and
5. Desktop/CLI/browser/MCP adapters over this exact projection.

Each addition must extend the merged contract rather than replacing project,
work, buildout, reference, selection, attention, or revision-fence semantics.
