use greenways_workspace_contracts::{
    classify_flow_identity, current_suite_manifest, flow_foreman_compatibility_manifest,
    resolve_application_target, CompatibilityDisposition, CurrentApplicationId,
    FlowForemanCompatibilityManifest, FlowIdentityClass, SuiteFailureCode, BUILD_APPLICATION_ID,
    BUILDOUT_REFERENCE_PREFIX, BUILD_CLI_COMMAND, BUILD_PACKAGE_ID, BUILD_ROUTE_PREFIX,
    FLOW_APPLICATION_ID, FLOW_CLI_COMMAND, FLOW_OPERATION_NAMESPACE, FLOW_PACKAGE_ID,
    FLOW_ROUTE_PREFIX, FLOW_VISUAL_LANGUAGE_ROUTE, FOREMAN_DISPLAY_LABEL, FOREMAN_SERVICE_ID,
    PROJECT_REFERENCE_PREFIX, WORK_REFERENCE_PREFIX,
};
use serde_json::{json, Value};

const COMPATIBILITY_FIXTURE: &str =
    include_str!("fixtures/flow/flow-foreman-compatibility.json");

#[test]
fn fixture_matches_the_exact_flow_product_and_foreman_service_contract() {
    let fixture: FlowForemanCompatibilityManifest =
        serde_json::from_str(COMPATIBILITY_FIXTURE).expect("compatibility fixture should decode");
    fixture
        .validate()
        .expect("compatibility fixture should validate");
    assert_eq!(fixture, flow_foreman_compatibility_manifest());
    assert_eq!(fixture.product.application_id, CurrentApplicationId::Flow);
    assert_eq!(fixture.product.package_id, FLOW_PACKAGE_ID);
    assert_eq!(fixture.service.service_id, FOREMAN_SERVICE_ID);
    assert!(!fixture.service.product_facing);
    assert!(!fixture.service.discoverable);
    assert!(!fixture.service.grants_application_authority);
}

#[test]
fn build_is_absent_and_cannot_become_a_second_current_application() {
    let suite = current_suite_manifest();
    let flow = suite
        .applications
        .iter()
        .find(|application| application.application_id == CurrentApplicationId::Flow)
        .expect("Flow must be in the current suite");
    assert_eq!(
        flow.compatibility[0].disposition,
        CompatibilityDisposition::Absent
    );
    assert!(!flow.compatibility[0].discoverable);
    assert!(!flow.compatibility[0].grants_authority);

    let result = resolve_application_target(BUILD_APPLICATION_ID);
    result.validate().expect("Build failure should validate");
    assert_eq!(
        result.failure.expect("Build must fail").code,
        SuiteFailureCode::Incompatible
    );
}

#[test]
fn identity_classifier_separates_product_display_and_technical_names() {
    for identity in [
        FLOW_APPLICATION_ID,
        FLOW_PACKAGE_ID,
        FLOW_ROUTE_PREFIX,
        FLOW_CLI_COMMAND,
        FLOW_VISUAL_LANGUAGE_ROUTE,
        "flow.project.create",
    ] {
        assert_eq!(
            classify_flow_identity(identity),
            FlowIdentityClass::CurrentProduct
        );
    }

    assert_eq!(
        classify_flow_identity(FOREMAN_DISPLAY_LABEL),
        FlowIdentityClass::SafeDisplayAlias
    );
    for identity in [
        FOREMAN_SERVICE_ID,
        "foreman.project.read",
        "project/project-1",
        "work/work-1",
        "buildout/buildout-1",
    ] {
        assert_eq!(
            classify_flow_identity(identity),
            FlowIdentityClass::RetainedTechnicalIdentity
        );
    }

    for identity in [
        BUILD_APPLICATION_ID,
        BUILD_PACKAGE_ID,
        BUILD_ROUTE_PREFIX,
        BUILD_CLI_COMMAND,
        "build.project.create",
    ] {
        assert_eq!(
            classify_flow_identity(identity),
            FlowIdentityClass::Incompatible
        );
    }
    assert_eq!(
        classify_flow_identity("unknown-product"),
        FlowIdentityClass::Unknown
    );
}

#[test]
fn compatibility_cannot_advertise_transfer_or_duplicate_authority() {
    let manifest = flow_foreman_compatibility_manifest();

    let mut discoverable_service = manifest.clone();
    discoverable_service.service.discoverable = true;
    assert_eq!(
        discoverable_service
            .validate()
            .expect_err("Foreman cannot become discoverable")
            .code,
        "invalid-flow-foreman-contract"
    );

    let mut rewritten_record = manifest.clone();
    rewritten_record.compatibility[6].rewrite_durable_identity = true;
    assert_eq!(
        rewritten_record
            .validate()
            .expect_err("buildout identity cannot be destructively rewritten")
            .code,
        "invalid-flow-foreman-contract"
    );

    let mut parallel_build = manifest;
    parallel_build.compatibility[0].accepted = true;
    parallel_build.compatibility[0].creates_parallel_record = true;
    assert_eq!(
        parallel_build
            .validate()
            .expect_err("Build cannot create a parallel logical project")
            .code,
        "invalid-flow-foreman-contract"
    );
}

#[test]
fn project_is_the_root_and_buildout_remains_optional() {
    let manifest = flow_foreman_compatibility_manifest();
    assert_eq!(manifest.aggregate.aggregate_root_kind, "project");
    assert_eq!(
        manifest.aggregate.project_reference_prefix,
        PROJECT_REFERENCE_PREFIX
    );
    assert_eq!(
        manifest.aggregate.work_reference_prefix,
        WORK_REFERENCE_PREFIX
    );
    assert_eq!(
        manifest.aggregate.buildout_reference_prefix,
        BUILDOUT_REFERENCE_PREFIX
    );
    assert!(!manifest.aggregate.buildout_required);
    assert!(!manifest.aggregate.cross_project_implicit_move);
    assert!(manifest
        .operation_families
        .iter()
        .all(|operation| operation.starts_with(FLOW_OPERATION_NAMESPACE)));
}

#[test]
fn compatibility_schema_is_closed_and_future_products_stay_out() {
    let mut value: Value =
        serde_json::from_str(COMPATIBILITY_FIXTURE).expect("fixture JSON should decode");
    value["service"]["nativeHandle"] = json!("forbidden");
    assert!(serde_json::from_value::<FlowForemanCompatibilityManifest>(value).is_err());

    let serialized = serde_json::to_string(&flow_foreman_compatibility_manifest())
        .expect("manifest should serialize");
    assert!(!serialized.contains("imagine"));
    assert!(!serialized.contains("world"));
}
