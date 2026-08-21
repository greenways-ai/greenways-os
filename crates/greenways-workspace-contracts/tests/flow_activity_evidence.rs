use greenways_workspace_contracts::{
    flow_activity_evidence_operation_catalogue, CurrentApplicationId,
    FlowActivityEvidenceOperationCatalogue, FlowAgentMandateCapability, FlowExternalReadbackState,
    FlowProjectActivityEvidenceSnapshot, FlowProjectArtifactState,
    FlowProjectHandoffInterventionSnapshot, FlowProjectParticipationSnapshot,
    FlowProjectPresenceSnapshot, FlowWorkCoordinationSnapshot, ReferenceAuthorityState,
    ReferenceFreshness, FLOW_PROJECT_ACTIVITY_LIST_OPERATION,
    FLOW_PROJECT_ARTIFACTS_LIST_OPERATION, FLOW_PROJECT_ARTIFACT_REJECT_OPERATION,
    FLOW_PROJECT_ARTIFACT_REPORT_OPERATION, FLOW_PROJECT_ARTIFACT_SELECT_OPERATION,
    FLOW_PROJECT_EXTERNAL_READBACKS_LIST_OPERATION,
    FLOW_PROJECT_EXTERNAL_READBACK_MARK_UNCERTAIN_OPERATION,
    FLOW_PROJECT_EXTERNAL_READBACK_OBSERVE_OPERATION,
    FLOW_PROJECT_EXTERNAL_READBACK_VERIFY_OPERATION,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const PARTICIPATION: &str = include_str!("fixtures/flow/project-participation.json");
const COORDINATION: &str = include_str!("fixtures/flow/work-coordination.json");
const PRESENCE: &str = include_str!("fixtures/flow/project-presence.json");
const HANDOFFS: &str = include_str!("fixtures/flow/project-handoffs-interventions.json");
const EVIDENCE: &str = include_str!("fixtures/flow/project-activity-evidence.json");
const RESTART: &str = include_str!("fixtures/flow/project-activity-evidence-restart.json");
const OPERATIONS: &str = include_str!("fixtures/flow/activity-evidence-operation-catalogue.json");

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
    serde_json::from_str(HANDOFFS).expect("handoff fixture should decode")
}

fn evidence() -> FlowProjectActivityEvidenceSnapshot {
    serde_json::from_str(EVIDENCE).expect("activity/evidence fixture should decode")
}

fn restart() -> FlowProjectActivityEvidenceSnapshot {
    serde_json::from_str(RESTART).expect("restart activity fixture should decode")
}

#[test]
fn canonical_activity_and_evidence_validate_against_exact_project_context() {
    let snapshot = evidence();
    snapshot
        .validate()
        .expect("evidence snapshot should validate");
    snapshot
        .validate_against_context(&participation(), &coordination(), &presence(), &handoffs())
        .expect("evidence context should validate");

    assert_eq!(snapshot.artifacts.len(), 1);
    assert_eq!(snapshot.external_readbacks.len(), 1);
    assert_eq!(
        snapshot.artifacts[0].state,
        FlowProjectArtifactState::Verified
    );
    assert_eq!(
        snapshot.external_readbacks[0].state,
        FlowExternalReadbackState::Verified
    );
    assert!(snapshot.rebuilds_projection_only);
}

#[test]
fn restart_preserves_uncertainty_without_replaying_work_or_effects() {
    let snapshot = restart();
    snapshot
        .validate()
        .expect("restart snapshot should validate");
    snapshot
        .validate_against_context(&participation(), &coordination(), &presence(), &handoffs())
        .expect("restart evidence context should validate");

    assert_eq!(
        snapshot.artifacts[0].state,
        FlowProjectArtifactState::VerificationPending
    );
    assert_eq!(
        snapshot.external_readbacks[0].state,
        FlowExternalReadbackState::Uncertain
    );
    assert!(!snapshot.repeats_provider_work);
    assert!(!snapshot.repeats_work_runtime);
    assert!(!snapshot.repeats_handoff_transfer);
    assert!(!snapshot.repeats_external_effects);
}

#[test]
fn operation_fixture_matches_the_exact_closed_catalogue() {
    let fixture: FlowActivityEvidenceOperationCatalogue =
        serde_json::from_str(OPERATIONS).expect("operation fixture should decode");
    fixture
        .validate()
        .expect("operation fixture should validate");
    assert_eq!(fixture, flow_activity_evidence_operation_catalogue());

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
            FLOW_PROJECT_ARTIFACTS_LIST_OPERATION,
            FLOW_PROJECT_ARTIFACT_REPORT_OPERATION,
            FLOW_PROJECT_ARTIFACT_SELECT_OPERATION,
            FLOW_PROJECT_ARTIFACT_REJECT_OPERATION,
            FLOW_PROJECT_EXTERNAL_READBACKS_LIST_OPERATION,
            FLOW_PROJECT_EXTERNAL_READBACK_OBSERVE_OPERATION,
            FLOW_PROJECT_EXTERNAL_READBACK_VERIFY_OPERATION,
            FLOW_PROJECT_EXTERNAL_READBACK_MARK_UNCERTAIN_OPERATION,
            FLOW_PROJECT_ACTIVITY_LIST_OPERATION,
        ])
    );
    assert!(fixture.operations.iter().all(|operation| {
        !operation.grants_application_authority
            && !operation.deletes_durable_history
            && !operation.repeats_provider_work
            && !operation.repeats_work_runtime
            && !operation.repeats_handoff_transfer
            && !operation.repeats_external_effects
    }));
}

#[test]
fn artifact_report_availability_selection_and_verification_remain_distinct() {
    let mut snapshot = evidence();
    snapshot.artifacts[0].exact_root = None;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.artifacts[0].state = FlowProjectArtifactState::Selected;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.artifacts[0].selected_at_unix_ms = None;
    assert!(snapshot.validate().is_err());

    assert!(FlowProjectArtifactState::Reported
        .allows_transition_to(FlowProjectArtifactState::Available));
    assert!(FlowProjectArtifactState::Selected
        .allows_transition_to(FlowProjectArtifactState::VerificationPending));
    assert!(!FlowProjectArtifactState::Reported
        .allows_transition_to(FlowProjectArtifactState::Verified));
}

#[test]
fn provider_acceptance_is_not_external_effect_verification() {
    let mut snapshot = evidence();
    let artifact = &mut snapshot.artifacts[0];
    artifact.state = FlowProjectArtifactState::VerificationPending;
    artifact.verified_at_unix_ms = None;
    let readback = &mut snapshot.external_readbacks[0];
    readback.state = FlowExternalReadbackState::ProviderAccepted;
    readback.observed_at_unix_ms = None;
    readback.verified_at_unix_ms = None;
    readback.verification_method = None;
    readback.readback_reference = None;
    snapshot.activity.remove(3);
    snapshot.activity[3].sequence = 4;
    snapshot.activity[3].causal_predecessor_activity_id =
        Some("activity/flow-readback-observed".to_owned());
    snapshot
        .validate()
        .expect("provider acceptance may remain verification-pending");

    snapshot.artifacts[0].state = FlowProjectArtifactState::Verified;
    snapshot.artifacts[0].verified_at_unix_ms = Some(1787275900000);
    assert!(snapshot.validate().is_err());
}

#[test]
fn verified_effect_requires_exact_current_authoritative_readback() {
    let mut snapshot = evidence();
    snapshot.external_readbacks[0]
        .readback_reference
        .as_mut()
        .expect("reference should exist")
        .freshness = ReferenceFreshness::Stale;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.external_readbacks[0]
        .readback_reference
        .as_mut()
        .expect("reference should exist")
        .authority_state = ReferenceAuthorityState::ResolutionRequired;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.external_readbacks[0]
        .readback_reference
        .as_mut()
        .expect("reference should exist")
        .exact_root = None;
    assert!(snapshot.validate().is_err());
}

#[test]
fn artifact_selection_requires_an_active_human_owner_or_coordinator() {
    let mut snapshot = evidence();
    snapshot.artifacts[0].selected_by_membership_id =
        Some("membership/flow-agent-builder".to_owned());
    assert!(snapshot
        .validate_against_context(&participation(), &coordination(), &presence(), &handoffs(),)
        .is_err());
}

#[test]
fn agent_reports_and_observations_require_exact_mandate_capabilities() {
    let mut without_artifact_report = participation();
    without_artifact_report.agent_mandates[0]
        .capabilities
        .retain(|capability| *capability != FlowAgentMandateCapability::ArtifactReport);
    assert!(evidence()
        .validate_against_context(
            &without_artifact_report,
            &coordination(),
            &presence(),
            &handoffs(),
        )
        .is_err());

    let mut agent_observed = evidence();
    agent_observed.external_readbacks[0].observer = agent_observed.artifacts[0].producer.clone();
    let mut without_evidence_observe = participation();
    without_evidence_observe.agent_mandates[0]
        .capabilities
        .retain(|capability| *capability != FlowAgentMandateCapability::EvidenceObserve);
    assert!(agent_observed
        .validate_against_context(
            &without_evidence_observe,
            &coordination(),
            &presence(),
            &handoffs(),
        )
        .is_err());
}

#[test]
fn artifact_work_claim_and_readback_links_resolve_exactly() {
    let mut snapshot = evidence();
    snapshot.artifacts[0].work_id = "work/not-present".to_owned();
    assert!(snapshot
        .validate_against_context(&participation(), &coordination(), &presence(), &handoffs(),)
        .is_err());

    let mut snapshot = evidence();
    snapshot.artifacts[0].claim_id = Some("claim/not-present".to_owned());
    assert!(snapshot
        .validate_against_context(&participation(), &coordination(), &presence(), &handoffs(),)
        .is_err());

    let mut snapshot = evidence();
    snapshot.external_readbacks[0].artifact_id = Some("artifact/not-present".to_owned());
    assert!(snapshot.validate().is_err());
}

#[test]
fn activity_is_append_ordered_unique_and_causally_backward_only() {
    let mut snapshot = evidence();
    snapshot.activity[1].sequence = snapshot.activity[0].sequence;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.activity[1].event_digest = snapshot.activity[0].event_digest.clone();
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.activity[1].causal_predecessor_activity_id = Some("activity/not-earlier".to_owned());
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.activity.swap(0, 1);
    assert!(snapshot.validate().is_err());
}

#[test]
fn selected_and_verified_records_require_matching_append_activity() {
    let mut snapshot = evidence();
    snapshot.activity.retain(|entry| {
        entry.kind != greenways_workspace_contracts::FlowProjectActivityKind::ArtifactSelected
    });
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.activity.retain(|entry| {
        entry.kind != greenways_workspace_contracts::FlowProjectActivityKind::ExternalEffectVerified
    });
    assert!(snapshot.validate().is_err());
}

#[test]
fn projection_rebuild_cannot_repeat_work_transfer_provider_or_effects() {
    let mut snapshot = evidence();
    snapshot.repeats_work_runtime = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.repeats_handoff_transfer = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.repeats_provider_work = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.repeats_external_effects = true;
    assert!(snapshot.validate().is_err());
}

#[test]
fn authority_credentials_private_references_and_payload_bytes_fail_closed() {
    let mut snapshot = evidence();
    snapshot.artifacts[0].authority_transfer = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.artifacts[0].contains_artifact_bytes = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.external_readbacks[0].carries_provider_credentials = true;
    assert!(snapshot.validate().is_err());

    let mut snapshot = evidence();
    snapshot.activity[0].mutates_source_record = true;
    assert!(snapshot.validate().is_err());
}

#[test]
fn unknown_fields_unknown_operations_and_non_flow_ownership_fail_closed() {
    let mut value: Value = serde_json::from_str(EVIDENCE).expect("fixture should parse");
    value["providerHandle"] = json!("native://unbounded");
    assert!(serde_json::from_value::<FlowProjectActivityEvidenceSnapshot>(value).is_err());

    let mut value: Value = serde_json::from_str(OPERATIONS).expect("fixture should parse");
    value["operations"][0]["operationId"] = json!("flow.project.external-readback.invoke-provider");
    assert!(serde_json::from_value::<FlowActivityEvidenceOperationCatalogue>(value).is_err());

    let mut snapshot = evidence();
    snapshot.application_id = CurrentApplicationId::Spaces;
    assert!(snapshot.validate().is_err());
}

#[test]
fn current_evidence_exposes_no_legacy_or_future_application_identity() {
    let serialized = serde_json::to_string(&evidence()).expect("snapshot should serialize");
    for forbidden in [
        "\"applicationId\":\"build\"",
        "\"applicationId\":\"foreman\"",
        "\"applicationId\":\"imagine\"",
        "\"applicationId\":\"world\"",
    ] {
        assert!(!serialized.contains(forbidden));
    }
    assert!(flow_activity_evidence_operation_catalogue()
        .operations
        .iter()
        .all(|operation| operation.application_id == CurrentApplicationId::Flow));
}
