use serde::{Deserialize, Serialize};
use std::{error::Error, fmt};

pub const ERROR_PROTOCOL: &str = "greenways.error/0-alpha";
pub const MAX_PUBLIC_ERROR_BYTES: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractError {
    pub code: &'static str,
    pub message: &'static str,
}

impl ContractError {
    pub const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl fmt::Display for ContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for ContractError {}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    Disconnect,
    Timeout,
    Cancelled,
    ProtocolMismatch,
    MalformedHta,
    NoncanonicalHta,
    RequestTooLarge,
    ResponseTooLarge,
    UnknownFrame,
    UnknownAction,
    UnknownField,
    ForgedContext,
    AuthorizationDenied,
    RequestIdCollision,
    StaleHead,
    ResyncRequired,
    ResourceUnavailable,
    RuntimeFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PublicFailure {
    pub protocol: String,
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
}

impl PublicFailure {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.protocol != ERROR_PROTOCOL {
            return Err(ContractError::new(
                "protocol-mismatch",
                "failure uses an unsupported protocol",
            ));
        }
        if self.message.is_empty() || self.message.len() > MAX_PUBLIC_ERROR_BYTES {
            return Err(ContractError::new(
                "invalid-error-message",
                "failure message is outside the public byte bound",
            ));
        }
        Ok(())
    }
}
