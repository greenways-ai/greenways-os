use greenways_workspace_contracts::{
    compare_flow_project_handoff_replay, flow_handoff_intervention_operation_catalogue,
    CurrentApplicationId, FlowAgentMandateCapability, FlowHandoffInterventionOperationCatalogue,
    FlowHandoffReconciliationState, FlowProjectHandoffInterventionSnapshot,
    FlowProjectHandoffReplay, FlowProjectHandoffState, FlowProjectInterventionDecision,
    FlowProjectInterventionState, FlowProjectParticipationSnapshot, FlowProjectPresenceSnapshot,
    FlowWorkCoordinationSnapshot, FLOW_PROJECT_HANDOFFS_LIST_OPERATION,
    FLOW_PROJECT_HANDOFF_CANCEL_OPERATION, FLOW_PROJECT_HANDOFF_DECIDE_OPERATION,
    FLOW_PROJECT_HANDOFF_OBSERVE_OPERATION, FLOW_PROJECT_HANDOFF_RECONCILE_OPERATION,
    FLOW_PROJECT_HANDOFF_REQUEST_OPERATION, FLOW_PROJECT_INTERVENTIONS_LIST_OPERATION,
    FLOW_PROJECT_INTERVENTION_ACKNOWLEDGE_OPERATION, FLOW_PROJECT_INTERVENTION_DECIDE_OPERATION,
    FLOW_PROJECT_INTERVENTION_RAISE_OPERATION, FLOW_PROJECT_INTERVENTION_RESOLVE_OPERATION,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const PARTICIPATION: &str = include_str!("fixtures/flow/project-participation.json");
const COORDINATION: &str = include_str!("fixtures/flow/work-coordination.json");
const PRESENCE: &str = include_str!("fixtures/flow/project-presence.json");
const HANDOFFS: &str = include_str!("fixtures/flow/project-handoffs-interventions.json");
const RESTART: &str = include_str!("fixtures/flow/project-handoff-intervention-restart.json");
const OPERATIONS: &str =
    include_str!("fixtures/flow/handoff-intervention-operation-catalogue.json");

fn participation() -> FlowProjectParticipationSnapshot {
    serde_json::from_str(PARTICIPATION).expect("participation fixture should decode")
}

fn coordination() -> FlowWorkCoordinationSnapshot {
    serde_json::from_str(COORDINATION).expect("coordination fixture should decode")
}

fn presence() -> FlowProjectPresenceSnapshot {
    serde_json::from_str(PRESENCE).expect("presence fixture should decode")
}

fn handoffs() -> FlowProjectHandoffInterventionSnapshot {
    serde_json::from_str(HANDOFFS).expect("handoff/intervention fixture should decode")
}

fn restart() -> FlowProjectHandoffInterventionSnapshot {
    serde_json::from_str(RESTART).expect("restart fixture should decode")
}

#[test]
fn canonical_handoffs_validate_against_the_exact_project_context() {
    let snapshot = handoffs();
    snapshot.validate().expect("snapshot should validate");
    snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .expect("snapshot context should validate");

    assert_eq!(snapshot.handoffs.len(), 2);
    assert_eq!(snapshot.interventions.len(), 2);
    assert!(snapshot
        .handoffs
        .iter()
        .any(|handoff| handoff.target.target_id == "spaces"));
    assert!(snapshot
        .handoffs
        .iter()
        .all(|handoff| !handoff.authority_transfer));
}

#[test]
fn restart_fixture_reconciles_evidence_without_repeating_work_or_effects() {
    let snapshot = restart();
    snapshot
        .validate()
        .expect("restart snapshot should validate");
    snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .expect("restart context should validate");
    assert_eq!(
        snapshot.reconciliation.state,
        FlowHandoffReconciliationState::Stale
    );
    assert!(snapshot
        .handoffs
        .iter()
        .any(|handoff| handoff.state == FlowProjectHandoffState::Stale));
    assert!(!snapshot.reconciliation.repeats_transfers);
    assert!(!snapshot.reconciliation.repeats_provider_work);
    assert!(!snapshot.reconciliation.repeats_external_effects);
    assert!(!snapshot.reconciliation.mutates_terminal_handoff_state);
}

#[test]
fn operation_fixture_matches_the_exact_closed_catalogue() {
    let fixture: FlowHandoffInterventionOperationCatalogue =
        serde_json::from_str(OPERATIONS).expect("operation fixture should decode");
    fixture
        .validate()
        .expect("operation fixture should validate");
    assert_eq!(fixture, flow_handoff_intervention_operation_catalogue());

    let serialized = serde_json::to_value(&fixture).expect("catalogue should serialize");
    let actual = serialized["operations"]
        .as_array()
        .expect("operations should be an array")
        .iter()
        .map(|operation| {
            operation["operationId"]
                .as_str()
                .expect("operation ID should be text")
        })
        .collect::<BTreeSet<_>>();
    assert_eq!(
        actual,
        BTreeSet::from([
            FLOW_PROJECT_HANDOFFS_LIST_OPERATION,
            FLOW_PROJECT_HANDOFF_REQUEST_OPERATION,
            FLOW_PROJECT_HANDOFF_DECIDE_OPERATION,
            FLOW_PROJECT_HANDOFF_OBSERVE_OPERATION,
            FLOW_PROJECT_HANDOFF_CANCEL_OPERATION,
            FLOW_PROJECT_HANDOFF_RECONCILE_OPERATION,
            FLOW_PROJECT_INTERVENTIONS_LIST_OPERATION,
            FLOW_PROJECT_INTERVENTION_RAISE_OPERATION,
            FLOW_PROJECT_INTERVENTION_ACKNOWLEDGE_OPERATION,
            FLOW_PROJECT_INTERVENTION_DECIDE_OPERATION,
            FLOW_PROJECT_INTERVENTION_RESOLVE_OPERATION,
        ])
    );
    assert!(fixture.operations.iter().all(|operation| {
        !operation.grants_application_authority
            && !operation.deletes_durable_history
            && !operation.repeats_transfer
            && !operation.repeats_external_effects
    }));
}

#[test]
fn exact_replay_is_idempotent_and_changed_content_collides() {
    let snapshot = handoffs();
    let existing = &snapshot.handoffs[0];
    assert_eq!(
        compare_flow_project_handoff_replay(existing, existing)
            .expect("exact replay should validate"),
        FlowProjectHandoffReplay::ExactReplay
    );

    let mut changed = existing.clone();
    changed.context_digest =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned();
    assert_eq!(
        compare_flow_project_handoff_replay(existing, &changed)
            .expect_err("changed content should collide")
            .code,
        "flow-handoff-idempotency-collision"
    );

    let mut new_request = existing.clone();
    new_request.idempotency_key = "idempotency/flow-agent-to-owner-session-new".to_owned();
    assert_eq!(
        compare_flow_project_handoff_replay(existing, &new_request)
            .expect("new key should be a new request"),
        FlowProjectHandoffReplay::New
    );
}

#[test]
fn handoff_lifecycle_requires_acceptance_transfer_and_receipt_evidence() {
    let mut snapshot = handoffs();
    snapshot.handoffs[0].received_at_unix_ms = None;
    assert!(snapshot.validate().is_err());

    let mut snapshot = restart();
    snapshot.handoffs[0].stale_reason = None;
    assert!(snapshot.validate().is_err());

    assert!(FlowProjectHandoffState::Prepared
        .allows_transition_to(FlowProjectHandoffState::ApprovalRequired));
    assert!(
        FlowProjectHandoffState::Received.allows_transition_to(FlowProjectHandoffState::Completed)
    );
    assert!(!FlowProjectHandoffState::Completed
        .allows_transition_to(FlowProjectHandoffState::Transferring));
}

#[test]
fn common_application_handoff_and_project_lifecycle_cannot_diverge() {
    let mut snapshot = handoffs();
    let application_handoff = snapshot.handoffs[1]
        .application_handoff
        .as_mut()
        .expect("current application target should carry common envelope");
    application_handoff.state = greenways_workspace_contracts::HandoffState::Ready;
    assert!(snapshot.validate().is_err());

    let mut snapshot = handoffs();
    snapshot.handoffs[1].target.target_id = "imagine".to_owned();
    assert!(snapshot.validate().is_err());

    let mut snapshot = handoffs();
    snapshot.handoffs[1].target.target_id = "build".to_owned();
    assert!(snapshot.validate().is_err());
}

#[test]
fn approval_required_handoff_has_exactly_one_current_human_review() {
    let mut snapshot = handoffs();
    snapshot.interventions.remove(0);
    assert!(snapshot.validate().is_err());

    let mut snapshot = handoffs();
    snapshot
        .interventions
        .push(snapshot.interventions[0].clone());
    snapshot.interventions[2].intervention_id =
        "intervention/flow-result-to-spaces-approval-duplicate".to_owned();
    assert!(snapshot.validate().is_err());
}

#[test]
fn agent_requests_require_the_exact_closed_mandate_capability() {
    let mut without_handoff_capability = participation();
    without_handoff_capability.agent_mandates[0]
        .capabilities
        .retain(|capability| *capability != FlowAgentMandateCapability::HandoffRequest);
    assert!(handoffs()
        .validate_against_context(&without_handoff_capability, &coordination(), &presence(),)
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

#[test]
fn project_local_targets_and_claim_context_must_resolve_exactly() {
    let mut snapshot = handoffs();
    snapshot.handoffs[0].target.target_id = "session/not-present".to_owned();
    assert!(snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .is_err());

    let mut snapshot = handoffs();
    snapshot.handoffs[0].claim_id = Some("claim/not-present".to_owned());
    assert!(snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .is_err());

    let mut snapshot = handoffs();
    snapshot.handoffs[0].project_id = "project/other".to_owned();
    assert!(snapshot.validate().is_err());
}

#[test]
fn intervention_decision_and_resolution_are_distinct_human_evidence() {
    let mut snapshot = handoffs();
    let review = &mut snapshot.interventions[0];
    review.state = FlowProjectInterventionState::Approved;
    review.decision = Some(FlowProjectInterventionDecision::Approve);
    review.decided_at_unix_ms = Some(1787275480000);
    review.decided_by_membership_id = Some("membership/flow-owner".to_owned());
    let handoff = &mut snapshot.handoffs[1];
    handoff.state = FlowProjectHandoffState::Ready;
    handoff.approved_at_unix_ms = Some(1787275480000);
    handoff
        .application_handoff
        .as_mut()
        .expect("application handoff should exist")
        .state = greenways_workspace_contracts::HandoffState::Ready;
    snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .expect("human approval should validate without claiming resolution");
    assert!(snapshot.interventions[0].resolution_reference.is_none());

    snapshot.interventions[0].decided_by_membership_id =
        Some("membership/flow-agent-builder".to_owned());
    assert!(snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .is_err());
}

#[test]
fn resolved_intervention_requires_exact_project_owned_resolution_evidence() {
    let mut snapshot = handoffs();
    let blocker = &mut snapshot.interventions[1];
    blocker.state = FlowProjectInterventionState::Resolved;
    blocker.acknowledged_at_unix_ms = Some(1787275520000);
    blocker.acknowledged_by_membership_id = Some("membership/flow-owner".to_owned());
    blocker.resolution_reference = Some(snapshot.handoffs[1].included_references[0].clone());
    blocker.resolved_at_unix_ms = Some(1787275540000);
    blocker.resolved_by_membership_id = Some("membership/flow-owner".to_owned());
    snapshot
        .validate_against_context(&participation(), &coordination(), &presence())
        .expect("project-owned resolution evidence should validate");

    snapshot.interventions[1].resolution_reference = None;
    assert!(snapshot.validate().is_err());
}

#[test]
fn reconciliation_cannot_repeat_transfer_provider_work_or_external_effects() {
    let mut snapshot = handoffs();
    snapshot.reconciliation.repeats_transfers = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = handoffs();
    snapshot.reconciliation.repeats_provider_work = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = handoffs();
    snapshot.reconciliation.repeats_external_effects = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = handoffs();
    snapshot.reconciliation.mutates_terminal_handoff_state = true;
    assert!(snapshot.validate().is_err());
}

#[test]
fn authority_credentials_work_state_and_effect_replay_fail_closed() {
    let mut snapshot = handoffs();
    snapshot.handoffs[0].authority_transfer = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = handoffs();
    snapshot.handoffs[0].carries_provider_credentials = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = handoffs();
    snapshot.handoffs[0].copies_work_runtime_state = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = handoffs();
    snapshot.interventions[1].mutates_external_effect = true;
    assert!(snapshot.validate().is_err());
}

#[test]
fn unknown_fields_and_unknown_operations_fail_closed() {
    let mut value: Value = serde_json::from_str(HANDOFFS).expect("fixture should parse");
    value["providerHandle"] = json!("native://unbounded");
    assert!(serde_json::from_value::<FlowProjectHandoffInterventionSnapshot>(value).is_err());

    let mut value: Value = serde_json::from_str(OPERATIONS).expect("fixture should parse");
    value["operations"][0]["operationId"] = json!("flow.project.handoff.invoke-provider");
    assert!(serde_json::from_value::<FlowHandoffInterventionOperationCatalogue>(value).is_err());
}

#[test]
fn application_and_operation_catalogues_expose_flow_and_spaces_only() {
    let snapshot = handoffs();
    assert_eq!(snapshot.application_id, CurrentApplicationId::Flow);
    let serialized = serde_json::to_string(&snapshot).expect("snapshot should serialize");
    for forbidden in ["\"build\"", "\"foreman\"", "\"imagine\"", "\"world\""] {
        assert!(!serialized.contains(forbidden));
    }
    let catalogue = flow_handoff_intervention_operation_catalogue();
    assert!(catalogue
        .operations
        .iter()
        .all(|operation| operation.application_id == CurrentApplicationId::Flow));
}
