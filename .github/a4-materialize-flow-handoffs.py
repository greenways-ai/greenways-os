#!/usr/bin/env python3
from __future__ import annotations

import json
import runpy
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github/workflows/a4-flow-handoffs-interventions-materializer.yml"
SELF = Path(__file__).resolve()
ERROR_LOG = ROOT / ".github/a4-flow-handoffs-interventions-error.log"


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
    "mod flow;\nmod flow_participation;",
    "mod flow;\nmod flow_handoff_intervention;\nmod flow_participation;",
    "Flow handoff module registration",
)
replace_once(
    lib,
    "pub use flow::*;\npub use flow_participation::*;",
    "pub use flow::*;\npub use flow_handoff_intervention::*;\npub use flow_participation::*;",
    "Flow handoff exports",
)

participation = ROOT / "crates/greenways-workspace-contracts/src/flow_participation.rs"
replace_once(
    participation,
    "    WorkTransition,\n    WorkClaim,\n    BuildoutRead,",
    "    WorkTransition,\n    WorkClaim,\n    HandoffRequest,\n    InterventionRaise,\n    BuildoutRead,",
    "Agent handoff capabilities",
)

fixture_path = (
    ROOT
    / "crates/greenways-workspace-contracts/tests/fixtures/flow/project-participation.json"
)
fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
capabilities = fixture["agentMandates"][0]["capabilities"]
marker = capabilities.index("work-claim") + 1
for capability in reversed(["handoff-request", "intervention-raise"]):
    if capability not in capabilities:
        capabilities.insert(marker, capability)
write_json(fixture_path, fixture)

documentation = ROOT / "docs/flow-project-participation.md"
replace_once(
    documentation,
    "This contract extends the merged Flow project aggregate with project membership and bounded agent mandates. It does not introduce host/session presence, work claims, handoffs, interventions, or a Control Room view model.",
    "This contract defines the project membership and bounded agent-mandate boundary. Later merged contracts add host/session presence, work claims, and the two request-only handoff/intervention capabilities without widening identity, provider, host, credential, or application authority.",
    "Participation scope status",
)
replace_once(
    documentation,
    "work-transition\nwork-claim\nbuildout-read",
    "work-transition\nwork-claim\nhandoff-request\nintervention-raise\nbuildout-read",
    "Participation capability inventory",
)
replace_once(
    documentation,
    """## Deferred slices

Subsequent A4 pull requests own:

1. work dependency and claim/lease records;
2. host/session presence and restart reconciliation;
3. handoff and intervention records;
4. activity/evidence and external read-back projections; and
5. closed Desktop, CLI, browser, and MCP Project Control Room view models.

This contract introduces no generic database, filesystem, provider, browser, process, shell, native, credential, or application-authority handle.""",
    """## Downstream extensions

Merged A4 contracts now consume this boundary for work dependencies and claims, host/session presence, and project handoff/intervention requests. `handoff-request` and `intervention-raise` allow an active agent to propose bounded coordination records only; they do not allow the agent to approve interventions, manage membership or mandates, attach hosts, invoke providers, select credentials, repeat effects, or transfer authority.

Activity/evidence, external read-back, and closed Desktop, CLI, browser, and MCP Project Control Room view models remain later independent slices.

This contract introduces no generic database, filesystem, provider, browser, process, shell, native, credential, or application-authority handle.""",
    "Participation downstream status",
)

handoff_source = ROOT / "crates/greenways-workspace-contracts/src/flow_handoff_intervention.rs"
replace_once(
    handoff_source,
    """    const fn is_current(self) -> bool {
        !matches!(
            self,
            Self::Completed
                | Self::Partial
                | Self::Rejected
                | Self::Cancelled
                | Self::Failed
                | Self::Expired
        )
    }
""",
    "",
    "Unused handoff current-state helper",
)

tests = ROOT / "crates/greenways-workspace-contracts/tests/flow_handoff_intervention.rs"
replace_once(
    tests,
    "    FlowHandoffInterventionOperationId, FlowHandoffReconciliationState,\n",
    "    FlowHandoffReconciliationState,\n",
    "Unused operation ID test import",
)
replace_once(
    tests,
    """fn agent_requests_require_the_exact_closed_mandate_capability() {
    let mut participation = participation();
    participation.agent_mandates[0]
        .capabilities
        .retain(|capability| *capability != FlowAgentMandateCapability::HandoffRequest);
    assert!(handoffs()
        .validate_against_context(&participation, &coordination(), &presence())
        .is_err());

    let mut participation = participation();
    participation.agent_mandates[0]
        .capabilities
        .retain(|capability| *capability != FlowAgentMandateCapability::InterventionRaise);
    assert!(handoffs()
        .validate_against_context(&participation, &coordination(), &presence())
        .is_err());
}
""",
    """fn agent_requests_require_the_exact_closed_mandate_capability() {
    let mut without_handoff_capability = participation();
    without_handoff_capability.agent_mandates[0]
        .capabilities
        .retain(|capability| *capability != FlowAgentMandateCapability::HandoffRequest);
    assert!(handoffs()
        .validate_against_context(
            &without_handoff_capability,
            &coordination(),
            &presence(),
        )
        .is_err());

    let mut without_intervention_capability = participation();
    without_intervention_capability.agent_mandates[0]
        .capabilities
        .retain(|capability| *capability != FlowAgentMandateCapability::InterventionRaise);
    assert!(handoffs()
        .validate_against_context(
            &without_intervention_capability,
            &coordination(),
            &presence(),
        )
        .is_err());
}
""",
    "Mandate capability test bindings",
)
replace_once(
    tests,
    """    let catalogue = flow_handoff_intervention_operation_catalogue();
    assert!(catalogue.operations.iter().all(|operation| {
        operation.application_id == CurrentApplicationId::Flow
            && operation.operation_id != FlowHandoffInterventionOperationId::HandoffsList
                || operation.application_id == CurrentApplicationId::Flow
    }));
""",
    """    let catalogue = flow_handoff_intervention_operation_catalogue();
    assert!(catalogue
        .operations
        .iter()
        .all(|operation| operation.application_id == CurrentApplicationId::Flow));
""",
    "Current Flow operation ownership assertion",
)

subprocess.run(
    ["git", "rm", "--ignore-unmatch", str(ERROR_LOG.relative_to(ROOT))],
    cwd=ROOT,
    check=True,
)
WORKFLOW.unlink()
SELF.unlink()

inventory_path = ROOT / "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json"
checker = runpy.run_path(str(ROOT / "scripts/check-flow-build-foreman-inventory.py"))
findings, forbidden, _counts = checker["scan_findings"]()
if forbidden:
    raise SystemExit("forbidden Build identity found:\n" + "\n".join(forbidden))
inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
inventory["findings"] = findings
write_json(inventory_path, inventory)
