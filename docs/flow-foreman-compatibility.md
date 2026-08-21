# Flow, Build, and Foreman compatibility

This document records the A2 compatibility decision consumed by Greenways Flow,
its Foreman coordination service, and the current suite hosts.

The evidence baseline is `greenways-ai/greenways-os` `main` at
`80316806d3dac11031106aab8e6eb285b186b6ed`, tree
`9e700a908302bb437460fe9a3f0b350b4ed81a8c`.

## Current boundary

Greenways Flow is the only current product-facing coordination application:

```text
application       flow
package           greenways/flow
launcher          Flow
route             /flow/
CLI               greenways flow
operations        flow.*
permissions       flow.*
Visual Language   /v2/applications/flow/
```

Foreman is Flow's internal coordination service and durable domain
implementation. The `foreman` service identity and any stable `foreman.*`
protocols do not create a launcher entry, route, command family, application
grant, or second product record.

## Compatibility decision table

| Identity | Classification | Decision |
| --- | --- | --- |
| Build application/package IDs | absent | No alias or migration is minted. Requests using `build` fail as incompatible. |
| Build routes, commands, operations, surfaces, handoffs, and public-work IDs | absent | Ordinary compiler and construction uses of the word “build” remain untouched. |
| `Foreman` in earlier foreground-product prose | safe display alias | Interpret as display lineage for Flow only. It is not discoverable or authoritative. |
| `foreman` service identity | retained technical identity | Preserve as Flow's internal coordination service. |
| `foreman.*` | retained technical identity | Do not destructively rename stable protocols or operations when introduced. |
| `project/*` | retained technical identity | Project remains the aggregate root. |
| `work/*` | retained technical identity | Work remains project-scoped and independent of presentation naming. |
| `buildout/*` | retained technical identity | Buildout remains an optional project-local grouping. |

The checked baseline contains older architecture prose that presents Foreman as
the foreground application. That prose is evidence for the display alias, not
evidence of a durable application/package/route/CLI identity. Product-copy and
host adoption slices may update those surfaces after consuming this contract;
they must not rewrite durable technical records as a side effect.

## Aggregate law

Project is the Flow aggregate root. A work item can exist without a buildout,
and a project, member, agent mandate, host, session, handoff, or project-wide
attention record cannot be owned by a buildout. Cross-project movement is always
an explicit bounded handoff.

This A2 slice freezes operation-family prefixes only. Concrete project, work,
claim, buildout, intervention, activity, view-model, and lifecycle records remain
owned by the following Flow contract slices.

## Authority and exposure

Compatibility never transfers source authority, creates a parallel logical
project, selects credentials or hosts, or copies Hara Work runtime state. Imagine
and World remain absent from current Flow discovery and from this compatibility
manifest.

## Evidence and validation

The machine-readable evidence is
`protocol/compatibility/flow-build-foreman-inventory-0-alpha.json`. It records all
Build categories as absent, pins the existing Foreman/buildout prose counts, and
fails when a new product identity or unreviewed technical namespace appears.

Run:

```sh
python3 scripts/check-flow-foreman-compatibility.py
cargo test -p greenways-workspace-contracts --all-targets
cargo clippy -p greenways-workspace-contracts --all-targets -- -D warnings
```
