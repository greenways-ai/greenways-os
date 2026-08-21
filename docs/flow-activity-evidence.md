# Flow project activity, artifacts, and external read-back

Status: current Agent 1 A4.5 contract for `greenways-ai/greenways-os#161` and `#163`.

This contract consumes the merged Flow project, participation, work-coordination, host/session-presence, and handoff/intervention contracts. It defines the durable evidence that the later Project Control Room may display. It does not implement provider execution, artifact storage, external mutation, publication, or a host view model.

## Truthful evidence boundary

The model permanently keeps these claims separate:

```text
output reported          != artifact available
artifact available       != outcome selected
outcome selected         != artifact verified
provider accepted        != external effect observed
external effect observed != authoritative read-back verified
activity recorded        != source authority transferred
projection rebuilt       != provider, Work, transfer, or effect repeated
```

A reported artifact is a project-owned record describing a possible output. It is not the artifact bytes, a provider response object, a selected result, or verification.

A selected artifact records an attributable human decision. Selection does not imply that the artifact root exists externally or that an external effect succeeded.

A verified artifact points to a distinct verified external read-back. Provider acceptance, queue acknowledgement, HTTP success, or a completed local run is not authoritative read-back.

Project activity is append-oriented evidence. It never mutates its source record, repeats an effect, grants authority, or acts as a generic command log.

## Artifact contract

`FlowProjectArtifact` is owned by one exact Flow project and records:

- exact artifact identity and revision;
- bounded kind, title, and summary;
- exact producer membership and optional mandate/session;
- exact work and optional active/proposed claim;
- reported, available, selected, rejected, verification-pending, verified, verification-failed, or superseded state;
- exact root and Flow-owned project artifact reference when available;
- attributable human selection or rejection;
- exact external read-back identity when verification is requested; and
- explicit absence of bytes, credentials, private provider references, copied Hara Work state, and authority transfer.

Current artifact kinds are:

```text
document
code
dataset
image
media
decision
report
execution-output
other
```

The state law is:

```text
reported
  -> available | rejected | superseded
available
  -> selected | rejected | superseded
selected
  -> verification-pending | rejected | superseded
verification-pending
  -> verified | verification-failed | superseded
verification-failed
  -> verification-pending | superseded
verified
  -> superseded
```

Availability requires all three of:

- `availableAtUnixMs`;
- a lowercase SHA-256 exact root; and
- a current Flow-owned `SharedReference` identifying the exact project artifact and root.

Selection and rejection require an active human project owner or coordinator. Agent production requires an active matching project mandate containing `artifact-report`. Agent activity/evidence observation requires `evidence-observe`.

A claim, when present, must identify the exact work, producer membership, agent mandate, and active/proposed claim in the same project revision.

## External read-back contract

`FlowExternalReadback` records one exact external effect observation without carrying provider authority or repeating the effect.

Current states are:

```text
requested
provider-accepted
observed
verified
uncertain
failed
rejected
revoked
```

The lifecycle permits:

```text
requested
  -> provider-accepted | observed | uncertain | failed | rejected
provider-accepted
  -> observed | uncertain | failed | rejected
observed
  -> verified | uncertain | failed | rejected
uncertain
  -> observed | failed | rejected
verified
  -> revoked
```

A verified read-back requires:

- an observation time;
- a verification time after observation;
- one explicit method: authoritative read-back, signed receipt, or digest match;
- a current `SharedReference` with an exact root;
- `authorityState: observed`; and
- matching read-back identity and application revision.

Provider acceptance by itself requires no read-back reference and cannot produce `verified`. An uncertain record preserves provider acceptance or partial observation while declining to claim success.

The read-back may name exact work, artifact, and handoff context. Each optional identity must resolve inside the exact project snapshots. It carries no provider credential, private provider reference, effect capability, application authority, or copied runtime state.

## Append-oriented activity

`FlowProjectActivityEntry` records one immutable, attributable event with:

- project and activity identity;
- strictly increasing sequence;
- closed kind and subject kind;
- optional exact project actor;
- optional causal predecessor that must already exist earlier in the stream;
- immutable event digest;
- occurrence and recording times;
- optional bounded shared reference; and
- explicit no-mutation, no-authority, and no-replay flags.

Current activity kinds are:

```text
membership-changed
mandate-changed
host-observed
session-observed
work-changed
claim-changed
handoff-changed
intervention-changed
artifact-reported
artifact-selected
external-readback-observed
external-effect-verified
reconciliation-observed
```

Each kind has one closed subject class. An artifact-selection event must name an artifact. An external-effect-verification event must name an external read-back. A reconciliation event names the exact merged handoff reconciliation record.

Within one snapshot:

- activity IDs are unique;
- event digests are unique;
- sequence is strictly increasing;
- causal predecessors point backward only;
- recorded time cannot be later than the snapshot observation;
- selected artifacts require matching selection activity; and
- verified external effects require matching verification activity.

There is no operation to append arbitrary activity supplied by a client. Activity is derived from accepted domain records and evidence.

## Snapshot and restart law

`FlowProjectActivityEvidenceSnapshot` binds artifacts, external read-backs, and activity to one exact Flow project/application revision and snapshot generation.

It validates against:

- project participation and agent mandates;
- work/dependency/assignment/claim coordination;
- host attachments and connected sessions; and
- project handoffs, interventions, and reconciliation.

The snapshot is a projection rebuild only. Every snapshot requires:

```text
rebuildsProjectionOnly: true
repeatsProviderWork: false
repeatsWorkRuntime: false
repeatsHandoffTransfer: false
repeatsExternalEffects: false
authorityTransfer: false
```

The restart fixture demonstrates a selected artifact with `verification-pending` while its external read-back is `uncertain`. The projection rebuild does not retry the provider, rerun Hara Work, resend a handoff, repeat the effect, or convert provider acceptance into verification.

## Current operations

```text
flow.project.artifacts.list
flow.project.artifact.report
flow.project.artifact.select
flow.project.artifact.reject

flow.project.external-readbacks.list
flow.project.external-readback.observe
flow.project.external-readback.verify
flow.project.external-readback.mark-uncertain

flow.project.activity.list
```

Every non-read operation requires the expected project revision and exact-request idempotency. There is no arbitrary activity append, artifact-byte upload, provider invocation, effect retry, durable-history delete, or authority-grant operation.

## Current application boundary

- Every record is owned by current application `flow` at revision `0.1.0`.
- Spaces may appear only through bounded `SharedReference` evidence and retains Spaces authority.
- Build remains incompatible and cannot become an artifact/effect application identity.
- Foreman remains Flow's internal coordination engine and durable domain implementation, not an application target.
- Imagine and World remain unactivated and absent from the operation and activity catalogues.

## Canonical evidence

- `crates/greenways-workspace-contracts/src/flow_activity_evidence.rs`
- `crates/greenways-workspace-contracts/tests/flow_activity_evidence.rs`
- `crates/greenways-workspace-contracts/tests/fixtures/flow/project-activity-evidence.json`
- `crates/greenways-workspace-contracts/tests/fixtures/flow/project-activity-evidence-restart.json`
- `crates/greenways-workspace-contracts/tests/fixtures/flow/activity-evidence-operation-catalogue.json`

The active fixture contains one agent-produced, human-selected artifact and one separately verified authoritative external read-back. The restart fixture contains provider acceptance and uncertainty without verification or replay.

## Deferred work

This slice deliberately does not add:

- artifact bytes, blob storage, renderer output, or filesystem paths;
- provider selection, invocation, credentials, private provider references, or effect retry;
- GitHub mutation, publication, Platform admission, or public read-back;
- generic database, filesystem, browser, process, shell, native, or evaluation handles;
- the closed Desktop, CLI, browser, and MCP Project Control Room view model;
- host/Fabric operation registration or Visual Language routes;
- a Build alias or Foreman application; or
- Imagine or World activation.

The next Agent 1 slice may compose the merged project, participation, work, presence, handoff/intervention, and activity/evidence records into one closed cross-host Project Control Room view model. That view may present only the truthful actions supported by these exact contracts.
