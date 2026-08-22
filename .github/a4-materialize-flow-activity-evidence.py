#!/usr/bin/env python3
from __future__ import annotations

import json
import runpy
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SELF = Path(__file__).resolve()
WORKFLOW = ROOT / ".github/workflows/a4-flow-activity-evidence-materializer.yml"
ERROR_LOG = ROOT / ".github/a4-flow-activity-evidence-error.log"


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    source = path.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


lib = ROOT / "crates/greenways-workspace-contracts/src/lib.rs"
replace_once(
    lib,
    "mod flow;\nmod flow_handoff_intervention;",
    "mod flow;\nmod flow_activity_evidence;\nmod flow_handoff_intervention;",
    "Flow activity/evidence module registration",
)
replace_once(
    lib,
    "pub use flow::*;\npub use flow_handoff_intervention::*;",
    "pub use flow::*;\npub use flow_activity_evidence::*;\npub use flow_handoff_intervention::*;",
    "Flow activity/evidence exports",
)

participation = ROOT / "crates/greenways-workspace-contracts/src/flow_participation.rs"
replace_once(
    participation,
    "    HandoffRequest,\n    InterventionRaise,\n    BuildoutRead,",
    "    HandoffRequest,\n    InterventionRaise,\n    ArtifactReport,\n    EvidenceObserve,\n    BuildoutRead,",
    "Agent artifact/evidence capabilities",
)

fixture_path = (
    ROOT
    / "crates/greenways-workspace-contracts/tests/fixtures/flow/project-participation.json"
)
fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
capabilities = fixture["agentMandates"][0]["capabilities"]
marker = capabilities.index("intervention-raise") + 1
for capability in reversed(["artifact-report", "evidence-observe"]):
    if capability not in capabilities:
        capabilities.insert(marker, capability)
write_json(fixture_path, fixture)

participation_doc = ROOT / "docs/flow-project-participation.md"
replace_once(
    participation_doc,
    "This contract defines the project membership and bounded agent-mandate boundary. Later merged contracts add host/session presence, work claims, and the two request-only handoff/intervention capabilities without widening identity, provider, host, credential, or application authority.",
    "This contract defines the project membership and bounded agent-mandate boundary. Later merged contracts add host/session presence, work claims, request-only handoff/intervention capabilities, and bounded artifact-report/evidence-observation capabilities without widening identity, provider, host, credential, effect, or application authority.",
    "Participation scope status",
)
replace_once(
    participation_doc,
    "handoff-request\nintervention-raise\nbuildout-read",
    "handoff-request\nintervention-raise\nartifact-report\nevidence-observe\nbuildout-read",
    "Participation capability inventory",
)
replace_once(
    participation_doc,
    """Merged A4 contracts now consume this boundary for work dependencies and claims, host/session presence, and project handoff/intervention requests. `handoff-request` and `intervention-raise` allow an active agent to propose bounded coordination records only; they do not allow the agent to approve interventions, manage membership or mandates, attach hosts, invoke providers, select credentials, repeat effects, or transfer authority.

Activity/evidence, external read-back, and closed Desktop, CLI, browser, and MCP Project Control Room view models remain later independent slices.""",
    """Merged A4 contracts now consume this boundary for work dependencies and claims, host/session presence, project handoff/intervention requests, artifact reports, and evidence observations. `handoff-request`, `intervention-raise`, `artifact-report`, and `evidence-observe` allow an active agent to propose or observe bounded project records only; they do not allow the agent to approve interventions, select outcomes, verify external effects without read-back, manage membership or mandates, attach hosts, invoke providers, select credentials, repeat effects, or transfer authority.

Closed Desktop, CLI, browser, and MCP Project Control Room view models remain the next independent slice.""",
    "Participation downstream status",
)

handoff_doc = ROOT / "docs/flow-handoffs-interventions.md"
replace_once(
    handoff_doc,
    """## Deferred work

This slice deliberately does not add:

- transport delivery or message queues;
- provider selection, invocation, credentials, or private provider references;
- selected outcome, artifact verification, or external-effect read-back records;
- project activity/evidence history;
- the cross-host Project Control Room view model;
- Desktop, CLI, browser, MCP, Fabric API, Platform, or Visual Language registration;
- a Build alias or Foreman application; or
- Imagine or World activation.

The next independent slice may add activity and evidence projections, followed by the closed cross-host Project Control Room view model. Both must consume—not redefine—the handoff, intervention, work, participation, and presence contracts.""",
    """## Downstream evidence and deferred work

The current activity/evidence contract now consumes this slice for artifact selection, external read-back, append activity, and restart-safe projections. It does not reinterpret handoff acceptance as completion, intervention resolution as verification, or reconciliation as effect replay.

This slice still deliberately does not add:

- transport delivery or message queues;
- provider selection, invocation, credentials, or private provider references;
- artifact bytes or external mutation;
- the cross-host Project Control Room view model;
- Desktop, CLI, browser, MCP, Fabric API, Platform, or Visual Language registration;
- a Build alias or Foreman application; or
- Imagine or World activation.

The next independent slice may compose the merged project, participation, work, presence, handoff/intervention, and activity/evidence records into the closed cross-host Project Control Room view model. It must consume—not redefine—these contracts.""",
    "Handoff downstream evidence status",
)

for helper in [ERROR_LOG, WORKFLOW, SELF]:
    subprocess.run(
        ["git", "rm", "--ignore-unmatch", str(helper.relative_to(ROOT))],
        cwd=ROOT,
        check=True,
    )

inventory_path = ROOT / "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json"
checker = runpy.run_path(str(ROOT / "scripts/check-flow-build-foreman-inventory.py"))
findings, forbidden, _counts = checker["scan_findings"]()
if forbidden:
    raise SystemExit("forbidden Build identity found:\n" + "\n".join(forbidden))
inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
inventory["findings"] = findings
write_json(inventory_path, inventory)
