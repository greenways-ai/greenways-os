use greenways_workspace_contracts::{QueryRequest, CHATS_COLLECTION_URI, QUERY_PROTOCOL};

const CHAT_ID: &str = "0123456789abcdef0123456789abcdef";

fn recent() -> QueryRequest {
    QueryRequest {
        protocol: QUERY_PROTOCOL.to_owned(),
        uri: CHATS_COLLECTION_URI.to_owned(),
        selector: "recent".to_owned(),
        limit: Some(100),
        cursor: None,
        chat_id: None,
        direction: None,
    }
}

#[test]
fn selectors_are_closed_and_bounded() {
    recent().validate().expect("recent");

    QueryRequest {
        selector: "exact".to_owned(),
        limit: None,
        chat_id: Some(CHAT_ID.to_owned()),
        ..recent()
    }
    .validate()
    .expect("exact");

    QueryRequest {
        selector: "messages".to_owned(),
        chat_id: Some(CHAT_ID.to_owned()),
        direction: Some("forward".to_owned()),
        ..recent()
    }
    .validate()
    .expect("messages");

    let unknown = QueryRequest {
        selector: "where".to_owned(),
        ..recent()
    };
    assert_eq!(unknown.validate().expect_err("selector").code, "unknown-selector");
}
