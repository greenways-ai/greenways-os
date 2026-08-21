use greenways_workspace_contracts::{
    compare_handoff_replay, current_suite_manifest, resolve_application_target,
    ApplicationAvailability, CompatibilityDisposition, CurrentApplicationId, CurrentSuiteManifest,
    HandoffEnvelope, HandoffReplay, HandoffState, SuiteFailureCode, SuiteResult, SuiteResultState,
    BUILD_APPLICATION_ID, FLOW_APPLICATION_ID, FLOW_PACKAGE_ID, FLOW_TO_SPACES_HANDOFF_ID,
    IMAGINE_APPLICATION_ID, RESEARCH_APPLICATION_ID, SPACES_APPLICATION_ID, SPACES_PACKAGE_ID,
    SPACES_TO_FLOW_HANDOFF_ID, WORLD_APPLICATION_ID,
};
use serde_json::{json, Value};

const CURRENT_SUITE_FIXTURE: &str = include_str!("fixtures/suite/current-suite.json");
const SPACES_TO_FLOW_FIXTURE: &str = include_str!("fixtures/suite/spaces-question-to-flow.json");
const FLOW_TO_SPACES_FIXTURE: &str = include_str!("fixtures/suite/flow-result-to-spaces.json");
const FUTURE_IMAGINE_FIXTURE: &str = include_str!("fixtures/suite/future-imagine-result.json");

#[test]
fn current_suite_fixture_contains_exactly_spaces_and_flow() {
    let fixture: CurrentSuiteManifest =
        serde_json::from_str(CURRENT_SUITE_FIXTURE).expect("suite fixture should decode");
    fixture.validate().expect("suite fixture should validate");
    assert_eq!(fixture, current_suite_manifest());
    assert_eq!(fixture.applications.len(), 2);
    assert_eq!(
        fixture.applications[0].application_id,
        CurrentApplicationId::Spaces
    );
    assert_eq!(fixture.applications[0].package.id, SPACES_PACKAGE_ID);
    assert_eq!(
        fixture.applications[0].compatibility[0].disposition,
        CompatibilityDisposition::Absent
    );
    assert_eq!(
        fixture.applications[1].application_id,
        CurrentApplicationId::Flow
    );
    assert_eq!(fixture.applications[1].package.id, FLOW_PACKAGE_ID);
    assert_eq!(
        fixture.applications[1].compatibility[0].disposition,
        CompatibilityDisposition::IncompatibleBlocked
    );
    assert!(fixture
        .applications
        .iter()
        .all(|application| !application.compatibility[0].discoverable));
}

#[test]
fn canonical_handoff_fixtures_preserve_cross_application_ownership() {
    let spaces_to_flow: HandoffEnvelope =
        serde_json::from_str(SPACES_TO_FLOW_FIXTURE).expect("Spaces handoff should decode");
    spaces_to_flow
        .validate()
        .expect("Spaces handoff should validate");
    assert_eq!(spaces_to_flow.handoff_id, SPACES_TO_FLOW_HANDOFF_ID);
    assert_eq!(
        spaces_to_flow.source.application_id,
        CurrentApplicationId::Spaces
    );
    assert_eq!(
        spaces_to_flow.target_application_id,
        CurrentApplicationId::Flow
    );

    let flow_to_spaces: HandoffEnvelope =
        serde_json::from_str(FLOW_TO_SPACES_FIXTURE).expect("Flow handoff should decode");
    flow_to_spaces
        .validate()
        .expect("Flow handoff should validate");
    assert_eq!(flow_to_spaces.handoff_id, FLOW_TO_SPACES_HANDOFF_ID);
    assert_eq!(
        flow_to_spaces.source.application_id,
        CurrentApplicationId::Flow
    );
    assert_eq!(
        flow_to_spaces.target_application_id,
        CurrentApplicationId::Spaces
    );
}

#[test]
fn closed_contracts_reject_unknown_fields() {
    let mut suite: Value =
        serde_json::from_str(CURRENT_SUITE_FIXTURE).expect("suite JSON should decode");
    suite
        .as_object_mut()
        .expect("suite should be an object")
        .insert("futureApplications".to_owned(), json!(["imagine", "world"]));
    assert!(serde_json::from_value::<CurrentSuiteManifest>(suite).is_err());

    let mut handoff: Value =
        serde_json::from_str(SPACES_TO_FLOW_FIXTURE).expect("handoff JSON should decode");
    handoff["source"]["authorityProfile"] = json!("caller-selected");
    assert!(serde_json::from_value::<HandoffEnvelope>(handoff).is_err());

    let mut result: Value =
        serde_json::from_str(FUTURE_IMAGINE_FIXTURE).expect("result JSON should decode");
    result["failure"]["available"] = json!(true);
    assert!(serde_json::from_value::<SuiteResult<ApplicationAvailability>>(result).is_err());
}

#[test]
fn changed_content_under_one_idempotency_key_is_a_collision() {
    let existing: HandoffEnvelope =
        serde_json::from_str(SPACES_TO_FLOW_FIXTURE).expect("existing handoff should decode");
    let mut changed = existing.clone();
    changed.expected_result_kind = "flow-project-artifact".to_owned();
    changed
        .validate()
        .expect("changed handoff remains structurally valid");

    let failure = compare_handoff_replay(&existing, &changed)
        .expect_err("changed content must collide with the existing key");
    assert_eq!(failure.code, SuiteFailureCode::IdempotencyCollision);
    assert!(!failure.retryable);

    let mut new_request = changed;
    new_request.idempotency_key = "idempotency/gate0/another-request".to_owned();
    assert_eq!(
        compare_handoff_replay(&existing, &new_request).expect("new key should be accepted"),
        HandoffReplay::New
    );
    assert_eq!(
        compare_handoff_replay(&existing, &existing).expect("exact replay should be accepted"),
        HandoffReplay::ExactReplay
    );
}

#[test]
fn cross_owner_and_authority_transfer_references_fail_closed() {
    let handoff: HandoffEnvelope =
        serde_json::from_str(SPACES_TO_FLOW_FIXTURE).expect("handoff should decode");

    let mut cross_owner = handoff.clone();
    cross_owner.source.owner_application_id = CurrentApplicationId::Flow;
    assert_eq!(
        cross_owner
            .validate()
            .expect_err("cross-owner source must fail")
            .code,
        "cross-owner-reference"
    );

    let mut authority_transfer = handoff;
    authority_transfer.source.authority_transfer = true;
    assert_eq!(
        authority_transfer
            .validate()
            .expect_err("reference authority transfer must fail")
            .code,
        "reference-authority-transfer"
    );
}

#[test]
fn reserved_targets_are_unactivated_without_becoming_discoverable() {
    for application_id in [IMAGINE_APPLICATION_ID, WORLD_APPLICATION_ID] {
        let result = resolve_application_target(application_id);
        result
            .validate()
            .expect("unactivated result should validate");
        assert_eq!(result.state, SuiteResultState::Failed);
        assert!(result.value.is_none());
        assert_eq!(
            result.failure.expect("failure should be present").code,
            SuiteFailureCode::UnactivatedApplication
        );
    }

    for application_id in [RESEARCH_APPLICATION_ID, BUILD_APPLICATION_ID] {
        let result = resolve_application_target(application_id);
        result
            .validate()
            .expect("compatibility result should validate");
        assert_eq!(
            result.failure.expect("failure should be present").code,
            SuiteFailureCode::Incompatible
        );
    }

    for application_id in [SPACES_APPLICATION_ID, FLOW_APPLICATION_ID] {
        let result = resolve_application_target(application_id);
        result.validate().expect("current result should validate");
        assert_eq!(result.state, SuiteResultState::Succeeded);
    }

    let fixture: SuiteResult<ApplicationAvailability> =
        serde_json::from_str(FUTURE_IMAGINE_FIXTURE).expect("future fixture should decode");
    assert_eq!(fixture, resolve_application_target(IMAGINE_APPLICATION_ID));
}

#[test]
fn handoff_lifecycle_is_closed_and_terminal_states_do_not_reopen() {
    assert!(HandoffState::Prepared.allows_transition_to(HandoffState::ApprovalRequired));
    assert!(HandoffState::Prepared.allows_transition_to(HandoffState::Ready));
    assert!(HandoffState::Ready.allows_transition_to(HandoffState::Accepted));
    assert!(HandoffState::Accepted.allows_transition_to(HandoffState::Importing));
    assert!(HandoffState::Importing.allows_transition_to(HandoffState::Completed));
    assert!(!HandoffState::Completed.allows_transition_to(HandoffState::Ready));
    assert!(!HandoffState::Failed.allows_transition_to(HandoffState::Prepared));
}
