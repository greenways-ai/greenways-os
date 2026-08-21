# Flow project host and session presence contract

Status: current Agent 1 A4.3 contract for #163 and #161.

This contract consumes the merged Flow project, participation, dependency, assignment, and work-claim records. It adds project-scoped host attachment, session presence, activity observation, and restart reconciliation evidence. It does not add execution leases, provider requests, sandboxes, handoffs, interventions, or host-specific view models.

## Governing truthfulness laws

```text
host enrolled        != host attached to project
host attached        != host observed online
host online          != session attached
session attached     != session connected
session connected    != work claimed
work claimed         != session active
activity observed    != work completed
session disconnected != work completed
restart reconciled   != provider work repeated
```

The project remains the aggregate root. Flow remains the only current product-facing coordination application. The legacy Build application remains incompatible, Foreman remains an internal implementation identity, and Imagine and World remain unactivated.

## Project host attachment

`FlowProjectHostAttachment` records one bounded project relationship to a separately enrolled host.

A host attachment contains:

- exact Flow application and project identity;
- a stable attachment ID;
- stable host identity and positive host generation;
- one closed host kind: Desktop, CLI, browser, API, or MCP;
- attachment lifecycle state;
- independently observed host state and observation generation;
- exact capability revision and optional SHA-256 root;
- a small closed project capability set;
- the active human owner/coordinator who attached it;
- attachment, observation, expiry, detach, and revocation evidence; and
- explicit negative authority flags.

Current attachment states are `attached` and `stale`. Terminal states are `detached`, `revoked`, and `expired`.

Observed host states are:

```text
unknown
offline
connecting
ready
degraded
draining
stale
revoked
```

Attachment never means online. A ready or degraded observation is required before a session may be presented as connected.

The current capability set is intentionally low-authority:

```text
project-read
work-read
claim-read
session-attach
session-observe
session-disconnect
session-reconcile
```

No capability grants an execution lease, provider credential, host-wide workload view, generic filesystem root, shell, process, network, database, eval, or native handle.

## Session binding and activity

`FlowProjectSessionBinding` records one project-scoped binding for one session generation.

It carries:

- exact project and Flow identity;
- stable session ID and positive generation;
- exact host attachment;
- exact project membership;
- an exact agent mandate only for agent memberships;
- optional work and work-claim IDs;
- independent presence and activity states;
- attachment, observation, disconnection, staleness, closure, and revocation evidence; and
- closed negative authority and privacy flags.

Presence states are:

```text
unknown
attached
connected
disconnected
stale
closed
revoked
```

Activity states are:

```text
unknown
idle
generating
waiting-for-user
response-ready
error
```

Only a connected session may expose a current activity state. Missing or stale observation cannot leave a session falsely shown as generating or response-ready.

A person session cannot carry an agent mandate. A current agent session requires exact active membership and an exact active mandate matching the same agent. Optional claim binding must match the exact work, claimant membership, and mandate already present in the merged work-coordination snapshot.

A session may exist without a work claim. A durable work claim may exist without any observed session. Neither dimension implies the other.

Provider conversation URLs, cookies, credentials, private provider references, token streams, native handles, and unrelated project context are not schema fields. Unknown fields fail closed.

## Restart reconciliation

`FlowPresenceReconciliation` records an evidence-only generation transition.

States are:

```text
current
stale
divergent
resync-required
```

Reconciliation records:

- stable reconciliation ID;
- positive generation and optional earlier generation;
- start and completion times; and
- explicit false values for provider-work replay, external-effect replay, work-outcome mutation, and authority transfer.

A restart may produce `unknown`, `stale`, `divergent`, or `resync-required` evidence. It cannot:

- start or repeat provider work;
- complete, cancel, select, or verify work;
- transfer a claim;
- issue an execution lease;
- replay an external effect; or
- grant application or host authority.

The canonical restart fixture keeps the work item running while the host/session observations become unknown or stale.

## Current operation catalogue

```text
flow.project.hosts.list
flow.project.host.attach
flow.project.host.observe
flow.project.host.detach

flow.project.sessions.list
flow.project.session.attach
flow.project.session.observe
flow.project.session.disconnect
flow.project.session.reconcile
```

Read operations do not require idempotency. Every mutating or observational operation requires the expected project revision and exact-request idempotency.

Every operation explicitly sets these outcomes to false:

```text
grantsApplicationAuthority
grantsExecutionLease
carriesProviderCredentials
repeatsProviderWork
mutatesWorkOutcome
```

## Canonical fixtures

- `project-presence.json` — two attached hosts; a connected human session without a claim; a connected agent session bound to one exact active claim.
- `project-presence-restart.json` — the same durable identities after restart with unknown and stale observations and `resync-required` state.
- `presence-operation-catalogue.json` — the exact nine-operation inventory.

The fixtures validate against:

- `project-participation.json`;
- `work-coordination.json`; and
- the current Flow application revision `0.1.0`.

## Deferred work

This slice does not add:

- execution host enrolment or capability negotiation;
- sandbox specifications, leases, instances, runs, logs, checkpoints, artifacts, or cleanup;
- provider prompts, responses, credentials, browser cookies, conversation references, or token streams;
- cross-session requests or handoffs;
- interventions or project-wide attention;
- GitHub issue, branch, pull request, review, check, or external-delivery state;
- selected-output or evidence reconciliation;
- Desktop, CLI, browser, API, or MCP view models;
- Visual Language routes; or
- Imagine or World activation.

Those remain separate A4 and host/provider slices. Later consumers must preserve the exact project, membership, mandate, work, claim, host, and session identities defined here rather than collapsing them into one connected/running/done flag.
