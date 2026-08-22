# Flow project handoffs and interventions

Status: current Agent 1 A4.4 contract for `greenways-ai/greenways-os#161` and `#163`.

This contract follows the merged Flow project, participation, work-coordination, and host/session-presence contracts. It defines durable handoff requests, human interventions, and restart reconciliation without implementing transport, provider execution, external effects, or the Project Control Room host view.

## Truthful coordination boundary

The model permanently keeps these states separate:

```text
request prepared       != approval granted
approval granted       != transfer started
transfer started       != context received
context received       != handoff completed
session activity       != work progress
work claimed           != selected outcome
intervention resolved  != external effect verified
restart reconciled     != transfer or provider effect repeated
```

A handoff is project-owned coordination evidence. It is not a provider invocation, a copy of Hara Work runtime state, a membership grant, an application grant, or proof of an external effect.

An intervention is attributable human-attention evidence. Acknowledgement, decision, resolution, selected outcome, and verified read-back remain independent records.

## Handoff targets

The current target inventory is closed:

| Target | Required current evidence |
| --- | --- |
| Project membership | Exact active member in the current participation snapshot |
| Agent mandate | Exact active mandate and active member |
| Host attachment | Exact project attachment; ready-or-later requests require an attached ready/degraded host |
| Session | Exact non-terminal binding; ready-or-later requests require a connected session |
| Current application | Activated Spaces only, using the existing `greenways.handoff/0-alpha` envelope |

A Flow application handoff must use the same idempotency key, request digest, source project, target revision, and lifecycle in both the project record and shared handoff envelope. Current application targets cannot name Build, Foreman, Imagine, World, or an unknown string.

Foreman remains Flow's internal coordination engine and durable domain implementation. It is not a handoff application target. Build remains incompatible. Imagine and World remain unactivated.

## Handoff actor and context

Every request names one exact project membership. Agent requests additionally require:

- the same agent membership;
- the same active agent mandate;
- `handoff-request` capability; and
- a connected session when a session is supplied.

A person request cannot claim an agent mandate. A supplied claim must match the exact work, membership, mandate, and current claim state. A supplied session must match the exact membership and mandate.

Included context uses bounded `SharedReference` observations. References retain source ownership and `authorityTransfer: false`. Every handoff explicitly excludes:

```text
application authority
project membership
agent mandate
provider credentials
host-wide authority
Hara Work runtime state
external-effect authority
```

## Handoff lifecycle

```text
prepared
  -> approval-required | ready | cancelled | expired
approval-required
  -> ready | rejected | cancelled | expired
ready
  -> accepted | rejected | cancelled | expired
accepted
  -> transferring | cancelled | failed | stale
transferring
  -> received | partial | cancelled | failed | stale
received
  -> completed | partial | failed | stale
stale
  -> ready | accepted | transferring | received | cancelled | failed | expired
```

Each lifecycle claim requires matching timestamps and terminal evidence. Approval-required requests cannot advance without approval evidence. Completed and partial requests require acceptance, transfer, receipt, completion, and observation evidence. Rejected, cancelled, failed, and expired requests carry their exact terminal code. Stale requests carry an exact stale reason and observation boundary.

The common cross-application lifecycle maps exactly:

| Flow project state | Shared handoff state |
| --- | --- |
| `prepared` | `prepared` |
| `approval-required` | `approval-required` |
| `ready` | `ready` |
| `accepted` | `accepted` |
| `transferring` | `importing` or `creating` |
| `completed` | `completed` |
| `partial` | `partial` |
| `rejected` | `rejected` |
| `cancelled` | `cancelled` |
| `failed` | `failed` |

Project-local `received` and `stale` evidence do not masquerade as application completion.

## Replay law

A handoff idempotency key is bound to one immutable request:

- project;
- source actor;
- target;
- optional work and claim;
- included references;
- context digest;
- excluded authority;
- approval policy; and
- shared application request, when present.

An exact replay returns `exact-replay`. A different key is new. Changed immutable content under the same key fails as `flow-handoff-idempotency-collision`. Lifecycle observations may advance without redefining the original request.

## Interventions

Current intervention kinds are:

```text
blocker
question
approval
uncertain-effect
stale-claim
handoff-review
divergence
```

Current subjects are project, work, claim, handoff, session, host attachment, or an externally identified effect. Approval and handoff-review interventions require an exact handoff subject. Uncertain-effect interventions require an `effect/...` subject and do not claim verification.

Agents may raise interventions only with an active matching mandate containing `intervention-raise`. Acknowledgement, decision, and resolution require an active human project owner or coordinator.

The lifecycle is:

```text
open
  -> acknowledged | decision-required | resolved | dismissed | expired
acknowledged
  -> decision-required | resolved | dismissed | expired
decision-required
  -> approved | rejected | dismissed | expired
approved | rejected
  -> resolved
```

Acknowledgement is not a decision. Approval/rejection is not resolution. Resolution requires an exact Flow-owned project reference plus the resolving human identity and time. Approval, handoff-review, uncertain-effect, and divergence interventions require a human decision before resolution.

## Reconciliation

`FlowHandoffReconciliation` records one monotonic snapshot generation and one of:

```text
current
stale
divergent
resync-required
```

Reconciliation may update observation evidence only. It cannot:

- repeat a transfer;
- repeat provider work;
- repeat an external effect;
- rewrite a terminal handoff state; or
- transfer authority.

A stale reconciliation requires an exact stale handoff. A current reconciliation cannot contain stale handoff evidence.

## Current operations

```text
flow.project.handoffs.list
flow.project.handoff.request
flow.project.handoff.decide
flow.project.handoff.observe
flow.project.handoff.cancel
flow.project.handoff.reconcile

flow.project.interventions.list
flow.project.intervention.raise
flow.project.intervention.acknowledge
flow.project.intervention.decide
flow.project.intervention.resolve
```

Every non-read operation requires the expected project revision and exact-request idempotency. No operation deletes durable history, grants application authority, repeats a transfer, or repeats an external effect.

## Canonical evidence

- `crates/greenways-workspace-contracts/src/flow_handoff_intervention.rs`
- `crates/greenways-workspace-contracts/tests/flow_handoff_intervention.rs`
- `crates/greenways-workspace-contracts/tests/fixtures/flow/project-handoffs-interventions.json`
- `crates/greenways-workspace-contracts/tests/fixtures/flow/project-handoff-intervention-restart.json`
- `crates/greenways-workspace-contracts/tests/fixtures/flow/handoff-intervention-operation-catalogue.json`

The active fixture contains one project-local session handoff, one approval-gated Flow-to-Spaces handoff, one exact human approval intervention, and one agent-raised blocker. The restart fixture preserves a stale in-flight handoff without repeating transfer or effect.

## Deferred work

This slice deliberately does not add:

- transport delivery or message queues;
- provider selection, invocation, credentials, or private provider references;
- selected outcome, artifact verification, or external-effect read-back records;
- project activity/evidence history;
- the cross-host Project Control Room view model;
- Desktop, CLI, browser, MCP, Fabric API, Platform, or Visual Language registration;
- a Build alias or Foreman application; or
- Imagine or World activation.

The next independent slice may add activity and evidence projections, followed by the closed cross-host Project Control Room view model. Both must consume—not redefine—the handoff, intervention, work, participation, and presence contracts.
