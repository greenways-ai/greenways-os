#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
path = root / "crates/greenways-workspace-contracts/tests/flow_handoff_intervention.rs"
source = path.read_text(encoding="utf-8")
old = """fn intervention_decision_and_resolution_are_distinct_human_evidence() {
    let mut snapshot = handoffs();
    let review = &mut snapshot.interventions[0];
    review.state = FlowProjectInterventionState::Approved;
    review.decision = Some(FlowProjectInterventionDecision::Approve);
    review.decided_at_unix_ms = Some(1787275480000);
    review.decided_by_membership_id = Some(\"membership/flow-owner\".to_owned());
    snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .expect(\"human approval should validate without claiming resolution\");
    assert!(snapshot.interventions[0].resolution_reference.is_none());

    let mut snapshot = snapshot;
    snapshot.interventions[0].decided_by_membership_id =
        Some(\"membership/flow-agent-builder\".to_owned());
    assert!(snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .is_err());
}
"""
new = """fn intervention_decision_and_resolution_are_distinct_human_evidence() {
    let mut snapshot = handoffs();
    let review = &mut snapshot.interventions[0];
    review.state = FlowProjectInterventionState::Approved;
    review.decision = Some(FlowProjectInterventionDecision::Approve);
    review.decided_at_unix_ms = Some(1787275480000);
    review.decided_by_membership_id = Some(\"membership/flow-owner\".to_owned());
    let handoff = &mut snapshot.handoffs[1];
    handoff.state = FlowProjectHandoffState::Ready;
    handoff.approved_at_unix_ms = Some(1787275480000);
    handoff
        .application_handoff
        .as_mut()
        .expect(\"application handoff should exist\")
        .state = greenways_workspace_contracts::HandoffState::Ready;
    snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .expect(\"human approval should validate without claiming resolution\");
    assert!(snapshot.interventions[0].resolution_reference.is_none());

    snapshot.interventions[0].decided_by_membership_id =
        Some(\"membership/flow-agent-builder\".to_owned());
    assert!(snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .is_err());
}
"""
count = source.count(old)
if count != 1:
    raise SystemExit(f"approval-state test block: expected one match, found {count}")
source = source.replace(old, new, 1)
old_resolution = """    let mut snapshot = snapshot;
    snapshot.interventions[1].resolution_reference = None;
    assert!(snapshot.validate().is_err());
"""
new_resolution = """    snapshot.interventions[1].resolution_reference = None;
    assert!(snapshot.validate().is_err());
"""
count = source.count(old_resolution)
if count != 1:
    raise SystemExit(f"resolution test binding: expected one match, found {count}")
path.write_text(source.replace(old_resolution, new_resolution, 1), encoding="utf-8")
Path(__file__).unlink()
