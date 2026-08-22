use greenways_workspace_contracts::{
    flow_project_control_room, FlowBuildoutState, FlowControlRoomActionAvailability,
    FlowControlRoomAttentionKind, FlowControlRoomAttentionSeverity, FlowControlRoomDisabledReason,
    FlowControlRoomRevisionSubject, FlowControlRoomSelection, FlowOperationId,
    FlowProjectControlRoom, FlowProjectSnapshot, FlowProjectState, FlowWorkState,
};
use serde_json::{json, Value};

const BUILDOUT_PROJECT: &str = include_str!("fixtures/flow/project-buildout.json");
const DIRECT_PROJECT: &str = include_str!("fixtures/flow/project-direct-work.json");
const CONTROL_ROOM_BUILDOUT: &str =
    include_str!("fixtures/flow/project-control-room-buildout.json");

fn project_fixture(source: &str) -> FlowProjectSnapshot {
    serde_json::from_str(source).expect("Flow project fixture should decode")
}

#[test]
fn canonical_buildout_projection_matches_the_closed_fixture() {
    let project = project_fixture(BUILDOUT_PROJECT);
    let expected: FlowProjectControlRoom =
        serde_json::from_str(CONTROL_ROOM_BUILDOUT).expect("Control Room fixture should decode");

    expected
        .validate()
        .expect("canonical Control Room fixture should validate");
    let actual = flow_project_control_room(&project, FlowControlRoomSelection::project())
        .expect("buildout project should project into the Control Room");

    assert_eq!(actual, expected);
    assert_eq!(actual.summary.work_total, 2);
    assert_eq!(actual.summary.grouped_work, 2);
    assert_eq!(actual.summary.buildout_total, 1);
    assert!(actual.direct_work.is_empty());
    assert!(actual.attention.is_empty());
}

#[test]
fn direct_work_remains_outside_buildout_lanes() {
    let project = project_fixture(DIRECT_PROJECT);
    let room = flow_project_control_room(&project, FlowControlRoomSelection::project())
        .expect("direct-work project should project");

    room.validate().expect("direct-work room should validate");
    assert_eq!(room.summary.work_total, 1);
    assert_eq!(room.summary.direct_work, 1);
    assert_eq!(room.summary.grouped_work, 0);
    assert_eq!(room.summary.buildout_total, 0);
    assert_eq!(room.direct_work.len(), 1);
    assert!(room.direct_work[0].buildout_id.is_none());
    assert!(room.buildouts.is_empty());
}

#[test]
fn selected_terminal_work_keeps_reads_and_disables_mutation() {
    let project = project_fixture(BUILDOUT_PROJECT);
    let room = flow_project_control_room(
        &project,
        FlowControlRoomSelection::work("work/flow-control-room-model"),
    )
    .expect("known work selection should project");

    let get = room
        .actions
        .iter()
        .find(|action| action.operation_id == FlowOperationId::WorkGet)
        .expect("work read action should exist");
    assert_eq!(
        get.availability,
        FlowControlRoomActionAvailability::Available
    );
    assert!(get.expected_revision.is_none());

    for operation_id in [FlowOperationId::WorkUpdate, FlowOperationId::WorkTransition] {
        let action = room
            .actions
            .iter()
            .find(|action| action.operation_id == operation_id)
            .expect("selected work mutation should be represented");
        assert_eq!(
            action.availability,
            FlowControlRoomActionAvailability::Disabled
        );
        assert_eq!(
            action.disabled_reason,
            Some(FlowControlRoomDisabledReason::TerminalWork)
        );
        let expected = action
            .expected_revision
            .as_ref()
            .expect("work mutation should be revision-fenced");
        assert_eq!(expected.subject, FlowControlRoomRevisionSubject::Work);
        assert_eq!(expected.revision, 4);
    }
}

#[test]
fn selected_active_buildout_uses_its_own_revision_fence() {
    let project = project_fixture(BUILDOUT_PROJECT);
    let room = flow_project_control_room(
        &project,
        FlowControlRoomSelection::buildout("buildout/flow-control-room"),
    )
    .expect("known buildout selection should project");

    for operation_id in [
        FlowOperationId::BuildoutUpdate,
        FlowOperationId::BuildoutTransition,
    ] {
        let action = room
            .actions
            .iter()
            .find(|action| action.operation_id == operation_id)
            .expect("selected buildout mutation should be represented");
        assert_eq!(
            action.availability,
            FlowControlRoomActionAvailability::Available
        );
        let expected = action
            .expected_revision
            .as_ref()
            .expect("buildout mutation should be revision-fenced");
        assert_eq!(expected.subject, FlowControlRoomRevisionSubject::Buildout);
        assert_eq!(expected.revision, 3);
    }
}

#[test]
fn terminal_project_disables_project_owned_mutation_without_hiding_reads() {
    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.state = FlowProjectState::Completed;
    project.work[1].state = FlowWorkState::Completed;
    project.buildouts[0].state = FlowBuildoutState::Completed;
    project
        .validate()
        .expect("fully terminal source project should validate");

    let room = flow_project_control_room(&project, FlowControlRoomSelection::project())
        .expect("terminal project should still have a readable Control Room");

    for operation_id in [FlowOperationId::ProjectList, FlowOperationId::ProjectGet] {
        let action = room
            .actions
            .iter()
            .find(|action| action.operation_id == operation_id)
            .expect("project read action should exist");
        assert_eq!(
            action.availability,
            FlowControlRoomActionAvailability::Available
        );
    }
    for operation_id in [
        FlowOperationId::ProjectUpdate,
        FlowOperationId::ProjectTransition,
        FlowOperationId::WorkCreate,
        FlowOperationId::BuildoutCreate,
    ] {
        let action = room
            .actions
            .iter()
            .find(|action| action.operation_id == operation_id)
            .expect("project-owned mutation should remain explicit");
        assert_eq!(
            action.availability,
            FlowControlRoomActionAvailability::Disabled
        );
        assert_eq!(
            action.disabled_reason,
            Some(FlowControlRoomDisabledReason::TerminalProject)
        );
    }
}

#[test]
fn attention_is_derived_from_visible_record_state() {
    let mut project = project_fixture(BUILDOUT_PROJECT);
    project.state = FlowProjectState::Paused;
    project.work[0].state = FlowWorkState::Failed;
    project.work[1].state = FlowWorkState::Blocked;
    project.buildouts[0].state = FlowBuildoutState::Review;
    project
        .validate()
        .expect("non-terminal attention states should validate");

    let room = flow_project_control_room(&project, FlowControlRoomSelection::project())
        .expect("attention project should project");

    assert_eq!(room.attention.len(), 4);
    assert_eq!(
        room.attention[0].kind,
        FlowControlRoomAttentionKind::ProjectPaused
    );
    assert_eq!(
        room.attention[0].severity,
        FlowControlRoomAttentionSeverity::ActionRequired
    );
    assert_eq!(
        room.attention[1].kind,
        FlowControlRoomAttentionKind::WorkFailed
    );
    assert_eq!(
        room.attention[1].severity,
        FlowControlRoomAttentionSeverity::Critical
    );
    assert_eq!(
        room.attention[2].kind,
        FlowControlRoomAttentionKind::WorkBlocked
    );
    assert_eq!(
        room.attention[3].kind,
        FlowControlRoomAttentionKind::BuildoutReview
    );
}

#[test]
fn unknown_or_malformed_selection_fails_closed() {
    let project = project_fixture(BUILDOUT_PROJECT);
    assert!(flow_project_control_room(
        &project,
        FlowControlRoomSelection::work("work/not-in-project")
    )
    .is_err());
    assert!(flow_project_control_room(
        &project,
        FlowControlRoomSelection::buildout("buildout/not-in-project")
    )
    .is_err());

    let mut selection = FlowControlRoomSelection::project();
    selection.entity_id = Some("project/flow-control-room".to_owned());
    assert!(flow_project_control_room(&project, selection).is_err());
}

#[test]
fn unknown_fields_and_authority_handles_are_rejected() {
    let mut value: Value =
        serde_json::from_str(CONTROL_ROOM_BUILDOUT).expect("fixture should parse");
    value["providerHandle"] = json!("native://unbounded");
    assert!(serde_json::from_value::<FlowProjectControlRoom>(value).is_err());

    let mut value: Value =
        serde_json::from_str(CONTROL_ROOM_BUILDOUT).expect("fixture should parse");
    value["actions"][0]["credential"] = json!("secret");
    assert!(serde_json::from_value::<FlowProjectControlRoom>(value).is_err());
}

#[test]
fn summaries_attention_and_revision_fences_cannot_drift() {
    let project = project_fixture(BUILDOUT_PROJECT);
    let room = flow_project_control_room(&project, FlowControlRoomSelection::project())
        .expect("project should project");

    let mut changed_summary = room.clone();
    changed_summary.summary.running_work = 2;
    assert!(changed_summary.validate().is_err());

    let mut invented_attention = room.clone();
    invented_attention.attention.push(
        greenways_workspace_contracts::FlowControlRoomAttentionItem {
            kind: FlowControlRoomAttentionKind::WorkBlocked,
            severity: FlowControlRoomAttentionSeverity::ActionRequired,
            target_kind: greenways_workspace_contracts::FlowControlRoomTargetKind::Work,
            target_id: "work/flow-control-room-actions".to_owned(),
            title: "Invented blocked state".to_owned(),
        },
    );
    assert!(invented_attention.validate().is_err());

    let mut changed_revision = room;
    let action = changed_revision
        .actions
        .iter_mut()
        .find(|action| action.operation_id == FlowOperationId::ProjectUpdate)
        .expect("project update action should exist");
    action
        .expected_revision
        .as_mut()
        .expect("project update should be fenced")
        .revision += 1;
    assert!(changed_revision.validate().is_err());
}

#[test]
fn grouped_work_cannot_escape_or_duplicate_its_buildout_lane() {
    let project = project_fixture(BUILDOUT_PROJECT);
    let room = flow_project_control_room(&project, FlowControlRoomSelection::project())
        .expect("project should project");

    let mut escaped = room.clone();
    let work = escaped.buildouts[0].work[0].clone();
    escaped.direct_work.push(work);
    assert!(escaped.validate().is_err());

    let mut mismatched = room;
    mismatched.buildouts[0].work[0].buildout_id = Some("buildout/other".to_owned());
    assert!(mismatched.validate().is_err());
}

#[test]
fn control_room_exposes_only_current_flow_operations_without_authority() {
    let project = project_fixture(BUILDOUT_PROJECT);
    let room = flow_project_control_room(
        &project,
        FlowControlRoomSelection::work("work/flow-control-room-actions"),
    )
    .expect("project should project");

    assert!(room
        .actions
        .iter()
        .all(|action| !action.grants_application_authority));
    assert!(room.actions.iter().all(|action| {
        !matches!(
            action.operation_id,
            FlowOperationId::ProjectCreate
                | FlowOperationId::WorkList
                | FlowOperationId::BuildoutList
        )
    }));

    let serialized = serde_json::to_string(&room).expect("Control Room should serialize");
    for forbidden in [
        "greenways/build",
        "\"applicationId\":\"build\"",
        "\"applicationId\":\"foreman\"",
        "\"applicationId\":\"imagine\"",
        "\"applicationId\":\"world\"",
        "providerHandle",
        "databaseHandle",
        "evalHandle",
        "nativeHandle",
    ] {
        assert!(!serialized.contains(forbidden), "unexpected {forbidden}");
    }
}
