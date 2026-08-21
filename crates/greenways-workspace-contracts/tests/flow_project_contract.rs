use greenways_workspace_contracts::{
    flow_operation_catalogue, CurrentApplicationId, FlowBuildoutState, FlowOperationCatalogue,
    FlowOperationId, FlowProjectSnapshot, FlowProjectState, FlowWorkState,
    FLOW_BUILDOUT_CREATE_OPERATION, FLOW_BUILDOUT_GET_OPERATION, FLOW_BUILDOUT_LIST_OPERATION,
    FLOW_BUILDOUT_TRANSITION_OPERATION, FLOW_BUILDOUT_UPDATE_OPERATION,
    FLOW_PROJECT_CREATE_OPERATION, FLOW_PROJECT_GET_OPERATION, FLOW_PROJECT_LIST_OPERATION,
    FLOW_PROJECT_TRANSITION_OPERATION, FLOW_PROJECT_UPDATE_OPERATION, FLOW_WORK_CREATE_OPERATION,
    FLOW_WORK_GET_OPERATION, FLOW_WORK_LIST_OPERATION, FLOW_WORK_TRANSITION_OPERATION,
    FLOW_WORK_UPDATE_OPERATION,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const DIRECT_PROJECT: &str = include_str!("fixtures/flow/project-direct-work.json");
const BUILDOUT_PROJECT: &str = include_str!("fixtures/flow/project-buildout.json");
const OPERATION_CATALOGUE: &str = include_str!("fixtures/flow/operation-catalogue.json");

fn project_fixture(source: &str) -> FlowProjectSnapshot {
    serde_json::from_str(source).expect("Flow project fixture should decode")
}

#[test]
fn canonical_project_fixtures_validate() {
    let direct = project_fixture(DIRECT_PROJECT);
    direct
        .validate()
        .expect("direct-work Flow project should validate");
    assert!(direct.buildouts.is_empty());
    assert_eq!(direct.work.len(), 1);
    assert!(direct.work[0].buildout_id.is_none());

    let grouped = project_fixture(BUILDOUT_PROJECT);
    grouped
        .validate()
        .expect("buildout Flow project should validate");
    assert_eq!(grouped.buildouts.len(), 1);
    assert_eq!(grouped.work.len(), 2);
    assert!(grouped
        .work
        .iter()
        .all(|work| work.buildout_id.as_deref() == Some("buildout/flow-control-room")));
}

#[test]
fn operation_fixture_matches_the_closed_catalogue() {
    let fixture: FlowOperationCatalogue =
        serde_json::from_str(OPERATION_CATALOGUE).expect("operation fixture should decode");
    fixture
        .validate()
        .expect("operation fixture should validate");
    assert_eq!(fixture, flow_operation_catalogue());

    let expected = BTreeSet::from([
        FLOW_PROJECT_LIST_OPERATION,
        FLOW_PROJECT_GET_OPERATION,
        FLOW_PROJECT_CREATE_OPERATION,
        FLOW_PROJECT_UPDATE_OPERATION,
        FLOW_PROJECT_TRANSITION_OPERATION,
        FLOW_WORK_LIST_OPERATION,
        FLOW_WORK_GET_OPERATION,
        FLOW_WORK_CREATE_OPERATION,
        FLOW_WORK_UPDATE_OPERATION,
        FLOW_WORK_TRANSITION_OPERATION,
        FLOW_BUILDOUT_LIST_OPERATION,
        FLOW_BUILDOUT_GET_OPERATION,
        FLOW_BUILDOUT_CREATE_OPERATION,
        FLOW_BUILDOUT_UPDATE_OPERATION,
        FLOW_BUILDOUT_TRANSITION_OPERATION,
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
fn project_membership_is_closed_to_one_aggregate() {
    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.work[0].project_id = "project/other".to_owned();
    assert!(project.validate().is_err());

    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.buildouts[0].project_id = "project/other".to_owned();
    assert!(project.validate().is_err());

    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.work.push(project.work[0].clone());
    assert!(project.validate().is_err());

    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.buildouts.push(project.buildouts[0].clone());
    assert!(project.validate().is_err());
}

#[test]
fn buildout_membership_must_agree_in_both_directions() {
    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.work[0].buildout_id = None;
    assert!(project.validate().is_err());

    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.buildouts[0].work_ids.pop();
    assert!(project.validate().is_err());

    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.buildouts[0]
        .work_ids
        .push("work/not-in-project".to_owned());
    assert!(project.validate().is_err());
}

#[test]
fn terminal_aggregates_require_terminal_members() {
    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.state = FlowProjectState::Completed;
    assert!(project.validate().is_err());

    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.buildouts[0].state = FlowBuildoutState::Completed;
    assert!(project.validate().is_err());

    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.work[1].state = FlowWorkState::Completed;
    project.buildouts[0].state = FlowBuildoutState::Completed;
    project.state = FlowProjectState::Completed;
    project
        .validate()
        .expect("fully terminal project should validate");
}

#[test]
fn shared_references_never_transfer_authority_or_duplicate_identity() {
    let mut project = project_fixture(DIRECT_PROJECT);
    project.source_references[0].authority_transfer = true;
    assert!(project.validate().is_err());

    let mut project = project_fixture(DIRECT_PROJECT);
    project
        .evidence_references
        .push(project.source_references[0].clone());
    assert!(project.validate().is_err());
}

#[test]
fn flow_ownership_is_exact_and_future_or_legacy_ids_are_rejected() {
    let mut project = project_fixture(DIRECT_PROJECT);
    project.application_id = CurrentApplicationId::Spaces;
    assert!(project.validate().is_err());

    for application_id in ["build", "foreman", "imagine", "world"] {
        let mut value: Value = serde_json::from_str(DIRECT_PROJECT).expect("fixture should parse");
        value["applicationId"] = json!(application_id);
        assert!(serde_json::from_value::<FlowProjectSnapshot>(value).is_err());
    }
}

#[test]
fn unknown_fields_and_unknown_operations_fail_closed() {
    let mut value: Value = serde_json::from_str(DIRECT_PROJECT).expect("fixture should parse");
    value["providerHandle"] = json!("native://unbounded");
    assert!(serde_json::from_value::<FlowProjectSnapshot>(value).is_err());

    let mut value: Value =
        serde_json::from_str(OPERATION_CATALOGUE).expect("fixture should parse");
    value["operations"][0]["operationId"] = json!("flow.project.delete");
    assert!(serde_json::from_value::<FlowOperationCatalogue>(value).is_err());
}

#[test]
fn operation_metadata_cannot_drift_or_grant_authority() {
    let mut catalogue = flow_operation_catalogue();
    catalogue.operations[0].grants_application_authority = true;
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_operation_catalogue();
    catalogue.operations.pop();
    assert!(catalogue.validate().is_err());

    let mut catalogue = flow_operation_catalogue();
    catalogue.operations.swap(0, 1);
    assert!(catalogue.validate().is_err());

    assert!(flow_operation_catalogue()
        .operations
        .iter()
        .all(|operation| operation.operation_id != FlowOperationId::ProjectCreate
            || !operation.requires_expected_revision));
}

#[test]
fn lifecycle_transitions_are_closed_and_terminal_states_do_not_reopen() {
    assert!(FlowProjectState::Draft.allows_transition_to(FlowProjectState::Active));
    assert!(!FlowProjectState::Draft.allows_transition_to(FlowProjectState::Completed));
    assert!(!FlowProjectState::Completed.allows_transition_to(FlowProjectState::Active));

    assert!(FlowWorkState::Ready.allows_transition_to(FlowWorkState::Running));
    assert!(!FlowWorkState::Completed.allows_transition_to(FlowWorkState::Running));
    assert!(!FlowWorkState::Failed.allows_transition_to(FlowWorkState::Ready));

    assert!(FlowBuildoutState::Active.allows_transition_to(FlowBuildoutState::Review));
    assert!(!FlowBuildoutState::Completed.allows_transition_to(FlowBuildoutState::Active));
}

#[test]
fn current_catalogue_does_not_expose_legacy_or_future_applications() {
    let serialized = serde_json::to_string_pretty(&flow_operation_catalogue())
        .expect("catalogue should serialize");
    for forbidden in [
        "\"applicationId\": \"build\"",
        "\"applicationId\": \"foreman\"",
        "\"applicationId\": \"imagine\"",
        "\"applicationId\": \"world\"",
    ] {
        assert!(!serialized.contains(forbidden));
    }
}
