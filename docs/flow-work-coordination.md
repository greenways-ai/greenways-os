# Flow work dependency, assignment, and claim contract

Status: current Agent 1 A4.2 contract for #163, #146, and #161.

This contract extends the merged Flow project and participation contracts with project-owned work coordination. It records dependency, assignment, and claim evidence without copying Hara Work execution state or introducing host/session authority.

## Product boundary

Greenways Flow remains the only current product-facing coordination application. Foreman remains Flow's internal coordination engine and durable domain implementation; it is not an application target, provider, claimant, or second work authority.

Legacy Build remains `incompatible-blocked`. Imagine and World remain unactivated and absent from current operation discovery.

A Flow work record is not a Hara Work run. A project assignment is not acceptance. A claim is not a session, process, provider grant, or proof of progress.

## Coordination snapshot

`FlowWorkCoordinationSnapshot` uses protocol `greenways.flow.work-coordination/0-alpha` and contains:

- exact current Flow application and revision;
- project identity and observed project revision;
- bounded `FlowWorkReference` records from the merged project contract;
- bounded dependency records;
- bounded assignment records; and
- bounded fenced claim records.

Every nested record must belong to the same project and exact application revision. Work, dependency, assignment, and claim identities are unique. Unknown fields fail closed.

## Dependency records

`FlowWorkDependency` uses protocol `greenways.flow.work-dependency/0-alpha`.

Dependency kinds are:

```text
blocks
requires-context
requires-artifact
```

States are:

```text
proposed -> active | satisfied | waived | cancelled
active   -> satisfied | waived | cancelled
```

Current dependency edges are acyclic. A work item cannot depend on itself, an unknown work item, or the same edge twice. Terminal work cannot retain a proposed or active dependency.

Satisfied, waived, and cancelled dependencies require resolution evidence. Dependency records never transfer authority.

## Assignment records

`FlowWorkAssignment` uses protocol `greenways.flow.work-assignment/0-alpha`.

States are:

```text
proposed -> assigned | declined | revoked | expired
assigned -> accepted | declined | revoked | expired
accepted -> released | revoked | expired
```

Assignment and acceptance are separate facts. Current work may have at most one current assignment. Terminal work cannot retain one.

Current assignments validate against the project participation snapshot:

- the assignee is an exact project membership;
- a proposed assignment may target an invited or active member;
- an assigned or accepted assignment requires an active member;
- the assignment actor is an active human owner or coordinator; and
- no assignment transfers application authority.

Released, revoked, declined, and expired assignments remain attributable durable records.

## Claim and lease records

`FlowWorkClaim` uses protocol `greenways.flow.work-claim/0-alpha`.

States are:

```text
proposed -> active | expired | revoked
active   -> released | expired | revoked | stale
```

Every claim has:

- a unique claim ID;
- exact work and claimant membership IDs;
- an optional exact agent mandate ID;
- a positive lease generation unique for the work item;
- proposal, activation, observation, expiry, release, revocation, and stale evidence as applicable;
- explicit contention state;
- `authorityTransfer: false`; and
- `copiesWorkRuntimeState: false`.

One membership cannot hold two active claims on the same work item. Multiple different active claimants are permitted only when every overlapping active claim is marked `contended`. A single active claim must be marked `none`. This preserves observed contention rather than silently choosing a winner or rejecting evidence.

Terminal work cannot retain a proposed or active claim.

## Participation and mandate law

Claims validate against `FlowProjectParticipationSnapshot`.

A current person claim requires active person membership and no agent mandate reference.

A current agent claim requires:

- active agent membership;
- an exact active mandate for that membership and agent identity; and
- the additive closed `work-claim` mandate capability.

Historical terminal claims may remain after membership or mandate revocation, preserving attribution. They do not reactivate authority.

The `work-claim` capability permits only creation and maintenance of the Flow claim record through the closed operation catalogue. It does not provide a host, session, provider, credential, browser, process, sandbox, filesystem, native, GitHub, or Hara Work runtime handle.

## Truthfulness laws

```text
work assigned       != assignment accepted
assignment accepted != work claimed
work claimed        != progress observed
claim active        != session active
claim released      != work completed
run completed       != selected outcome
output reported     != artifact verified
claim reconciled    != Work runtime state copied
```

Later Control Room projections must display these facts independently.

## Closed operation extension

The catalogue `greenways.flow.work-coordination-operation-catalogue/0-alpha` contains exactly:

```text
flow.work.dependencies.list
flow.work.dependency.add
flow.work.dependency.update
flow.work.assignments.list
flow.work.assign
flow.work.assignment.decide
flow.work.assignment.release
flow.work.claims.list
flow.work.claim
flow.work.claim.release
flow.work.claim.reconcile
```

Read operations require project and work IDs. Mutations require the expected project revision and exact-request idempotency. Add/claim operations do not require an existing entity ID; update, decide, release, and reconcile operations do.

Every operation descriptor sets:

```text
grantsApplicationAuthority: false
deletesDurableHistory: false
copiesWorkRuntimeState: false
```

Reconciliation may mark claims expired, revoked, stale, released, or contended using observed evidence. It cannot mutate a Hara Work checkpoint, session, provider attempt, or external effect.

## Canonical fixtures

- `crates/greenways-workspace-contracts/tests/fixtures/flow/work-coordination.json` demonstrates one accepted assignment and one uncontended active agent claim after a satisfied dependency.
- `crates/greenways-workspace-contracts/tests/fixtures/flow/work-claim-contention.json` demonstrates two truthfully contended active claims by different project memberships.
- `crates/greenways-workspace-contracts/tests/fixtures/flow/work-coordination-operation-catalogue.json` freezes the exact eleven-operation extension.
- `crates/greenways-workspace-contracts/tests/flow_work_coordination.rs` covers graph cycles, duplicate edges, lifecycle evidence, assignments, fences, contention, participation/mandate authority, runtime-copy negatives, unknown applications, and catalogue drift.

## Deferred slices

Subsequent A4 pull requests own:

1. host/session presence and restart reconciliation;
2. handoff and intervention records;
3. activity, evidence, artifact, and external read-back projections; and
4. closed Desktop, CLI, browser, and MCP Project Control Room view models.

This contract introduces no generic database, filesystem, provider, browser, process, shell, sandbox, native, credential, GitHub, or application-authority handle.
