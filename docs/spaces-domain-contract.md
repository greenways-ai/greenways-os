# Greenways Spaces domain contract

Status: B1 contract for `greenways-ai/greenways-os#157` and `#164`.

This contract extends the merged current-suite foundation. It does not replace
shared application, reference, result, or handoff envelopes.

## Identity

The domain manifest is tied exactly to the current suite identity:

```text
application: spaces
revision:    0.1.0
package:     greenways/spaces
protocol:    greenways.spaces.domain/0-alpha
aggregate:   greenways.spaces.space/0-alpha
```

The compatibility disposition from B0 remains `absent`. The manifest cannot
make the legacy input discoverable, grant it authority, create a migration, or
create a second Space.

## Aggregate boundary

`SpaceSnapshot` is the sole application aggregate. It owns closed collections
of:

| Record | Contract role |
| --- | --- |
| Space | Subject, purpose, scope, owner, privacy, and lifecycle root. |
| Reference | Exact observation of a separately owned source, concept, assertion, Flow object, or public work. |
| Map | Saved view, selection, grouping, lens, nodes, and visual relationships. |
| Map node | Pointer to one record already inside the same Space. |
| Visual relationship | Local association plus an explicit promotion state. |
| Topic | Either unresolved local vocabulary or one exact Tahto concept observation. |
| Note | Space-local working material with an explicit grounding state. |
| Question | First-class knowledge gap with an optional exact Flow observation after handoff. |
| Hypothesis | Proposed explanation with separate supporting, conflicting, and missing evidence. |
| Finding | Candidate, reviewed, or rejected conclusion with exact grounding. |
| Lens | Deterministic record-kind, truth-state, and sort selection. |
| Brief | Ordered synthesis sections with section-level grounding. |
| Activity | Attributable import, map, review, handoff, and release fact. |

Every record is closed with `deny_unknown_fields`. Record identifiers are
unique across the aggregate, revisions are positive, collection sizes are
bounded, and pointers cannot escape the containing Space.

## Reference boundary

Spaces imports only these exact observation kinds:

```text
Hestia: source · anchor · candidate · assertion
Tahto:  concept · semantic relationship
Flow:   object
Platform/public: public work
```

Spaces exports only stable references to:

```text
Space · map · question · finding · brief
```

Every imported observation uses the merged `SharedReference` envelope and must:

- be owned by the containing Space as an observation;
- retain the exact current Spaces revision;
- retain an exact external logical ID and content root;
- set `authorityTransfer` to `false`;
- keep candidates in `resolution-required`; and
- keep accepted external records in `observed`.

A summary or display label is never accepted as a substitute for the exact
logical identity and root.

## Truthfulness states

Space-local material is always one of:

```text
unsourced · unresolved · sourced · derived · candidate · asserted
```

The states are not aliases:

- `unsourced` and `unresolved` carry no external evidence reference;
- `sourced` carries only exact Hestia sources or anchors;
- `derived` carries exact source, anchor, or accepted assertion observations;
- `candidate` carries only Hestia candidate observations; and
- `asserted` requires an accepted Hestia assertion and forbids candidates.

Reviewed findings and reviewed or released briefs cannot silently retain
unsourced, unresolved, or candidate content.

## Promotion law

The manifest publishes exactly three product outcomes:

```text
keep visual association
review a Hestia knowledge assertion
propose a Tahto semantic relationship
```

The map record retains intermediate states, but their ownership remains
separate:

| Promotion state | Required authority | Forbidden claim |
| --- | --- | --- |
| Visual association | None; Spaces perspective only | Any canonical reference. |
| Hestia candidate | Hestia candidate observation | Accepted assertion or semantic truth. |
| Hestia assertion | Accepted Hestia assertion | Candidate, Flow/public authority, or Tahto semantic link. |
| Tahto semantic proposal | Accepted Hestia assertion; optional Tahto concepts | Existing canonical Tahto relationship. |
| Tahto semantic relationship | Accepted Hestia assertion and exact validated Tahto relationship | Candidate or foreign application authority. |

Layout proximity is permanently visual-only. It cannot be promoted by changing
a flag or attaching a canonical reference.

## Fabric groups

The domain manifest exposes only closed Spaces permissions:

```text
reader
composer
reviewer
flow-handoff
publisher
```

The permissions cover reading, perspective editing, source-reference
attachment, evidence review, bounded assertion/semantic proposals, selected
Flow context exchange, selected result import, brief composition, and selected
work release. There is no permission for credentials, cookies, storage roots,
provider handles, arbitrary queries, application grants, or remote catalogue
installation.

## Canonical evidence

- Domain manifest:
  `crates/greenways-workspace-contracts/tests/fixtures/spaces/domain-manifest.json`
- Truth-state aggregate:
  `crates/greenways-workspace-contracts/tests/fixtures/spaces/space-truth-states.json`
- Contract tests:
  `crates/greenways-workspace-contracts/tests/spaces_domain_contract.rs`

The aggregate fixture covers sourced, unresolved, unsourced, derived,
asserted, and candidate states in one stable Space. It also contains local,
candidate, assertion, semantic-proposal, and validated-semantic map edges.

## Deliberate deferrals

This slice defines domain state and validation only. It does not add mutation
operations, persistence, synchronization, browser capture, host routes,
current handoff execution, Visual Language screens, or Platform profiles.
Those remain separate B2–B7 slices.

Current cross-application work targets Flow only. Reserved future targets do
not appear in this manifest, fixture, discovery surface, or permission set.

## Validation

```bash
cargo +1.85.1 fmt --all --check
cargo +1.85.1 test -p greenways-workspace-contracts --all-targets
cargo +1.85.1 clippy -p greenways-workspace-contracts --all-targets -- -D warnings
python3 scripts/check-spaces-compatibility-inventory.py
python3 -m json.tool crates/greenways-workspace-contracts/tests/fixtures/spaces/domain-manifest.json >/dev/null
python3 -m json.tool crates/greenways-workspace-contracts/tests/fixtures/spaces/space-truth-states.json >/dev/null
```
