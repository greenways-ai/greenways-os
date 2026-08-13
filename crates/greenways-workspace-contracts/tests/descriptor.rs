use greenways_workspace_contracts::{
    ResourceDescriptor, ResourceLimits, RESOURCE_PROTOCOL, CHATS_COLLECTION_URI,
};
use serde_json::json;

const HEAD: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

#[test]
fn descriptor_is_closed_and_bounded() {
    let value = json!({
        "protocol": RESOURCE_PROTOCOL,
        "uri": CHATS_COLLECTION_URI,
        "kind": "collection",
        "service": "chats",
        "operations": ["query", "transact", "subscribe"],
        "head": HEAD,
        "availability": "local",
        "limits": {
            "max_page": 100,
            "max_request_bytes": 65536,
            "max_event_bytes": 262144,
            "max_subscriptions": 32
        }
    });
    let descriptor: ResourceDescriptor = serde_json::from_value(value).expect("descriptor");
    descriptor.validate().expect("valid descriptor");

    let mut limits = ResourceLimits::default();
    limits.max_page = 101;
    assert_eq!(limits.validate().expect_err("limit").code, "invalid-limit");
}
