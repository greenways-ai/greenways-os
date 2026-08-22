use greenways_workspace_contracts::{
    current_suite_manifest, resolve_application_target, CompatibilityDisposition,
    CurrentApplicationId, LegacyApplicationId, SuiteFailureCode, SuiteResultState,
    BUILD_APPLICATION_ID, FLOW_APPLICATION_ID, FLOW_PACKAGE_ID, IMAGINE_APPLICATION_ID,
    WORLD_APPLICATION_ID,
};

#[test]
fn flow_is_the_only_current_coordination_product() {
    let suite = current_suite_manifest();
    suite.validate().expect("current suite should validate");

    let flow = suite
        .applications
        .iter()
        .find(|application| application.application_id == CurrentApplicationId::Flow)
        .expect("Flow should be current");

    assert_eq!(flow.package.id, FLOW_PACKAGE_ID);
    assert_eq!(flow.display_name, "Greenways Flow");
    assert_eq!(flow.launcher_label, "Flow");
    assert_eq!(flow.route_prefix, "/flow/");
    assert_eq!(flow.cli_family, ["greenways", FLOW_APPLICATION_ID]);
    assert_eq!(flow.compatibility.len(), 1);
    assert_eq!(
        flow.compatibility[0].legacy_application_id,
        LegacyApplicationId::Build
    );
    assert_eq!(
        flow.compatibility[0].target_application_id,
        CurrentApplicationId::Flow
    );
    assert_eq!(
        flow.compatibility[0].disposition,
        CompatibilityDisposition::IncompatibleBlocked
    );
    assert!(!flow.compatibility[0].discoverable);
    assert!(!flow.compatibility[0].grants_authority);
}

#[test]
fn legacy_build_is_blocked_instead_of_silently_aliased() {
    let result = resolve_application_target(BUILD_APPLICATION_ID);
    result
        .validate()
        .expect("the explicit incompatibility result should validate");

    assert_eq!(result.state, SuiteResultState::Failed);
    assert!(result.value.is_none());
    let failure = result.failure.expect("Build should fail explicitly");
    assert_eq!(failure.code, SuiteFailureCode::Incompatible);
    assert_eq!(
        failure.application_id.as_deref(),
        Some(BUILD_APPLICATION_ID)
    );
    assert!(!failure.retryable);
}

#[test]
fn foreman_is_an_internal_service_not_an_application_target() {
    let result = resolve_application_target("foreman");
    result
        .validate()
        .expect("the unknown application result should validate");

    assert_eq!(result.state, SuiteResultState::Failed);
    assert!(result.value.is_none());
    let failure = result
        .failure
        .expect("Foreman should not resolve as an app");
    assert_eq!(failure.code, SuiteFailureCode::UnknownApplication);
    assert_eq!(failure.application_id.as_deref(), Some("foreman"));
    assert!(!failure.retryable);
}

#[test]
fn future_targets_remain_unactivated() {
    for application_id in [IMAGINE_APPLICATION_ID, WORLD_APPLICATION_ID] {
        let result = resolve_application_target(application_id);
        result
            .validate()
            .expect("the unactivated result should validate");

        assert_eq!(result.state, SuiteResultState::Failed);
        assert!(result.value.is_none());
        let failure = result.failure.expect("future target should fail");
        assert_eq!(failure.code, SuiteFailureCode::UnactivatedApplication);
        assert_eq!(failure.application_id.as_deref(), Some(application_id));
        assert!(!failure.retryable);
    }
}
