use greenways_workspace_contracts::{
    flow_presence_operation_catalogue, FlowAgentMandateState, FlowHostObservationState,
    FlowPresenceOperationCatalogue, FlowPresenceReconciliationState,
    FlowProjectHostAttachmentState, FlowProjectMemberState, FlowProjectParticipationSnapshot,
    FlowProjectPresenceSnapshot, FlowSessionActivityState, FlowSessionPresenceState,
    FlowWorkCoordinationSnapshot, FlowWorkState, FLOW_PROJECT_HOSTS_LIST_OPERATION,
    FLOW_PROJECT_HOST_ATTACH_OPERATION, FLOW_PROJECT_HOST_DETACH_OPERATION,
    FLOW_PROJECT_HOST_OBSERVE_OPERATION, FLOW_PROJECT_SESSIONS_LIST_OPERATION,
    FLOW_PROJECT_SESSION_ATTACH_OPERATION, FLOW_PROJECT_SESSION_DISCONNECT_OPERATION,
    FLOW_PROJECT_SESSION_OBSERVE_OPERATION, FLOW_PROJECT_SESSION_RECONCILE_OPERATION,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const PARTICIPATION_FIXTURE: &str = include_str!("fixtures/flow/project-participation.json");
const COORDINATION_FIXTURE: &str = include_str!("fixtures/flow/work-coordination.json");
const PRESENCE_FIXTURE: &str = include_str!("fixtures/flow/project-presence.json");
const RESTART_FIXTURE: &str = include_str!("fixtures/flow/project-presence-restart.json");
const OPERATION_FIXTURE: &str = include_str!("fixtures/flow/presence-operation-catalogue.json");

fn participation_fixture() -> FlowProjectParticipationSnapshot {
    serde_json::from_str(PARTICIPATION_FIXTURE).expect("participation fixture should decode")
}

fn coordination_fixture() -> FlowWorkCoordinationSnapshot {
    serde_json::from_str(COORDINATION_FIXTURE).expect("coordination fixture should decode")
}

fn presence_fixture() -> FlowProjectPresenceSnapshot {
    serde_json::from_str(PRESENCE_FIXTURE).expect("presence fixture should decode")
}

fn restart_fixture() -> FlowProjectPresenceSnapshot {
    serde_json::from_str(RESTART_FIXTURE).expect("restart fixture should decode")
}

#[test]
fn canonical_presence_and_restart_fixtures_validate_against_current_context() {
    let participation = participation_fixture();
    let coordination = coordination_fixture();

    let presence = presence_fixture();
    presence
        .validate_against_context(&participation, &coordination)
        .expect("active project presence should validate");
    assert_eq!(
        presence.reconciliation.state,
        FlowPresenceReconciliationState::Current
    );
    assert_eq!(presence.host_attachments.len(), 2);
    assert_eq!(presence.sessions.len(), 2);

    let restart = restart_fixture();
    restart
        .validate_against_context(&participation, &coordination)
        .expect("restart reconciliation should validate without repeating work");
    assert_eq!(
        restart.reconciliation.state,
        FlowPresenceReconciliationState::ResyncRequired
    );
    assert!(restart
        .sessions
        .iter()
        .all(|session| session.activity_state == FlowSessionActivityState::Unknown));
}

#[test]
fn claim_and_session_presence_are_independent_dimensions() {
    let participation = participation_fixture();
    let coordination = coordination_fixture();

    let mut claim_without_session = presence_fixture();
    claim_without_session
        .sessions
        .retain(|session| session.claim_id.is_none());
    claim_without_session
        .validate_against_context(&participation, &coordination)
        .expect("an active claim does not require an observed session");
    assert_eq!(coordination.claims.len(), 1);
    assert!(claim_without_session.sessions.iter().any(|session| {
        session.presence_state == FlowSessionPresenceState::Connected && session.claim_id.is_none()
    }));

    let mut no_sessions = presence_fixture();
    no_sessions.sessions.clear();
    no_sessions
        .validate_against_context(&participation, &coordination)
        .expect("presence snapshot may observe no sessions while claims remain durable");
}

#[test]
fn project_host_attachment_is_not_host_presence_or_execution_authority() {
    let presence = presence_fixture();
    let desktop = &presence.host_attachments[0];
    assert_eq!(desktop.state, FlowProjectHostAttachmentState::Attached);
    assert_eq!(desktop.observation_state, FlowHostObservationState::Ready);
    assert!(!desktop.authority_transfer);
    assert!(!desktop.exposes_host_wide_authority);
    assert!(!desktop.grants_execution_lease);

    let mut unavailable = presence;
    unavailable.host_attachments[1].observation_state = FlowHostObservationState::Offline;
    assert!(unavailable.validate().is_err());

    let restart = restart_fixture();
    assert_eq!(
        restart.host_attachments[0].state,
        FlowProjectHostAttachmentState::Attached
    );
    assert_eq!(
        restart.host_attachments[0].observation_state,
        FlowHostObservationState::Unknown
    );
}

#[test]
fn session_context_references_fail_closed() {
    let participation = participation_fixture();
    let coordination = coordination_fixture();

    let mut cross_project = presence_fixture();
    cross_project.sessions[0].project_id = "project/other".to_owned();
    assert!(cross_project
        .validate_against_context(&participation, &coordination)
        .is_err());

    let mut unknown_host = presence_fixture();
    unknown_host.sessions[0].host_attachment_id = "attachment/unknown".to_owned();
    assert!(unknown_host
        .validate_against_context(&participation, &coordination)
        .is_err());

    let mut unknown_work = presence_fixture();
    unknown_work.sessions[1].work_id = Some("work/unknown".to_owned());
    unknown_work.sessions[1].claim_id = None;
    assert!(unknown_work
        .validate_against_context(&participation, &coordination)
        .is_err());

    let mut wrong_claimant = presence_fixture();
    wrong_claimant.sessions[1].membership_id = "membership/flow-owner".to_owned();
    wrong_claimant.sessions[1].agent_mandate_id = None;
    assert!(wrong_claimant
        .validate_against_context(&participation, &coordination)
        .is_err());
}

#[test]
fn current_agent_sessions_require_exact_active_mandates() {
    let coordination = coordination_fixture();

    let mut no_mandate = participation_fixture();
    no_mandate.agent_mandates.clear();
    assert!(presence_fixture()
        .validate_against_context(&no_mandate, &coordination)
        .is_err());

    let mut suspended = participation_fixture();
    suspended.agent_mandates[0].state = FlowAgentMandateState::Suspended;
    assert!(presence_fixture()
        .validate_against_context(&suspended, &coordination)
        .is_err());

    let mut person_with_mandate = presence_fixture();
    person_with_mandate.sessions[0].agent_mandate_id =
        Some("mandate/flow-agent-builder-current".to_owned());
    assert!(person_with_mandate
        .validate_against_context(&participation_fixture(), &coordination)
        .is_err());

    let mut inactive_member = participation_fixture();
    inactive_member.members[1].state = FlowProjectMemberState::Suspended;
    assert!(presence_fixture()
        .validate_against_context(&inactive_member, &coordination)
        .is_err());
}

#[test]
fn current_session_cannot_survive_a_terminal_host_attachment() {
    let participation = participation_fixture();
    let coordination = coordination_fixture();
    let mut presence = presence_fixture();

    presence.host_attachments[1].state = FlowProjectHostAttachmentState::Detached;
    presence.host_attachments[1].observation_state = FlowHostObservationState::Offline;
    presence.host_attachments[1].detached_at_unix_ms = Some(1787275100000);

    assert!(presence
        .validate_against_context(&participation, &coordination)
        .is_err());
}

#[test]
fn restart_evidence_never_changes_work_outcome_or_repeats_provider_work() {
    let participation = participation_fixture();
    let coordination = coordination_fixture();
    let restart = restart_fixture();

    restart
        .validate_against_context(&participation, &coordination)
        .expect("restart reconciliation should validate");
    assert_eq!(
        coordination.work[1].state,
        FlowWorkState::Running,
        "stale session evidence must not complete its work"
    );
    assert!(!restart.reconciliation.repeats_provider_work);
    assert!(!restart.reconciliation.repeats_external_effects);
    assert!(!restart.reconciliation.mutates_work_outcome);
    assert!(!restart.reconciliation.authority_transfer);

    let mut invalid = restart;
    invalid.reconciliation.repeats_provider_work = true;
    assert!(invalid.validate().is_err());
}

#[test]
fn duplicate_current_hosts_and_sessions_are_rejected() {
    let mut duplicate_host = presence_fixture();
    let mut second_attachment = duplicate_host.host_attachments[0].clone();
    second_attachment.attachment_id = "attachment/flow-owner-desktop-copy".to_owned();
    second_attachment.revision += 1;
    duplicate_host.host_attachments.push(second_attachment);
    assert!(duplicate_host.validate().is_err());

    let mut duplicate_session = presence_fixture();
    let mut next_generation = duplicate_session.sessions[0].clone();
    next_generation.revision += 1;
    next_generation.session_generation += 1;
    duplicate_session.sessions.push(next_generation);
    assert!(duplicate_session.validate().is_err());
}

#[test]
fn provider_secrets_urls_and_native_handles_are_not_schema_fields() {
    for field in [
        "conversationUrl",
        "providerCookie",
        "credential",
        "nativeHandle",
        "shellCommand",
    ] {
        let mut value: Value =
            serde_json::from_str(PRESENCE_FIXTURE).expect("fixture JSON should parse");
        value["sessions"][0][field] = json!("forbidden");
        assert!(
            serde_json::from_value::<FlowProjectPresenceSnapshot>(value).is_err(),
            "unknown sensitive field {field} must fail closed"
        );
    }
}

#[test]
fn operation_fixture_matches_the_exact_closed_catalogue() {
    let fixture: FlowPresenceOperationCatalogue =
        serde_json::from_str(OPERATION_FIXTURE).expect("operation fixture should decode");
    fixture
        .validate()
        .expect("operation fixture should validate");
    assert_eq!(fixture, flow_presence_operation_catalogue());

    let expected = BTreeSet::from([
        FLOW_PROJECT_HOSTS_LIST_OPERATION,
        FLOW_PROJECT_HOST_ATTACH_OPERATION,
        FLOW_PROJECT_HOST_OBSERVE_OPERATION,
        FLOW_PROJECT_HOST_DETACH_OPERATION,
        FLOW_PROJECT_SESSIONS_LIST_OPERATION,
        FLOW_PROJECT_SESSION_ATTACH_OPERATION,
        FLOW_PROJECT_SESSION_OBSERVE_OPERATION,
        FLOW_PROJECT_SESSION_DISCONNECT_OPERATION,
        FLOW_PROJECT_SESSION_RECONCILE_OPERATION,
    ]);
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
    assert_eq!(actual, expected);
    assert!(fixture.operations.iter().all(|operation| {
        !operation.grants_application_authority
            && !operation.grants_execution_lease
            && !operation.carries_provider_credentials
            && !operation.repeats_provider_work
            && !operation.mutates_work_outcome
    }));
}

#[test]
fn operation_metadata_order_and_identity_cannot_drift() {
    let mut catalogue = flow_presence_operation_catalogue();
    catalogue.operations[0].grants_execution_lease = true;
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_presence_operation_catalogue();
    catalogue.operations.pop();
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_presence_operation_catalogue();
    catalogue.operations.swap(0, 1);
    assert!(catalogue.validate().is_err());

    let mut value: Value =
        serde_json::from_str(OPERATION_FIXTURE).expect("fixture JSON should parse");
    value["operations"][0]["operationId"] = json!("flow.project.host.shell");
    assert!(serde_json::from_value::<FlowPresenceOperationCatalogue>(value).is_err());
}

#[test]
fn presence_and_attachment_lifecycles_are_closed() {
    assert!(FlowProjectHostAttachmentState::Attached
        .allows_transition_to(FlowProjectHostAttachmentState::Stale));
    assert!(FlowProjectHostAttachmentState::Stale
        .allows_transition_to(FlowProjectHostAttachmentState::Attached));
    assert!(!FlowProjectHostAttachmentState::Detached
        .allows_transition_to(FlowProjectHostAttachmentState::Attached));

    assert!(FlowSessionPresenceState::Attached
        .allows_transition_to(FlowSessionPresenceState::Connected));
    assert!(FlowSessionPresenceState::Disconnected
        .allows_transition_to(FlowSessionPresenceState::Connected));
    assert!(
        !FlowSessionPresenceState::Closed.allows_transition_to(FlowSessionPresenceState::Connected)
    );
    assert!(!FlowSessionPresenceState::Revoked
        .allows_transition_to(FlowSessionPresenceState::Connected));
}

#[test]
fn legacy_and_future_application_ids_remain_outside_presence_contracts() {
    let serialized = serde_json::to_string(&presence_fixture()).expect("presence should serialize");
    for forbidden in [
        "\"applicationId\":\"build\"",
        "\"applicationId\":\"foreman\"",
        "\"applicationId\":\"imagine\"",
        "\"applicationId\":\"world\"",
    ] {
        assert!(!serialized.contains(forbidden));
    }

    for application_id in ["build", "foreman", "imagine", "world"] {
        let mut value: Value =
            serde_json::from_str(PRESENCE_FIXTURE).expect("fixture JSON should parse");
        value["applicationId"] = json!(application_id);
        assert!(serde_json::from_value::<FlowProjectPresenceSnapshot>(value).is_err());
    }
}

#[test]
fn stale_reconciliation_requires_stale_or_unknown_evidence() {
    let mut presence = presence_fixture();
    presence.reconciliation.state = FlowPresenceReconciliationState::Stale;
    assert!(presence.validate().is_err());

    let restart = restart_fixture();
    assert!(restart
        .host_attachments
        .iter()
        .any(|host| host.state == FlowProjectHostAttachmentState::Stale));
}
