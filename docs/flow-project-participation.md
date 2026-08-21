# Flow project participation contract

Status: current Agent 1 A4.1 contract for #163, #146, and #161.

This contract defines the project membership and bounded agent-mandate boundary. Later merged contracts add host/session presence, work claims, and the two request-only handoff/intervention capabilities without widening identity, provider, host, credential, or application authority.

## Product boundary

Greenways Flow remains the only current product-facing coordination application. Foreman remains its internal coordination engine and durable domain implementation; it is not an application target or a second participation authority.

A project participant is not a provider account, host, session, credential, sandbox, Hara Work run, or external record. The participation contract stores exact references and lifecycle evidence only.

Legacy Build remains `incompatible-blocked`. Imagine and World remain unactivated and absent from current participation discovery.

## Participation snapshot

`FlowProjectParticipationSnapshot` is a project-owned current projection containing:

- the exact Flow application and revision;
- project identity and observed project revision;
- bounded project memberships; and
- bounded agent mandates.

The snapshot requires at least one active human owner. An agent cannot hold the owner role. This prevents a current project projection from silently becoming autonomous or ownerless while retaining historical revoked and expired records.

Each person or agent principal may appear only once in one participation snapshot. Membership and mandate IDs are separately unique. Every current mandate resolves to exactly one agent membership in the same project.

## Membership record

`FlowProjectMember` uses protocol `greenways.flow.project-member/0-alpha` and records:

- project and membership identity;
- a person or agent principal reference and exact identity revision;
- role: `owner`, `coordinator`, `contributor`, or `observer`;
- state: `invited`, `active`, `suspended`, `revoked`, or `expired`;
- invitation, activation, expiry, and revocation evidence; and
- `authorityTransfer: false`.

Member removal means a transition to `revoked` or `expired`. It never deletes attributable history. Revoked and expired memberships do not silently reactivate; re-entry requires a separately reviewed new membership identity or an explicit future compatibility law.

## Agent mandate

`FlowAgentMandate` uses protocol `greenways.flow.agent-mandate/0-alpha`. A mandate belongs to one agent membership and grants only a closed subset of current Flow coordination capabilities:

```text
project-read
work-read
work-create
work-update
work-transition
work-claim
handoff-request
intervention-raise
buildout-read
buildout-create
buildout-update
buildout-transition
```

The current mandate cannot manage project membership or mandates, attach hosts, choose providers, access credentials, invoke native/process/browser operations, transfer application authority, or obtain an unrestricted operation string.

Mandate states are `proposed`, `active`, `suspended`, `revoked`, and `expired`. One agent membership may have at most one current mandate. Revoked or expired membership cannot retain a proposed, active, or suspended mandate.

## Lifecycle laws

Membership transitions:

```text
invited   -> active | revoked | expired
active    -> suspended | revoked | expired
suspended -> active | revoked | expired
```

Mandate transitions:

```text
proposed  -> active | revoked | expired
active    -> suspended | revoked | expired
suspended -> active | revoked | expired
```

Terminal states do not reopen through the current contract. State claims require matching activation, expiry, or revocation timestamps.

## Closed operation extension

The participation catalogue is `greenways.flow.participation-operation-catalogue/0-alpha` and contains exactly:

```text
flow.project.members.list
flow.project.member.add
flow.project.member.update
flow.project.member.remove
flow.project.agents.list
flow.project.agent.add
flow.project.agent.update
flow.project.agent.revoke
```

Read operations require a project ID. Mutations require the expected project revision and exact-request idempotency. Add operations do not require an existing entity ID; update, remove, and revoke operations do.

Every operation descriptor sets:

```text
grantsApplicationAuthority: false
deletesDurableHistory: false
```

`member.remove` and `agent.revoke` are lifecycle operations, not destructive deletion.

## Truthfulness laws

```text
person or agent referenced != identity authority transferred
agent in project           != mandate active
mandate active             != session active
mandate capability         != host/provider capability available
member removed             != historical activity erased
agent revoked              != prior work/evidence unattributed
```

Later host and Control Room projections must show these dimensions separately.

## Canonical fixtures

- `crates/greenways-workspace-contracts/tests/fixtures/flow/project-participation.json` contains one active human owner and one active agent contributor with a bounded mandate.
- `crates/greenways-workspace-contracts/tests/fixtures/flow/participation-operation-catalogue.json` freezes the exact eight-operation extension.
- `crates/greenways-workspace-contracts/tests/flow_project_participation.rs` covers ownership, identity separation, cross-project rejection, duplicate principals, orphaned and duplicate current mandates, lifecycle evidence, authority transfer, unknown fields/capabilities, legacy/future application IDs, and operation drift.

## Downstream extensions

Merged A4 contracts now consume this boundary for work dependencies and claims, host/session presence, and project handoff/intervention requests. `handoff-request` and `intervention-raise` allow an active agent to propose bounded coordination records only; they do not allow the agent to approve interventions, manage membership or mandates, attach hosts, invoke providers, select credentials, repeat effects, or transfer authority.

Activity/evidence, external read-back, and closed Desktop, CLI, browser, and MCP Project Control Room view models remain later independent slices.

This contract introduces no generic database, filesystem, provider, browser, process, shell, native, credential, or application-authority handle.

## Validation proof

The self-cleaning publisher completed in Actions run `32456297673`, job `96694143637`. It:

- applied pinned Rust `1.85.1` formatting;
- removed its temporary workflow before closing evidence;
- regenerated the Flow/Build/Foreman findings from the final working tree;
- passed every `greenways-workspace-contracts` target;
- passed all-target Clippy with warnings denied;
- validated both canonical JSON fixtures and the compatibility inventory;
- passed the permanent compatibility scanner and whitespace checks;
- enforced the exact seven-file review allowlist; and
- published self-cleaned head `c05c4e7800116e00abf4506c574bd8390c63cc26`.
