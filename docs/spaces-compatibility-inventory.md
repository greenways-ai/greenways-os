# Spaces compatibility inventory

Status: B0 evidence for `greenways-ai/greenways-os#164` and `#165`.

Baseline: `greenways-ai/greenways-os` `main` at
`39f3b80820eead14a9c74430caeb93d88f3915bb` (tree
`521b46e81bf7ab7d8d61eb2f741ffbef6d3cc38c`).

This document records what had actually merged before the Spaces package and
operation contract is frozen. It does not register a Spaces application,
publish `spaces.*` operations, modify shared suite/handoff envelopes, or
activate Imagine or World.

## Method

The companion inventory and checker inspect every tracked UTF-8 text file for
the case-insensitive token `research`. Each occurrence must be recorded either
as a durable legacy identity with one of the issue #165 compatibility
classifications or as reviewed generic prose. The checker excludes only its
four self-describing inventory files, rejects undeclared occurrences, and
verifies that the recorded baseline remains an ancestor of the checked commit.
Submodule contents are separate repositories and are not included by this
Greenways OS inventory.

Run:

```bash
python3 scripts/check-spaces-compatibility-inventory.py
git diff --check
```

Machine-readable evidence lives at
`protocol/compatibility/spaces-research-inventory-0-alpha.json`.

## Compatibility result

| Identity class | Classification | B1 consequence |
| --- | --- | --- |
| Research application/package IDs | absent | Mint only the Gate 0 Spaces identity. Do not create a speculative Research alias. |
| `research.*` operations, schemas, namespaces, events, and record kinds | absent | New application identities may use `spaces.*` only after Gate 0. |
| Research routes and deep links | absent | Add `/spaces/` through the shared route contract; no unproven `/research/` redirect. |
| `greenways research ...` CLI commands | absent | Add `greenways spaces ...` after Gate 0; no speculative CLI compatibility family. |
| Stored Research project/space records | absent | Do not guess records into a Space. Add migration only when persisted evidence exists. |
| Launcher, recents, search, notification, and activity identities | absent | Use Spaces for new identities; ordinary prose about research remains non-identity text. |
| Research handoff source/target IDs | absent | Build Spaces↔Flow only on the merged shared handoff base. |
| Public-work Research source-application values | absent | Platform profiles consume the later merged Spaces ID; this repository needs no Research value. |

The baseline has no merged Research identity requiring an alias, retained
technical identity, or migration. This is a repository-scoped conclusion, not
a claim about Visual Language, Platform, external deployments, or user data.
Those surfaces require their own inventories before compatibility decisions.

## Laws carried into B1–B3

- An `absent` category cannot justify a compatibility alias.
- Unknown or ambiguous external records fail explicitly; they are not guessed
  into a Space.
- A future discovered durable identity changes this inventory before migration
  code is written.
- Generic human-activity prose is not an application identity.
- Current user-facing handoffs target Flow only.
- Imagine and World extension points remain unavailable and unannounced.

## Gate status

B0 is independent and reviewable now. B1, B2, and B3 remain merge-gated on
Agent 1's Gate 0 contract from issue #163. This inventory deliberately adds no
shared manifest, reference, result/error, or handoff fields.
