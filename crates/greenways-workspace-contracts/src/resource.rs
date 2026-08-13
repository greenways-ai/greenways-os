use crate::ContractError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const LOCAL_PROTOCOL: &str = "greenways-local/0-alpha";
pub const SUBSTRATE_PROTOCOL: &str = "greenways-substrate/0-alpha";
pub const RESOURCE_PROTOCOL: &str = "greenways.resource/0-alpha";
pub const QUERY_PROTOCOL: &str = "greenways.resource.query/0-alpha";
pub const PAGE_PROTOCOL: &str = "greenways.resource.page/0-alpha";
pub const TRANSACTION_PROTOCOL: &str = "greenways.resource.transaction/0-alpha";
pub const CHANGED_PROTOCOL: &str = "greenways.resource.changed/0-alpha";
pub const SESSION_HELLO_PROTOCOL: &str = "greenways.session.hello/0-alpha";

pub const ACTION_SESSION_HELLO: &str = "@greenways/session/hello";
pub const ACTION_RESOURCE_RESOLVE: &str = "@greenways/resource/resolve";
pub const ACTION_DATA_QUERY: &str = "@greenways/data/query";
pub const ACTION_DATA_TRANSACT: &str = "@greenways/data/transact";
pub const SIGNAL_RESOURCE_CHANGED: &str = "resource.changed";

pub const PACKAGES_URI: &str = "greenways:system/packages";
pub const IDENTITIES_URI: &str = "greenways:system/identities";

pub const MAX_CLIENT_REQUEST_BYTES: u32 = 64 * 1024;
pub const MAX_SERVER_FRAME_BYTES: u32 = 256 * 1024;
pub const MAX_SUBSCRIPTIONS: u16 = 32;
pub const MAX_EVENT_QUEUE: u16 = 128;
pub const MAX_PAGE_ITEMS: u16 = 100;
pub const MAX_CURSOR_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum ResourceKind {
    Collection,
    Entity,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum ResourceOperation {
    Query,
    Transact,
    Subscribe,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Availability {
    Local,
    Replicated,
    Remote,
    Unavailable,
    AuthorizationDenied,
    Conflict,
    ResyncRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResourceLimits {
    pub max_page: u16,
    pub max_request_bytes: u32,
    pub max_event_bytes: u32,
    pub max_subscriptions: u16,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_page: MAX_PAGE_ITEMS,
            max_request_bytes: MAX_CLIENT_REQUEST_BYTES,
            max_event_bytes: MAX_SERVER_FRAME_BYTES,
            max_subscriptions: MAX_SUBSCRIPTIONS,
        }
    }
}

impl ResourceLimits {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.max_page == 0 || self.max_page > MAX_PAGE_ITEMS {
            return Err(ContractError::new(
                "invalid-limit",
                "page limit is outside the public contract",
            ));
        }
        if self.max_request_bytes == 0 || self.max_request_bytes > MAX_CLIENT_REQUEST_BYTES {
            return Err(ContractError::new(
                "invalid-limit",
                "request byte limit is outside the public contract",
            ));
        }
        if self.max_event_bytes == 0 || self.max_event_bytes > MAX_SERVER_FRAME_BYTES {
            return Err(ContractError::new(
                "invalid-limit",
                "event byte limit is outside the public contract",
            ));
        }
        if self.max_subscriptions == 0 || self.max_subscriptions > MAX_SUBSCRIPTIONS {
            return Err(ContractError::new(
                "invalid-limit",
                "subscription limit is outside the public contract",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResourceDescriptor {
    pub protocol: String,
    pub uri: String,
    pub kind: ResourceKind,
    pub service: String,
    pub operations: Vec<ResourceOperation>,
    pub head: Option<String>,
    pub availability: Availability,
    pub limits: ResourceLimits,
}

impl ResourceDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, RESOURCE_PROTOCOL)?;
        validate_resource_uri(&self.uri)?;
        validate_bounded_text(&self.service, 1, 96, "invalid-service")?;
        if self.operations.is_empty() || self.operations.len() > 3 {
            return Err(ContractError::new(
                "invalid-operations",
                "resource operations must be a non-empty closed set",
            ));
        }
        let unique = self.operations.iter().copied().collect::<BTreeSet<_>>();
        if unique.len() != self.operations.len() {
            return Err(ContractError::new(
                "invalid-operations",
                "resource operations must be unique",
            ));
        }
        if let Some(head) = &self.head {
            validate_hex(head, 64, "invalid-head")?;
        }
        self.limits.validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionHello {
    pub protocol: String,
    pub client: String,
    pub features: Vec<String>,
}

impl SessionHello {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, SESSION_HELLO_PROTOCOL)?;
        if !matches!(
            self.client.as_str(),
            "desktop" | "server" | "cli" | "browser"
        ) {
            return Err(ContractError::new(
                "invalid-client",
                "session client is unsupported",
            ));
        }
        if self.features.len() > 8 {
            return Err(ContractError::new(
                "invalid-features",
                "too many session features",
            ));
        }
        let allowed = ["resource", "data", "subscription"];
        let mut unique = BTreeSet::new();
        for feature in &self.features {
            if !allowed.contains(&feature.as_str()) || !unique.insert(feature.as_str()) {
                return Err(ContractError::new(
                    "invalid-features",
                    "session feature set is invalid",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct QueryRequest {
    pub protocol: String,
    pub uri: String,
    pub selector: String,
    pub limit: Option<u16>,
    pub cursor: Option<String>,
    pub chat_id: Option<String>,
    pub direction: Option<String>,
}

impl QueryRequest {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, QUERY_PROTOCOL)?;
        validate_resource_uri(&self.uri)?;
        match self.selector.as_str() {
            "recent" => {
                require_page_limit(self.limit)?;
                require_cursor(&self.cursor)?;
                require_absent(&self.chat_id, "chat_id")?;
                require_absent(&self.direction, "direction")
            }
            "exact" => {
                require_absent(&self.limit, "limit")?;
                require_absent(&self.cursor, "cursor")?;
                require_absent(&self.direction, "direction")?;
                validate_chat_id(self.chat_id.as_deref().ok_or_else(|| {
                    ContractError::new("missing-field", "chat_id is required")
                })?)
            }
            "messages" => {
                require_page_limit(self.limit)?;
                require_cursor(&self.cursor)?;
                validate_chat_id(self.chat_id.as_deref().ok_or_else(|| {
                    ContractError::new("missing-field", "chat_id is required")
                })?)?;
                match self.direction.as_deref() {
                    Some("forward") | Some("backward") => Ok(()),
                    _ => Err(ContractError::new(
                        "invalid-direction",
                        "message direction must be forward or backward",
                    )),
                }
            }
            _ => Err(ContractError::new(
                "unknown-selector",
                "query selector is not in the closed contract",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ChangeStatus {
    Changed,
    ResyncRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResourceChanged {
    pub protocol: String,
    pub uri: String,
    pub head: Option<String>,
    pub revision: u64,
    pub status: ChangeStatus,
}

impl ResourceChanged {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, CHANGED_PROTOCOL)?;
        validate_resource_uri(&self.uri)?;
        match (&self.status, &self.head) {
            (ChangeStatus::Changed, Some(head)) => validate_hex(head, 64, "invalid-head"),
            (ChangeStatus::Changed, None) => Err(ContractError::new(
                "missing-head",
                "changed event requires a head",
            )),
            (ChangeStatus::ResyncRequired, None) => Ok(()),
            (ChangeStatus::ResyncRequired, Some(_)) => Err(ContractError::new(
                "invalid-head",
                "resync-required does not claim a current head",
            )),
        }
    }
}

pub fn validate_resource_uri(uri: &str) -> Result<(), ContractError> {
    if matches!(
        uri,
        crate::CHATS_COLLECTION_URI | PACKAGES_URI | IDENTITIES_URI
    ) {
        return Ok(());
    }
    let Some(chat_id) = uri.strip_prefix("greenways:tahto/chat/") else {
        return Err(ContractError::new(
            "invalid-resource-uri",
            "resource URI is outside the closed contract",
        ));
    };
    validate_chat_id(chat_id)
}

pub(crate) fn validate_chat_id(value: &str) -> Result<(), ContractError> {
    validate_hex(value, 32, "invalid-chat-id")
}

pub(crate) fn validate_entity_id(value: &str) -> Result<(), ContractError> {
    if !(32..=64).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ContractError::new(
            "invalid-entity-id",
            "entity ID must be 32 to 64 lowercase hexadecimal characters",
        ));
    }
    Ok(())
}

pub(crate) fn validate_hex(
    value: &str,
    exact_len: usize,
    code: &'static str,
) -> Result<(), ContractError> {
    if value.len() != exact_len
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ContractError::new(
            code,
            "value is not the required lowercase hexadecimal identifier",
        ));
    }
    Ok(())
}

pub(crate) fn validate_bounded_text(
    value: &str,
    min_bytes: usize,
    max_bytes: usize,
    code: &'static str,
) -> Result<(), ContractError> {
    if value.len() < min_bytes || value.len() > max_bytes {
        return Err(ContractError::new(
            code,
            "text is outside the public byte bound",
        ));
    }
    Ok(())
}

pub(crate) fn require_protocol(actual: &str, expected: &str) -> Result<(), ContractError> {
    if actual != expected {
        return Err(ContractError::new(
            "protocol-mismatch",
            "value uses an unsupported protocol",
        ));
    }
    Ok(())
}

fn require_page_limit(limit: Option<u16>) -> Result<(), ContractError> {
    match limit {
        Some(value) if (1..=MAX_PAGE_ITEMS).contains(&value) => Ok(()),
        _ => Err(ContractError::new(
            "invalid-limit",
            "query limit must be between 1 and 100",
        )),
    }
}

fn require_cursor(cursor: &Option<String>) -> Result<(), ContractError> {
    match cursor {
        Some(value) if value.len() > MAX_CURSOR_BYTES => Err(ContractError::new(
            "invalid-cursor",
            "query cursor exceeds the public byte bound",
        )),
        _ => Ok(()),
    }
}

fn require_absent<T>(value: &Option<T>, field: &'static str) -> Result<(), ContractError> {
    if value.is_some() {
        return Err(ContractError::new(
            "unexpected-field",
            match field {
                "chat_id" => "chat_id is not allowed for this selector",
                "limit" => "limit is not allowed for this selector",
                "cursor" => "cursor is not allowed for this selector",
                "direction" => "direction is not allowed for this selector",
                _ => "field is not allowed for this selector",
            },
        ));
    }
    Ok(())
}
