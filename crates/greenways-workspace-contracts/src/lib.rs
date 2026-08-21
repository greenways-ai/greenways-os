mod chats;
mod context;
mod error;
mod flow;
mod flow_handoff_intervention;
mod flow_participation;
mod flow_presence;
mod flow_work_coordination;
mod resource;
mod spaces;
mod suite;

pub use chats::{
    chat_uri, ChatEntity, ChatSource, EntityLink, MessageEntity, MessageRole, TransactionRequest,
    CHATS_COLLECTION_URI, CHATS_PROFILE, CHAT_PROTOCOL, MAX_MESSAGE_BYTES, MAX_TITLE_BYTES,
    MESSAGE_PROTOCOL,
};
pub use context::reject_server_context;
pub use error::{ContractError, ErrorCode, PublicFailure, ERROR_PROTOCOL, MAX_PUBLIC_ERROR_BYTES};
pub use flow::*;
pub use flow_handoff_intervention::*;
pub use flow_participation::*;
pub use flow_presence::*;
pub use flow_work_coordination::*;
pub use resource::{
    validate_resource_uri, Availability, ChangeStatus, QueryRequest, ResourceChanged,
    ResourceDescriptor, ResourceKind, ResourceLimits, ResourceOperation, SessionHello,
    ACTION_DATA_QUERY, ACTION_DATA_TRANSACT, ACTION_RESOURCE_RESOLVE, ACTION_SESSION_HELLO,
    CHANGED_PROTOCOL, IDENTITIES_URI, LOCAL_PROTOCOL, MAX_CLIENT_REQUEST_BYTES, MAX_CURSOR_BYTES,
    MAX_EVENT_QUEUE, MAX_PAGE_ITEMS, MAX_SERVER_FRAME_BYTES, MAX_SUBSCRIPTIONS, PACKAGES_URI,
    PAGE_PROTOCOL, QUERY_PROTOCOL, RESOURCE_PROTOCOL, SESSION_HELLO_PROTOCOL,
    SIGNAL_RESOURCE_CHANGED, SUBSTRATE_PROTOCOL, TRANSACTION_PROTOCOL,
};
pub use spaces::*;
pub use suite::*;

use serde::{Deserialize, Serialize};

pub const GREENWAYS_BASE_REVISION: &str = "92968e489b36b95419a68e3fc996dd09a7bd8837";
pub const RUNTIME_BASE_REVISION: &str = "e8b811759edbe7c387f914481cb9b3019fa4ce08";
pub const SEMANTIC_BASE_REVISION: &str = "e5f1389a9122c7ac4fdd625c9c6d6c5b840bef14";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContractManifest {
    pub protocol: String,
    pub greenways_revision: String,
    pub runtime_revision: String,
    pub semantic_revision: String,
    pub local_protocol: String,
    pub substrate_protocol: String,
    pub actions: Vec<String>,
    pub signals: Vec<String>,
    pub resources: Vec<String>,
    pub limits: ResourceLimits,
    pub event_queue_max: u16,
}

pub fn contract_manifest() -> ContractManifest {
    ContractManifest {
        protocol: "greenways.workspace.contract/0-alpha".to_owned(),
        greenways_revision: GREENWAYS_BASE_REVISION.to_owned(),
        runtime_revision: RUNTIME_BASE_REVISION.to_owned(),
        semantic_revision: SEMANTIC_BASE_REVISION.to_owned(),
        local_protocol: LOCAL_PROTOCOL.to_owned(),
        substrate_protocol: SUBSTRATE_PROTOCOL.to_owned(),
        actions: [
            ACTION_SESSION_HELLO,
            ACTION_RESOURCE_RESOLVE,
            ACTION_DATA_QUERY,
            ACTION_DATA_TRANSACT,
        ]
        .into_iter()
        .map(str::to_owned)
        .collect(),
        signals: vec![SIGNAL_RESOURCE_CHANGED.to_owned()],
        resources: [
            CHATS_COLLECTION_URI.to_owned(),
            PACKAGES_URI.to_owned(),
            IDENTITIES_URI.to_owned(),
        ]
        .into_iter()
        .collect(),
        limits: ResourceLimits::default(),
        event_queue_max: MAX_EVENT_QUEUE,
    }
}
