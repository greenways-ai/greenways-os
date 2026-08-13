use crate::{
    resource::{
        require_protocol, validate_bounded_text, validate_chat_id, validate_entity_id,
        validate_hex, TRANSACTION_PROTOCOL,
    },
    ContractError,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const CHATS_PROFILE: &str = "greenways.chats/0-alpha";
pub const CHAT_PROTOCOL: &str = "greenways.chats.chat/0-alpha";
pub const MESSAGE_PROTOCOL: &str = "greenways.chats.message/0-alpha";
pub const CHATS_COLLECTION_URI: &str = "greenways:tahto/collection/chats";
pub const MAX_TITLE_BYTES: usize = 512;
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EntityLink {
    pub kind: String,
    pub id: String,
}

impl EntityLink {
    fn validate_message(&self) -> Result<(), ContractError> {
        if self.kind != "message" {
            return Err(ContractError::new(
                "invalid-link",
                "chat link must target a message",
            ));
        }
        validate_entity_id(&self.id)
    }

    fn validate_chat(&self) -> Result<(), ContractError> {
        if self.kind != "chat" {
            return Err(ContractError::new(
                "invalid-link",
                "message link must target a chat",
            ));
        }
        validate_chat_id(&self.id)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChatSource {
    pub kind: String,
    pub reference: String,
}

impl ChatSource {
    fn validate(&self) -> Result<(), ContractError> {
        validate_bounded_text(&self.kind, 1, 64, "invalid-source")?;
        validate_bounded_text(&self.reference, 1, 512, "invalid-source")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChatEntity {
    pub protocol: String,
    pub id: String,
    pub title: String,
    pub source: ChatSource,
    pub created_at: i64,
    pub updated_at: i64,
    pub message_count: u64,
    pub messages: Vec<EntityLink>,
}

impl ChatEntity {
    fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, CHAT_PROTOCOL)?;
        validate_chat_id(&self.id)?;
        validate_title(&self.title)?;
        self.source.validate()?;
        if self.updated_at < self.created_at {
            return Err(ContractError::new(
                "invalid-time",
                "chat update time precedes creation time",
            ));
        }
        if self.messages.len() > usize::from(crate::MAX_PAGE_ITEMS) {
            return Err(ContractError::new(
                "invalid-message-links",
                "chat message links exceed one bounded page",
            ));
        }
        for link in &self.messages {
            link.validate_message()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MessageEntity {
    pub protocol: String,
    pub id: String,
    pub role: MessageRole,
    pub content: String,
    pub created_at: i64,
    pub chat: EntityLink,
}

impl MessageEntity {
    fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, MESSAGE_PROTOCOL)?;
        validate_entity_id(&self.id)?;
        validate_bounded_text(&self.content, 0, MAX_MESSAGE_BYTES, "invalid-content")?;
        self.chat.validate_chat()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mutation", deny_unknown_fields)]
pub enum TransactionRequest {
    #[serde(rename = "chat.capture")]
    ChatCapture {
        protocol: String,
        uri: String,
        expected_head: String,
        chat: ChatEntity,
        messages: Vec<MessageEntity>,
    },
    #[serde(rename = "chat.title.set")]
    ChatTitleSet {
        protocol: String,
        uri: String,
        expected_head: String,
        chat_id: String,
        title: String,
    },
}

impl TransactionRequest {
    pub fn validate(&self) -> Result<(), ContractError> {
        match self {
            Self::ChatCapture {
                protocol,
                uri,
                expected_head,
                chat,
                messages,
            } => {
                validate_transaction_common(protocol, uri, expected_head)?;
                chat.validate()?;
                if messages.len() > usize::from(crate::MAX_PAGE_ITEMS) {
                    return Err(ContractError::new(
                        "invalid-messages",
                        "capture exceeds one bounded message page",
                    ));
                }
                if chat.message_count != messages.len() as u64
                    || chat.messages.len() != messages.len()
                {
                    return Err(ContractError::new(
                        "invalid-messages",
                        "chat message count and links must match capture messages",
                    ));
                }
                let linked = chat
                    .messages
                    .iter()
                    .map(|link| link.id.as_str())
                    .collect::<BTreeSet<_>>();
                let mut observed = BTreeSet::new();
                for message in messages {
                    message.validate()?;
                    if message.chat.id != chat.id || !observed.insert(message.id.as_str()) {
                        return Err(ContractError::new(
                            "invalid-messages",
                            "message parent or identity is invalid",
                        ));
                    }
                }
                if linked != observed {
                    return Err(ContractError::new(
                        "invalid-messages",
                        "chat links and capture messages differ",
                    ));
                }
                Ok(())
            }
            Self::ChatTitleSet {
                protocol,
                uri,
                expected_head,
                chat_id,
                title,
            } => {
                validate_transaction_common(protocol, uri, expected_head)?;
                validate_chat_id(chat_id)?;
                validate_title(title)
            }
        }
    }
}

pub fn chat_uri(chat_id: &str) -> Result<String, ContractError> {
    validate_chat_id(chat_id)?;
    Ok(format!("greenways:tahto/chat/{chat_id}"))
}

fn validate_transaction_common(
    protocol: &str,
    uri: &str,
    expected_head: &str,
) -> Result<(), ContractError> {
    require_protocol(protocol, TRANSACTION_PROTOCOL)?;
    if uri != CHATS_COLLECTION_URI {
        return Err(ContractError::new(
            "invalid-resource-uri",
            "Chats mutation requires the collection URI",
        ));
    }
    validate_hex(expected_head, 64, "invalid-head")
}

fn validate_title(value: &str) -> Result<(), ContractError> {
    validate_bounded_text(value, 1, MAX_TITLE_BYTES, "invalid-title")
}
