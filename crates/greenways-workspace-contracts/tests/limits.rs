use greenways_workspace_contracts::ResourceLimits;

#[test]
fn limits_are_bounded() {
    ResourceLimits::default()
        .validate()
        .expect("default limits");

    let mut limits = ResourceLimits::default();
    limits.max_page = 101;
    assert_eq!(limits.validate().expect_err("limit").code, "invalid-limit");
}
