# Flow, Build, and Foreman compatibility

Status: current-suite compatibility law for Agent 1 / #163 and #169.

Reviewed baseline:

- commit `80316806d3dac11031106aab8e6eb285b186b6ed`;
- tree `9e700a908302bb437460fe9a3f0b350b4ed81a8c`;
- read-only inventory run `32444172077`, job `96660543231`;
- probe merge commit `82738338060259dc815f8df5ffbbc052bf014e8c`;
- probe merge tree `98f556ecb779b49b8cde6a457b5ffbf3a36b2f00`.

The probe scanned 671 tracked paths, decoded 662 UTF-8 files, skipped six binary files, and reported 101 contextual lines. Seventeen lines matched the deliberately broad identity heuristics, but those matches were build directories, semver build metadata, local variables, or other ordinary uses of the word “build”. The actual compatibility evidence is narrower: the Gate 0 legacy Build token and product-facing Foreman prose in four architecture documents.

## Product and service law

**Greenways Flow is the only current product-facing coordination application.** Its current package is `greenways/flow`; its route family is `/flow/`; its CLI family is `greenways flow`; and its launcher label is `Flow`.

**Foreman is Flow’s internal coordination engine and durable domain implementation.** It may appear in technical architecture, compatibility evidence, diagnostics, tests, and durable domain descriptions. It is not a second launcher application, package, route family, CLI family, or user-facing navigation system.

**Project is the aggregate root.** Work, buildouts, evidence, provider attempts, Hara Work, and storage records remain technical or durable domain vocabulary. A buildout is an optional project grouping and does not imply the discontinued Build product identity.

## Decision table

| Surface | Classification | Decision |
| --- | --- | --- |
| Build application and package ID | `incompatible-blocked` | The legacy `build` token remains recognized only so an old target fails explicitly. It is not aliased to Flow and cannot create a duplicate logical project. |
| `/build` route or deep link | `absent` | No merged route or deep-link contract exists. Do not add a redirect without a separately versioned compatibility decision. |
| `greenways build` CLI family | `absent` | No merged command family exists. The current command family is `greenways flow`. |
| `build.*` operations, schemas, protocols, or record kinds | `absent` | No merged coordination operation or durable schema uses Build as an application namespace. Ordinary compiler/build paths are unrelated. |
| Launcher, recent, search, notification, or activity records carrying Build | `absent` | No stored current-suite surface record requires migration. |
| Handoff source or target application ID `build` | `absent` | Current handoffs use `spaces` and `flow`. The legacy token does not transfer authority. |
| Public-work source application `build` | `absent` | No merged public-work record requires reinterpretation. |
| Greenways OS Visual Language fixture or route for Build | `absent` | This repository contains no such current fixture. Downstream Visual Language adoption must use Flow. |
| Product-facing Foreman copy | `safe-display-alias` | README and architecture prose are updated to Flow. This is copy-only and does not rename durable records. |
| Foreman engine and durable domain | `retained-technical-identity` | Technical Foreman references remain valid behind Flow. |
| Project, work, buildout, provider, Hara Work, and storage identities | `retained-technical-identity` | These are domain/runtime identities, not the discontinued product name. |

No versioned compatibility alias is required because no merged Build route, CLI, operation, or stored surface identity exists. No explicit durable migration is required because the checked tree contains no Build-owned project or work records. A future discovery of such evidence must update the closed inventory and choose the appropriate classification before implementation.

## Runtime behavior

`resolve_application_target("build")` returns a failed `greenways.result/0-alpha` envelope with:

- code `incompatible`;
- no value;
- `retryable: false`;
- `applicationId: "build"`.

The Flow manifest records Build with disposition `incompatible-blocked`, `discoverable: false`, and `grantsAuthority: false`. This prevents silent aliasing, duplicate launchers, duplicate project aggregates, and accidental authority transfer.

`resolve_application_target("foreman")` returns `unknown-application`. Foreman is not an application target. Internal services may use the technical name only through their own bounded contracts.

Requests for `imagine` or `world` continue to return `unactivated-application`. This compatibility work does not activate or advertise future products.

## Terminology migration

The following repository documents previously described Foreman as the foreground product and are migrated as safe display copy:

- `README.md`;
- `docs/fabric-architecture.md`;
- `docs/fabric-technology-map.md`;
- `docs/workspace-architecture.md`.

Their current copy presents Flow to the user and names Foreman only where the internal coordination engine, durable project model, compatibility evidence, or diagnostics are being described.

## Closed evidence

The executable inventory is:

- `protocol/compatibility/flow-build-foreman-inventory-0-alpha.json`;
- `scripts/check-flow-build-foreman-inventory.py`;
- `crates/greenways-workspace-contracts/tests/flow_foreman_compatibility.rs`.

The checker scans every tracked and non-ignored working-tree UTF-8 file except its own evidence files. Including non-ignored untracked files makes newly created source fail closed before it is staged; generated staging directories must therefore be removed before invoking the checker. It rejects current Build product identities, compares every remaining Foreman/buildout/legacy-Build occurrence against the exact reviewed inventory, and validates the canonical Flow manifest.

## Publication proof

The corrective source publication was validated in Actions run `32448203238`, job `96671618115`. That run materialized the ordinary source tree, passed the seven Gate 0 tests and four focused Flow/Foreman tests, checked the owned crate with Rust `1.85.1`, validated the JSON inventory, reran the closed scanner, and removed the temporary transport before publishing.

The repository-wide formatter repair was bounded and published in run `32448687571`, job `96672910274`. Its guard required `cargo +1.85.1 fmt --all` to change exactly `cli/greenways/src/desktop.rs`, then removed its temporary workflow in the same commit.

The Agent 1 Desktop compatibility repair was validated and published in run `32449758065`, job `96675886292`. It replaced the lint-only home override with a public factory and private stored constructor, retained the one-request-per-connection control protocol, formatted exactly the server and two affected tests with Flutter `3.47.0`, passed `flutter analyze` and the full Flutter test suite, and removed its publication workflow in the same commit.

Normal workspace CI also exposed and closed a legacy CLI composition defect: the modern Desktop dispatcher now wraps the included legacy CLI through a distinct `dispatch` function placed before the included test module. This preserves the existing command implementation while allowing the combined binary to compile and pass Clippy.