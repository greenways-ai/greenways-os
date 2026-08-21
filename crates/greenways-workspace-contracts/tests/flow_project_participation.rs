use greenways_workspace_contracts::{
    flow_participation_operation_catalogue, CurrentApplicationId, FlowAgentMandateState,
    FlowParticipationOperationCatalogue, FlowParticipationOperationId, FlowProjectMemberRole,
    FlowProjectMemberState, FlowProjectParticipationSnapshot, FLOW_PROJECT_AGENTS_LIST_OPERATION,
    FLOW_PROJECT_AGENT_ADD_OPERATION, FLOW_PROJECT_AGENT_REVOKE_OPERATION,
    FLOW_PROJECT_AGENT_UPDATE_OPERATION, FLOW_PROJECT_MEMBERS_LIST_OPERATION,
    FLOW_PROJECT_MEMBER_ADD_OPERATION, FLOW_PROJECT_MEMBER_REMOVE_OPERATION,
    FLOW_PROJECT_MEMBER_UPDATE_OPERATION,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const PARTICIPATION_FIXTURE: &str = include_str!("fixtures/flow/project-participation.json");
const OPERATION_FIXTURE: &str =
    include_str!("fixtures/flow/participation-operation-catalogue.json");

fn participation() -> FlowProjectParticipationSnapshot {
    serde_json::from_str(PARTICIPATION_FIXTURE)
        .expect("Flow project participation fixture should decode")
}

#[test]
fn canonical_participation_fixture_validates() {
    let fixture = participation();
    fixture
        .validate()
        .expect("canonical Flow participation should validate");
    assert_eq!(fixture.application_id, CurrentApplicationId::Flow);
    assert_eq!(fixture.members.len(), 2);
    assert_eq!(fixture.agent_mandates.len(), 1);
    assert_eq!(fixture.members[0].role, FlowProjectMemberRole::Owner);
    assert!(!fixture.members[0].authority_transfer);
    assert!(!fixture.agent_mandates[0].authority_transfer);
}

#[test]
fn participation_operation_fixture_matches_the_closed_catalogue() {
    let fixture: FlowParticipationOperationCatalogue = serde_json::from_str(OPERATION_FIXTURE)
        .expect("participation operation fixture should decode");
    fixture
        .validate()
        .expect("participation operation fixture should validate");
    assert_eq!(fixture, flow_participation_operation_catalogue());

    let expected = BTreeSet::from([
        FLOW_PROJECT_MEMBERS_LIST_OPERATION,
        FLOW_PROJECT_MEMBER_ADD_OPERATION,
        FLOW_PROJECT_MEMBER_UPDATE_OPERATION,
        FLOW_PROJECT_MEMBER_REMOVE_OPERATION,
        FLOW_PROJECT_AGENTS_LIST_OPERATION,
        FLOW_PROJECT_AGENT_ADD_OPERATION,
        FLOW_PROJECT_AGENT_UPDATE_OPERATION,
        FLOW_PROJECT_AGENT_REVOKE_OPERATION,
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
}

#[test]
fn project_requires_one_active_human_owner() {
    let mut fixture = participation();
    fixture.members[0].state = FlowProjectMemberState::Suspended;
    assert_eq!(
        fixture
            .validate()
            .expect_err("a current project requires an active human owner")
            .code,
        "missing-active-human-flow-owner"
    );

    let mut fixture = participation();
    fixture.members[1].role = FlowProjectMemberRole::Owner;
    assert_eq!(
        fixture
            .validate()
            .expect_err("an agent cannot own the project")
            .code,
        "agent-cannot-own-flow-project"
    );
}

#[test]
fn duplicate_memberships_and_principals_fail_closed() {
    let mut fixture = participation();
    fixture.members.push(fixture.members[0].clone());
    assert_eq!(
        fixture
            .validate()
            .expect_err("duplicate membership ID should fail")
            .code,
        "duplicate-flow-membership-id"
    );

    let mut fixture = participation();
    let mut duplicate = fixture.members[0].clone();
    duplicate.membership_id = "membership/duplicate-owner".to_owned();
    fixture.members.push(duplicate);
    assert_eq!(
        fixture
            .validate()
            .expect_err("duplicate principal should fail")
            .code,
        "duplicate-flow-project-principal"
    );
}

#[test]
fn participation_records_cannot_cross_projects() {
    let mut fixture = participation();
    fixture.members[1].project_id = "project/other".to_owned();
    assert_eq!(
        fixture
            .validate()
            .expect_err("member cannot cross projects")
            .code,
        "cross-project-flow-membership"
    );

    let mut fixture = participation();
    fixture.agent_mandates[0].project_id = "project/other".to_owned();
    assert_eq!(
        fixture
            .validate()
            .expect_err("mandate cannot cross projects")
            .code,
        "cross-project-flow-mandate"
    );
}

#[test]
fn mandates_require_the_exact_agent_membership() {
    let mut fixture = participation();
    fixture.agent_mandates[0].membership_id = "membership/missing".to_owned();
    assert_eq!(
        fixture
            .validate()
            .expect_err("orphaned mandate should fail")
            .code,
        "orphaned-flow-agent-mandate"
    );

    let mut fixture = participation();
    fixture.agent_mandates[0].agent_id = "agent/other".to_owned();
    assert_eq!(
        fixture
            .validate()
            .expect_err("mandate agent identity should match membership")
            .code,
        "flow-agent-mandate-principal-mismatch"
    );

    let mut fixture = participation();
    let mut duplicate = fixture.agent_mandates[0].clone();
    duplicate.mandate_id = "mandate/flow-agent-builder-second".to_owned();
    fixture.agent_mandates.push(duplicate);
    assert_eq!(
        fixture
            .validate()
            .expect_err("two current mandates should fail")
            .code,
        "duplicate-current-flow-agent-mandate"
    );
}

#[test]
fn revoked_membership_cannot_retain_a_current_mandate() {
    let mut fixture = participation();
    fixture.members[1].state = FlowProjectMemberState::Revoked;
    fixture.members[1].revoked_at_unix_ms = Some(1787270700000);
    assert_eq!(
        fixture
            .validate()
            .expect_err("revoked member cannot retain an active mandate")
            .code,
        "flow-agent-mandate-membership-state-mismatch"
    );
}

#[test]
fn lifecycle_evidence_and_authority_fail_closed() {
    let mut fixture = participation();
    fixture.members[1].activated_at_unix_ms = None;
    assert_eq!(
        fixture
            .validate()
            .expect_err("active membership requires activation evidence")
            .code,
        "flow-membership-state-time-mismatch"
    );

    let mut fixture = participation();
    fixture.agent_mandates[0].state = FlowAgentMandateState::Revoked;
    assert_eq!(
        fixture
            .validate()
            .expect_err("revoked mandate requires revocation evidence")
            .code,
        "flow-mandate-state-time-mismatch"
    );

    let mut fixture = participation();
    fixture.members[0].authority_transfer = true;
    assert_eq!(
        fixture
            .validate()
            .expect_err("membership cannot transfer authority")
            .code,
        "flow-membership-authority-transfer"
    );

    let mut fixture = participation();
    fixture.agent_mandates[0].authority_transfer = true;
    assert_eq!(
        fixture
            .validate()
            .expect_err("mandate cannot transfer authority")
            .code,
        "flow-mandate-authority-transfer"
    );
}

#[test]
fn schemas_reject_unknown_capabilities_fields_and_applications() {
    let mut value: Value =
        serde_json::from_str(PARTICIPATION_FIXTURE).expect("fixture JSON should decode");
    value["providerCredential"] = json!("forbidden");
    assert!(serde_json::from_value::<FlowProjectParticipationSnapshot>(value).is_err());

    let mut value: Value =
        serde_json::from_str(PARTICIPATION_FIXTURE).expect("fixture JSON should decode");
    value["agentMandates"][0]["capabilities"][0] = json!("provider-invoke");
    assert!(serde_json::from_value::<FlowProjectParticipationSnapshot>(value).is_err());

    for application_id in ["build", "foreman", "imagine", "world"] {
        let mut value: Value =
            serde_json::from_str(PARTICIPATION_FIXTURE).expect("fixture JSON should decode");
        value["applicationId"] = json!(application_id);
        assert!(serde_json::from_value::<FlowProjectParticipationSnapshot>(value).is_err());
    }
}

#[test]
fn operation_metadata_cannot_grant_authority_or_delete_history() {
    let mut catalogue = flow_participation_operation_catalogue();
    catalogue.operations[0].grants_application_authority = true;
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_participation_operation_catalogue();
    catalogue.operations[3].deletes_durable_history = true;
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_participation_operation_catalogue();
    catalogue.operations.pop();
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_participation_operation_catalogue();
    catalogue.operations.swap(0, 1);
    assert!(catalogue.validate().is_err());

    let remove = flow_participation_operation_catalogue()
        .operations
        .into_iter()
        .find(|operation| operation.operation_id == FlowParticipationOperationId::MemberRemove)
        .expect("member remove should be in the catalogue");
    assert!(!remove.deletes_durable_history);
    assert!(remove.requires_expected_project_revision);
}

#[test]
fn member_and_mandate_transitions_are_closed() {
    assert!(FlowProjectMemberState::Invited.allows_transition_to(FlowProjectMemberState::Active));
    assert!(FlowProjectMemberState::Active.allows_transition_to(FlowProjectMemberState::Suspended));
    assert!(!FlowProjectMemberState::Revoked.allows_transition_to(FlowProjectMemberState::Active));

    assert!(FlowAgentMandateState::Proposed.allows_transition_to(FlowAgentMandateState::Active));
    assert!(FlowAgentMandateState::Active.allows_transition_to(FlowAgentMandateState::Suspended));
    assert!(!FlowAgentMandateState::Revoked.allows_transition_to(FlowAgentMandateState::Active));
}
