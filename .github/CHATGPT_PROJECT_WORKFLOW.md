# ChatGPT GitHub connector programming workflow

**Repository:** `greenways-ai/greenways-os`  
**Tracking issue:** `#198`  
**Initial base:** `a6e2bb32a10984d7812f788b6e882be5d151a93a`  
**Status:** canonical repository-local contract for programming initiated through the ChatGPT web application

This contract specializes the organisation's
[connector-first delivery workflow](https://github.com/greenways-ai/.github/blob/main/docs/connector-first-delivery.md).
GitHub is the execution host and durable record: issues define the work,
branches and commits carry it, draft pull requests expose it, and Actions
provide executable evidence. An MCP server is not part of this workflow.

## Delivery loop

1. Read `AGENTS.md`, this file, the executable issue, linked relationships, and
   any more-specific repository instructions.
2. Resolve the current default branch and record its exact commit SHA before
   editing. Do not silently retarget an in-flight task to a newer base.
3. Create or reuse an executable issue with Outcome, Scope, Acceptance criteria,
   Validation, Relationships, Readiness, and Delivery.
4. Create `agent/<issue>-<slug>` from that recorded base. Inspect the intended
   file set and keep unrelated work out of the branch.
5. Implement product code and its tests together. Never commit generated caches,
   local credentials, build outputs, or transient evidence.
6. Run the repository-native checks selected below and commit the bounded change.
7. Push through the GitHub connector, read the remote branch back, and verify
   that its head is the intended SHA.
8. Treat the branch run of `Connector code execution` as push preflight. Repair
   failures before opening the draft pull request.
9. Open or reuse one draft pull request for the branch. Read it back and verify
   repository, state, base, head branch, and head SHA.
10. Inspect every relevant Actions run, including the repository's existing
    authoritative workflows. Repair on the same branch until required checks
    are green. Do not create a repository-mutating Actions workaround.
11. Mark ready only when explicitly requested and all required checks are green.
    Report the issue URL, branch, exact commit SHA, pull-request URL, and
    relevant run URLs.

## Path-aware execution

`./scripts/connector/detect-code-scope` compares the exact base to `HEAD`.
Documentation-only changes may select no product scope. Unknown executable or
configuration paths fail toward all scopes so new code cannot escape execution.

| Scope | Representative paths | Committed command |
|---|---|---|
| `daemon` | Rust workspace and daemon/bridge crates | `scripts/connector/run-code daemon` |
| `extension` | `extension/**`, including Hara Chrome | `scripts/connector/run-code extension` |
| `services` | `services/**` | `scripts/connector/run-code services` |
| `desktop` | `apps/greenways_desktop/**` | `scripts/connector/run-code desktop` |
| `contracts` | suite manifests, governance, protocol/configuration and scripts | `scripts/connector/run-code contracts` |

The selector's `--self-test`, shell syntax checks, and the final evidence gate
always run. The workflow uses `contents: read`; it cannot commit, push, label,
merge, release, deploy, or mutate an issue or pull request.

## Existing checks remain authoritative

The existing `Greenways OS CI` workflow remains authoritative for full extension browser tests and packaging, the pinned Rust daemon suite, and the macOS desktop release-shaped build. Materializer, release, Pages, audit, and pin-update workflows remain product operations rather than delivery shortcuts.

The connector desktop scope runs portable analysis/tests on Linux; the authoritative workflow retains the macOS bundle proof.

## Evidence contract

Each selected scope uploads a small text artifact containing repository, scope,
base, head, run ID, attempt, and the exact committed command. The final
`evidence-gate` accepts only `success` or `skipped` scope results and requires
the selector contract to succeed.

The artifact is supporting evidence, not a substitute for the GitHub branch,
commit, draft pull request, or the repository's normal required checks.
