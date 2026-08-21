use greenways_workspace_contracts::{
    flow_work_coordination_operation_catalogue, CurrentApplicationId, FlowAgentMandateState,
    FlowWorkAssignmentState, FlowWorkClaimContention, FlowWorkClaimState,
    FlowWorkCoordinationOperationCatalogue, FlowWorkCoordinationOperationId,
    FlowWorkCoordinationSnapshot, FlowWorkDependencyState, FlowWorkState,
    FLOW_WORK_ASSIGNMENTS_LIST_OPERATION, FLOW_WORK_ASSIGNMENT_DECIDE_OPERATION,
    FLOW_WORK_ASSIGNMENT_RELEASE_OPERATION, FLOW_WORK_ASSIGN_OPERATION,
    FLOW_WORK_CLAIMS_LIST_OPERATION, FLOW_WORK_CLAIM_OPERATION,
    FLOW_WORK_CLAIM_RECONCILE_OPERATION, FLOW_WORK_CLAIM_RELEASE_OPERATION,
    FLOW_WORK_DEPENDENCIES_LIST_OPERATION, FLOW_WORK_DEPENDENCY_ADD_OPERATION,
    FLOW_WORK_DEPENDENCY_UPDATE_OPERATION,
};
use greenways_workspace_contracts::{
    FlowProjectMemberState, FlowProjectParticipationSnapshot,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const COORDINATION_FIXTURE: &str =
    include_str!("fixtures/flow/work-coordination.json");
const CONTENTION_FIXTURE: &str =
    include_str!("fixtures/flow/work-claim-contention.json");
const OPERATION_FIXTURE: &str =
    include_str!("fixtures/flow/work-coordination-operation-catalogue.json");
const PARTICIPATION_FIXTURE: &str =
    include_str!("fixtures/flow/project-participation.json");

fn coordination(source: &str) -> FlowWorkCoordinationSnapshot {
    serde_json::from_str(source).expect("Flow work coordination fixture should decode")
}

fn participation() -> FlowProjectParticipationSnapshot {
    serde_json::from_str(PARTICIPATION_FIXTURE)
        .expect("Flow project participation fixture should decode")
}

#[test]
fn canonical_clean_and_contended_snapshots_validate() {
    let participation = participation();

    let clean = coordination(COORDINATION_FIXTURE);
    clean.validate().expect("clean work coordination should validate");
    clean.validate_against_participation(&participation)
        .expect("clean work coordination should match participation");
    assert_eq!(clean.application_id, CurrentApplicationId::Flow);
    assert_eq!(clean.claims[0].contention, FlowWorkClaimContention::None);
    assert!(!clean.claims[0].copies_work_runtime_state);

    let contended = coordination(CONTENTION_FIXTURE);
    contended
        .validate()
        .expect("explicitly contended claims should validate");
    contended
        .validate_against_participation(&participation)
        .expect("contended claims should preserve participation authority");
    assert!(contended
        .claims
        .iter()
        .all(|claim| claim.contention == FlowWorkClaimContention::Contended));
}

#[test]
fn operation_fixture_matches_the_closed_catalogue() {
    let fixture: FlowWorkCoordinationOperationCatalogue =
        serde_json::from_str(OPERATION_FIXTURE).expect("operation fixture should decode");
    fixture
        .validate()
        .expect("operation fixture should validate");
    assert_eq!(fixture, flow_work_coordination_operation_catalogue());

    let expected = BTreeSet::from([
        FLOW_WORK_DEPENDENCIES_LIST_OPERATION,
        FLOW_WORK_DEPENDENCY_ADD_OPERATION,
        FLOW_WORK_DEPENDENCY_UPDATE_OPERATION,
        FLOW_WORK_ASSIGNMENTS_LIST_OPERATION,
        FLOW_WORK_ASSIGN_OPERATION,
        FLOW_WORK_ASSIGNMENT_DECIDE_OPERATION,
        FLOW_WORK_ASSIGNMENT_RELEASE_OPERATION,
        FLOW_WORK_CLAIMS_LIST_OPERATION,
        FLOW_WORK_CLAIM_OPERATION,
        FLOW_WORK_CLAIM_RELEASE_OPERATION,
        FLOW_WORK_CLAIM_RECONCILE_OPERATION,
    ]);
    let value = serde_json::to_value(&fixture).expect("catalogue should serialize");
    let actual = value["operations"]
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
fn dependency_graph_rejects_self_edges_duplicates_and_cycles() {
    let mut fixture = coordination(COORDINATION_FIXTURE);
    fixture.dependencies[0].depends_on_work_id = fixture.dependencies[0].work_id.clone();
    assert_eq!(
        fixture
            .validate()
            .expect_err("self dependency should fail")
            .code,
        "self-referential-flow-dependency"
    );

    let mut fixture = coordination(COORDINATION_FIXTURE);
    let mut duplicate = fixture.dependencies[0].clone();
    duplicate.dependency_id = "dependency/duplicate-edge".to_owned();
    fixture.dependencies.push(duplicate);
    assert_eq!(
        fixture
            .validate()
            .expect_err("duplicate dependency edge should fail")
            .code,
        "duplicate-flow-dependency-edge"
    );

    let mut fixture = coordination(COORDINATION_FIXTURE);
    fixture.work[0].state = FlowWorkState::Running;
    fixture.dependencies[0].state = FlowWorkDependencyState::Active;
    fixture.dependencies[0].resolved_at_unix_ms = None;
    let mut reverse = fixture.dependencies[0].clone();
    reverse.dependency_id = "dependency/flow-model-requires-actions".to_owned();
    reverse.work_id = "work/flow-control-room-model".to_owned();
    reverse.depends_on_work_id = "work/flow-control-room-actions".to_owned();
    fixture.dependencies.push(reverse);
    assert_eq!(
        fixture
            .validate()
            .expect_err("active dependency cycle should fail")
            .code,
        "cyclic-flow-work-dependency"
    );
}

#[test]
fn current_assignments_are_unique_and_require_lifecycle_evidence() {
    let mut fixture = coordination(COORDINATION_FIXTURE);
    let mut duplicate = fixture.assignments[0].clone();
    duplicate.assignment_id = "assignment/flow-actions-agent-second".to_owned();
    fixture.assignments.push(duplicate);
    assert_eq!(
        fixture
            .validate()
            .expect_err("two current assignments should fail")
            .code,
        "duplicate-current-flow-assignment"
    );

    let mut fixture = coordination(COORDINATION_FIXTURE);
    fixture.assignments[0].responded_at_unix_ms = None;
    assert_eq!(
        fixture
            .validate()
            .expect_err("accepted assignment requires response evidence")
            .code,
        "flow-assignment-state-time-mismatch"
    );
}

#[test]
fn claim_contention_must_match_observed_active_overlap() {
    let mut fixture = coordination(COORDINATION_FIXTURE);
    fixture.claims[0].contention = FlowWorkClaimContention::Contended;
    assert_eq!(
        fixture
            .validate()
            .expect_err("single active claim cannot be contended")
            .code,
        "flow-claim-contention-mismatch"
    );

    let mut fixture = coordination(CONTENTION_FIXTURE);
    fixture.claims.pop();
    assert_eq!(
        fixture
            .validate()
            .expect_err("remaining single claim must clear contention")
            .code,
        "flow-claim-contention-mismatch"
    );

    let mut fixture = coordination(CONTENTION_FIXTURE);
    fixture.claims[0].contention = FlowWorkClaimContention::None;
    assert_eq!(
        fixture
            .validate()
            .expect_err("overlap must be disclosed on every active claim")
            .code,
        "flow-claim-contention-mismatch"
    );
}

#[test]
fn claim_fences_and_claimants_are_unique() {
    let mut fixture = coordination(CONTENTION_FIXTURE);
    fixture.claims[1].lease_generation = fixture.claims[0].lease_generation;
    assert_eq!(
        fixture
            .validate()
            .expect_err("lease generation collision should fail")
            .code,
        "duplicate-flow-lease-generation"
    );

    let mut fixture = coordination(CONTENTION_FIXTURE);
    fixture.claims[1].claimant_membership_id =
        fixture.claims[0].claimant_membership_id.clone();
    fixture.claims[1].agent_mandate_id = fixture.claims[0].agent_mandate_id.clone();
    assert_eq!(
        fixture
            .validate()
            .expect_err("one claimant cannot hold duplicate active claims")
            .code,
        "duplicate-active-flow-claimant"
    );
}

#[test]
fn terminal_work_cannot_retain_current_coordination() {
    let mut fixture = coordination(COORDINATION_FIXTURE);
    fixture.work[1].state = FlowWorkState::Completed;
    assert_eq!(
        fixture
            .validate()
            .expect_err("terminal work cannot retain current assignment")
            .code,
        "terminal-work-has-current-assignment"
    );

    let mut fixture = coordination(COORDINATION_FIXTURE);
    fixture.assignments.clear();
    fixture.work[1].state = FlowWorkState::Completed;
    assert_eq!(
        fixture
            .validate()
            .expect_err("terminal work cannot retain current claim")
            .code,
        "terminal-work-has-current-claim"
    );
}

#[test]
fn agent_claim_requires_active_matching_work_claim_mandate() {
    let coordination = coordination(COORDINATION_FIXTURE);

    let mut participation = participation();
    participation.agent_mandates[0]
        .capabilities
        .retain(|capability| format!("{capability:?}") != "WorkClaim");
    assert_eq!(
        coordination
            .validate_against_participation(&participation)
            .expect_err("agent claim requires work-claim mandate capability")
            .code,
        "inactive-or-unauthorised-flow-agent-claim"
    );

    let mut participation = participation();
    participation.agent_mandates[0].state = FlowAgentMandateState::Revoked;
    participation.agent_mandates[0].revoked_at_unix_ms = Some(1787274400000);
    participation.members[1].state = FlowProjectMemberState::Revoked;
    participation.members[1].revoked_at_unix_ms = Some(1787274400000);
    assert_eq!(
        coordination
            .validate_against_participation(&participation)
            .expect_err("revoked mandate cannot support current claim")
            .code,
        "inactive-or-unauthorised-flow-agent-claim"
    );

    let mut coordination = coordination(COORDINATION_FIXTURE);
    coordination.claims[0].agent_mandate_id = None;
    assert_eq!(
        coordination
            .validate_against_participation(&participation())
            .expect_err("agent claim requires exact mandate")
            .code,
        "agent-flow-claim-missing-mandate"
    );
}

#[test]
fn person_claims_and_assignment_actors_remain_separate() {
    let mut coordination = coordination(CONTENTION_FIXTURE);
    coordination.claims[1].agent_mandate_id =
        Some("mandate/flow-agent-builder-current".to_owned());
    assert_eq!(
        coordination
            .validate_against_participation(&participation())
            .expect_err("person claim cannot borrow agent mandate")
            .code,
        "person-flow-claim-has-agent-mandate"
    );

    let mut coordination = coordination(COORDINATION_FIXTURE);
    coordination.assignments[0].assigned_by_membership_id =
        "membership/flow-agent-builder".to_owned();
    assert_eq!(
        coordination
            .validate_against_participation(&participation())
            .expect_err("agent cannot act as assignment authority")
            .code,
        "invalid-flow-assignment-actor"
    );
}

#[test]
fn suspended_assignee_cannot_retain_an_accepted_assignment() {
    let coordination = coordination(COORDINATION_FIXTURE);
    let mut participation = participation();
    participation.members[1].state = FlowProjectMemberState::Suspended;
    participation.agent_mandates[0].state = FlowAgentMandateState::Suspended;
    assert_eq!(
        coordination
            .validate_against_participation(&participation)
            .expect_err("accepted assignment requires active assignee")
            .code,
        "flow-assignment-assignee-state-mismatch"
    );
}

#[test]
fn claims_never_copy_runtime_state_or_transfer_authority() {
    let mut fixture = coordination(COORDINATION_FIXTURE);
    fixture.claims[0].copies_work_runtime_state = true;
    assert_eq!(
        fixture
            .validate()
            .expect_err("claim cannot copy Hara Work state")
            .code,
        "flow-claim-authority-or-runtime-copy"
    );

    let mut fixture = coordination(COORDINATION_FIXTURE);
    fixture.claims[0].authority_transfer = true;
    assert_eq!(
        fixture
            .validate()
            .expect_err("claim cannot transfer authority")
            .code,
        "flow-claim-authority-or-runtime-copy"
    );
}

#[test]
fn schemas_reject_unknown_fields_operations_and_applications() {
    let mut value: Value =
        serde_json::from_str(COORDINATION_FIXTURE).expect("fixture JSON should decode");
    value["runtimeCheckpoint"] = json!("forbidden");
    assert!(serde_json::from_value::<FlowWorkCoordinationSnapshot>(value).is_err());

    for application_id in ["build", "foreman", "imagine", "world"] {
        let mut value: Value =
            serde_json::from_str(COORDINATION_FIXTURE).expect("fixture JSON should decode");
        value["applicationId"] = json!(application_id);
        assert!(serde_json::from_value::<FlowWorkCoordinationSnapshot>(value).is_err());
    }

    let mut value: Value =
        serde_json::from_str(OPERATION_FIXTURE).expect("operation JSON should decode");
    value["operations"][0]["operationId"] = json!("flow.work.provider.invoke");
    assert!(serde_json::from_value::<FlowWorkCoordinationOperationCatalogue>(value).is_err());
}

#[test]
fn operation_metadata_cannot_delete_history_copy_runtime_or_grant_authority() {
    let mut catalogue = flow_work_coordination_operation_catalogue();
    catalogue.operations[0].grants_application_authority = true;
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_work_coordination_operation_catalogue();
    catalogue.operations[5].deletes_durable_history = true;
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_work_coordination_operation_catalogue();
    catalogue.operations[8].copies_work_runtime_state = true;
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_work_coordination_operation_catalogue();
    catalogue.operations.pop();
    assert!(catalogue.validate().is_err());

    let reconcile = flow_work_coordination_operation_catalogue()
        .operations
        .into_iter()
        .find(|operation| operation.operation_id == FlowWorkCoordinationOperationId::ClaimReconcile)
        .expect("claim reconcile should be present");
    assert!(reconcile.requires_expected_project_revision);
    assert!(!reconcile.copies_work_runtime_state);
}

#[test]
fn dependency_assignment_and_claim_transitions_are_closed() {
    assert!(FlowWorkDependencyState::Proposed
        .allows_transition_to(FlowWorkDependencyState::Active));
    assert!(!FlowWorkDependencyState::Satisfied
        .allows_transition_to(FlowWorkDependencyState::Active));

    assert!(FlowWorkAssignmentState::Assigned
        .allows_transition_to(FlowWorkAssignmentState::Accepted));
    assert!(!FlowWorkAssignmentState::Released
        .allows_transition_to(FlowWorkAssignmentState::Accepted));

    assert!(FlowWorkClaimState::Proposed.allows_transition_to(FlowWorkClaimState::Active));
    assert!(FlowWorkClaimState::Active.allows_transition_to(FlowWorkClaimState::Stale));
    assert!(!FlowWorkClaimState::Released.allows_transition_to(FlowWorkClaimState::Active));
}
