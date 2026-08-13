use greenways_workspace_contracts::{contract_manifest, MAX_PAGE_ITEMS};

#[test]
fn manifest_is_revision_pinned() {
    let manifest = contract_manifest();
    assert_eq!(manifest.protocol, "greenways.workspace.contract/0-alpha");
    assert_eq!(manifest.actions.len(), 4);
    assert_eq!(manifest.limits.max_page, MAX_PAGE_ITEMS);
    manifest.limits.validate().expect("limits");
}
