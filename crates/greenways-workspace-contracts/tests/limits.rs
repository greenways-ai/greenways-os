use greenways_workspace_contracts::ResourceLimits;

#[test]
fn limits_are_bounded() {
    ResourceLimits::default()
        .validate()
        .expect("default limits");

    let limits = ResourceLimits {
        max_page: 101,
        ..ResourceLimits::default()
    };
    assert_eq!(limits.validate().expect_err("limit").code, "invalid-limit");
}
