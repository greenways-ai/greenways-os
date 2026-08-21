# Flow project contract

Status: current Agent 1 product contract for #163.

This contract consumes the current suite foundation and the merged Flow/Foreman compatibility law. It defines the product records that later Desktop, CLI, browser, Platform, and Project Control Room slices may consume. It does not register those hosts or implement provider execution.

## Product boundary

Greenways Flow is the only current product-facing coordination application. Every project, work reference, buildout reference, and operation descriptor is owned by application `flow` at the exact current suite revision.

Foreman remains Flow's internal coordination engine and durable domain implementation. It is not a package, launcher application, route family, CLI family, operation namespace, or application target. The project contract therefore exposes no Foreman application identity and no generic execution handle.

The legacy `build` target remains `incompatible-blocked`. Nothing in this contract creates a Build alias, duplicate project, redirect, command family, stored record namespace, or authority path.

Imagine and World remain reserved and unactivated.

## Aggregate law

`FlowProjectSnapshot` is the aggregate root.

A project owns:

- its current application and project revision;
- project lifecycle state and monotonic timestamps;
- bounded source and evidence observations expressed only as existing `SharedReference` values;
- bounded work references;
- zero or more optional buildout references.

A buildout is an optional grouping inside one project. It is never an application identity. Direct work has no buildout ID. Grouped work names exactly one buildout, and that buildout must list the same work ID. A work item cannot belong to two buildouts or to another project.

Source and evidence references remain observations owned by their source applications. Their existing `authorityTransfer: false` law is preserved. A project cannot use a reference to acquire Spaces authority, Flow application authority, a provider grant, a native handle, or a storage capability.

## Record protocols

| Record | Protocol | Identity law |
| --- | --- | --- |
| Project snapshot | `greenways.flow.project/0-alpha` | `project/...`, positive revision, Flow-owned |
| Work reference | `greenways.flow.work-reference/0-alpha` | `work/...`, positive revision, one project |
| Buildout reference | `greenways.flow.buildout-reference/0-alpha` | `buildout/...`, positive revision, one project, non-empty work membership |
| Operation descriptor | `greenways.flow.operation/0-alpha` | exact closed metadata for one current Flow operation |
| Operation catalogue | `greenways.flow.operation-catalogue/0-alpha` | exact ordered current operation inventory |

All records deny unknown fields. Exact roots, when present, are lowercase SHA-256 digests. IDs are bounded, scoped, path-safe strings. Project references and collection sizes are bounded.

## Lifecycle law

Project states are `draft`, `active`, `paused`, `review`, `completed`, and `cancelled`. Completed and cancelled projects do not reopen through the current contract. A completed project must contain at least one work item and all work/buildouts must be completed or cancelled.

Work states are `planned`, `ready`, `running`, `blocked`, `review`, `completed`, `cancelled`, and `failed`. Completed, cancelled, and failed work is terminal; retries or fresh attempts require a new durable work identity rather than reinterpretation of the old receipt.

Buildout states are `planned`, `active`, `blocked`, `review`, `completed`, `cancelled`, and `failed`. Completed and cancelled buildouts require all listed work to be completed or cancelled.

The Rust enums expose closed `allows_transition_to` laws so hosts cannot infer arbitrary lifecycle movement.

## Current operation catalogue

| Operation | Scope | Intent | Concurrency / replay law |
| --- | --- | --- | --- |
| `flow.project.list` | project collection | read | no idempotency key |
| `flow.project.get` | project | read | project ID required |
| `flow.project.create` | project collection | manage | exact-request idempotency |
| `flow.project.update` | project | manage | project ID and expected revision required |
| `flow.project.transition` | project | manage | project ID and expected revision required |
| `flow.work.list` | project work | read | project ID required |
| `flow.work.get` | work | read | project and work IDs required |
| `flow.work.create` | work | manage | project expected revision and exact-request idempotency |
| `flow.work.update` | work | manage | project/work IDs and expected revision required |
| `flow.work.transition` | work | manage | project/work IDs and expected revision required |
| `flow.buildout.list` | project buildouts | read | project ID required |
| `flow.buildout.get` | buildout | read | project and buildout IDs required |
| `flow.buildout.create` | buildout | manage | project expected revision and exact-request idempotency |
| `flow.buildout.update` | buildout | manage | project/buildout IDs and expected revision required |
| `flow.buildout.transition` | buildout | manage | project/buildout IDs and expected revision required |

There is no delete operation. Durable project, work, buildout, evidence, and execution receipts are not erased through the current catalogue. Later approval, resume, handoff, GitHub-record opening, and provider actions must either map truthfully onto these records or introduce separately reviewed operation contracts.

Every mutating operation uses exact-request idempotency. Every update/transition of an existing aggregate member requires an expected revision. No operation descriptor grants application authority.

## Canonical fixtures

- `crates/greenways-workspace-contracts/tests/fixtures/flow/project-direct-work.json` demonstrates a project with direct work and no buildout.
- `crates/greenways-workspace-contracts/tests/fixtures/flow/project-buildout.json` demonstrates one optional buildout with exact two-way work membership.
- `crates/greenways-workspace-contracts/tests/fixtures/flow/operation-catalogue.json` freezes the current operation inventory.

## Deferred adoption

This slice does not add:

- a Flow route or Project Control Room view;
- Desktop, CLI, browser, MCP, Fabric, or Platform registration;
- Foreman provider/execution behavior;
- source/evidence creation or Spaces semantic-promotion rules;
- GitHub mutations;
- generic filesystem, database, eval, native, network, process, or provider handles;
- Imagine or World discovery.

Those surfaces may consume the contract only after this record and operation inventory is merged. Host adoption must preserve exact application/revision identity, expected-revision concurrency, exact-request idempotency, and the existing authority boundary.
