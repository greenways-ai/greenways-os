use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{error::Error, fmt};

pub const LOCAL_PROTOCOL: &str = "greenways-local/0-alpha";
pub const LOCAL_RESULT_PROTOCOL: &str = "greenways-local-result/0-alpha";
pub const DAEMON_STATUS_PROTOCOL: &str = "greenways-daemon-status/0-alpha";
pub const DAEMON_PATHS_PROTOCOL: &str = "greenways-daemon-paths/0-alpha";
pub const VAULT_STATUS_PROTOCOL: &str = "greenways-vault-status/0-alpha";
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;

const REQUEST_PREFIX: &str = "local/request/";
const NODE_PREFIX: &str = "node/";
const DIGEST_PREFIX: &str = "sha256:";
const MIN_REQUEST_SUFFIX: usize = 8;
const MAX_REQUEST_ID: usize = 180;
const MAX_ERROR_CODE: usize = 80;
const MAX_ERROR_MESSAGE: usize = 400;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalRequest {
    pub protocol: String,
    pub request_id: String,
    pub operation: String,
    #[serde(default)]
    pub arguments: Map<String, Value>,
}

impl LocalRequest {
    pub fn status(request_id: impl Into<String>) -> Self {
        Self {
            protocol: LOCAL_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            operation: "status".to_owned(),
            arguments: Map::new(),
        }
    }

    pub fn paths(request_id: impl Into<String>) -> Self {
        Self {
            protocol: LOCAL_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            operation: "paths".to_owned(),
            arguments: Map::new(),
        }
    }

    pub fn vault_status(request_id: impl Into<String>) -> Self {
        Self {
            protocol: LOCAL_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            operation: "vault.status".to_owned(),
            arguments: Map::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalResponse {
    pub protocol: String,
    pub request_id: String,
    pub outcome: Outcome,
    pub value: Option<Value>,
    pub error: Option<PublicError>,
}

impl LocalResponse {
    pub fn ok(request_id: impl Into<String>, value: Value) -> Self {
        Self {
            protocol: LOCAL_RESULT_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            outcome: Outcome::Ok,
            value: Some(value),
            error: None,
        }
    }

    pub fn error(
        request_id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            protocol: LOCAL_RESULT_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            outcome: Outcome::Error,
            value: None,
            error: Some(PublicError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonStatus {
    pub protocol: String,
    pub node_id: String,
    pub daemon_version: String,
    pub local_protocol: String,
    pub generation: u64,
    pub state_revision: u64,
    pub process_id: u32,
    pub started_at_unix_ms: u64,
    pub observed_at_unix_ms: u64,
    pub profile_mode: String,
    pub authority_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonPaths {
    pub protocol: String,
    pub home: String,
    pub state_file: String,
    pub socket_file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VaultStatus {
    pub protocol: String,
    pub metadata_state: String,
    pub credential_store: String,
    pub provider_profile_count: u64,
    pub secret_projection: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    code: &'static str,
    message: String,
}

impl ProtocolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for ProtocolError {}

pub fn decode_request(bytes: &[u8]) -> Result<LocalRequest, ProtocolError> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(ProtocolError::new(
            "request-too-large",
            "Greenways local requests are limited to 64 KiB.",
        ));
    }
    let request: LocalRequest = serde_json::from_slice(bytes).map_err(|_| {
        ProtocolError::new(
            "invalid-request",
            "Greenways local request must be one closed JSON object.",
        )
    })?;
    validate_request(&request)?;
    Ok(request)
}

pub fn validate_request(request: &LocalRequest) -> Result<(), ProtocolError> {
    if request.protocol != LOCAL_PROTOCOL {
        return Err(ProtocolError::new(
            "unsupported-protocol",
            "Greenways local request protocol is unsupported.",
        ));
    }
    if !valid_request_id(&request.request_id) {
        return Err(ProtocolError::new(
            "invalid-request-id",
            "Greenways local request ID is invalid.",
        ));
    }
    if !matches!(
        request.operation.as_str(),
        "status" | "paths" | "vault.status"
    ) {
        return Err(ProtocolError::new(
            "unsupported-operation",
            "Greenways local operation is not available.",
        ));
    }
    if !request.arguments.is_empty() {
        return Err(ProtocolError::new(
            "invalid-arguments",
            "This Greenways local operation accepts no arguments.",
        ));
    }
    Ok(())
}

pub fn decode_response(bytes: &[u8]) -> Result<LocalResponse, ProtocolError> {
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(ProtocolError::new(
            "response-too-large",
            "Greenways local response exceeded its size limit.",
        ));
    }
    let response: LocalResponse = serde_json::from_slice(bytes).map_err(|_| {
        ProtocolError::new(
            "invalid-response",
            "Greenways local response must be one closed JSON object.",
        )
    })?;
    validate_response(&response)?;
    Ok(response)
}

pub fn validate_response(response: &LocalResponse) -> Result<(), ProtocolError> {
    if response.protocol != LOCAL_RESULT_PROTOCOL {
        return Err(ProtocolError::new(
            "unsupported-response-protocol",
            "Greenways local response protocol is unsupported.",
        ));
    }
    if !valid_request_id(&response.request_id) {
        return Err(ProtocolError::new(
            "invalid-response-id",
            "Greenways local response request ID is invalid.",
        ));
    }
    match response.outcome {
        Outcome::Ok if response.value.is_some() && response.error.is_none() => {}
        Outcome::Error if response.value.is_none() && response.error.is_some() => {}
        _ => {
            return Err(ProtocolError::new(
                "invalid-response-state",
                "Greenways local response state is inconsistent.",
            ));
        }
    }
    if let Some(error) = &response.error {
        if !valid_token(&error.code, MAX_ERROR_CODE)
            || error.message.is_empty()
            || error.message.len() > MAX_ERROR_MESSAGE
        {
            return Err(ProtocolError::new(
                "invalid-response-error",
                "Greenways local response error is invalid.",
            ));
        }
    }
    Ok(())
}

pub fn canonical_request(request: &LocalRequest) -> Result<Vec<u8>, ProtocolError> {
    validate_request(request)?;
    serde_json::to_vec(request).map_err(|_| {
        ProtocolError::new(
            "invalid-request",
            "Greenways local request could not be canonicalized.",
        )
    })
}

pub fn request_digest(request: &LocalRequest) -> Result<String, ProtocolError> {
    let canonical = canonical_request(request)?;
    let digest = Sha256::digest(canonical);
    Ok(format!("{DIGEST_PREFIX}{}", encode_hex(&digest)))
}

pub fn encode_request_line(request: &LocalRequest) -> Result<Vec<u8>, ProtocolError> {
    validate_request(request)?;
    encode_line(request, MAX_REQUEST_BYTES, "request-too-large")
}

pub fn encode_response_line(response: &LocalResponse) -> Result<Vec<u8>, ProtocolError> {
    validate_response(response)?;
    encode_line(response, MAX_RESPONSE_BYTES, "response-too-large")
}

pub fn new_request_id() -> Result<String, ProtocolError> {
    random_identifier(REQUEST_PREFIX, 16, "request-randomness-unavailable")
}

pub fn new_node_id() -> Result<String, ProtocolError> {
    random_identifier(NODE_PREFIX, 16, "node-randomness-unavailable")
}

pub fn valid_request_id(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix(REQUEST_PREFIX) else {
        return false;
    };
    value.len() <= MAX_REQUEST_ID
        && suffix.len() >= MIN_REQUEST_SUFFIX
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

pub fn validate_node_id(value: &str) -> bool {
    value
        .strip_prefix(NODE_PREFIX)
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(is_lower_hex))
}

pub fn validate_digest(value: &str) -> bool {
    value
        .strip_prefix(DIGEST_PREFIX)
        .is_some_and(|suffix| suffix.len() == 64 && suffix.bytes().all(is_lower_hex))
}

fn encode_line<T: Serialize>(
    value: &T,
    maximum: usize,
    code: &'static str,
) -> Result<Vec<u8>, ProtocolError> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| {
        ProtocolError::new(
            "invalid-message",
            "Greenways local message could not be encoded.",
        )
    })?;
    if bytes.len() + 1 > maximum {
        return Err(ProtocolError::new(
            code,
            "Greenways local message exceeded its size limit.",
        ));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

fn random_identifier(
    prefix: &str,
    byte_count: usize,
    code: &'static str,
) -> Result<String, ProtocolError> {
    let mut bytes = vec![0_u8; byte_count];
    getrandom(&mut bytes).map_err(|_| {
        ProtocolError::new(code, "Secure operating-system randomness is unavailable.")
    })?;
    Ok(format!("{prefix}{}", encode_hex(&bytes)))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn valid_token(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_closed_status_request() {
        let request = LocalRequest::status("local/request/12345678");
        let encoded = encode_request_line(&request).expect("request should encode");
        let decoded = decode_request(&encoded).expect("request should decode");
        assert_eq!(decoded, request);
        assert!(request_digest(&decoded)
            .expect("request should hash")
            .starts_with("sha256:"));
    }

    #[test]
    fn rejects_unknown_request_fields_and_arguments() {
        let unknown = br#"{"protocol":"greenways-local/0-alpha","requestId":"local/request/12345678","operation":"status","arguments":{},"extra":true}"#;
        assert_eq!(
            decode_request(unknown)
                .expect_err("unknown fields must fail")
                .code(),
            "invalid-request"
        );

        let arguments = br#"{"protocol":"greenways-local/0-alpha","requestId":"local/request/12345678","operation":"status","arguments":{"detail":true}}"#;
        assert_eq!(
            decode_request(arguments)
                .expect_err("unexpected arguments must fail")
                .code(),
            "invalid-arguments"
        );
    }

    #[test]
    fn validates_response_outcome_shape() {
        let response =
            LocalResponse::ok("local/request/12345678", serde_json::json!({"ready": true}));
        let encoded = encode_response_line(&response).expect("response should encode");
        assert_eq!(
            decode_response(&encoded).expect("response should decode"),
            response
        );

        let invalid = LocalResponse {
            protocol: LOCAL_RESULT_PROTOCOL.to_owned(),
            request_id: "local/request/12345678".to_owned(),
            outcome: Outcome::Ok,
            value: None,
            error: None,
        };
        assert_eq!(
            validate_response(&invalid)
                .expect_err("inconsistent response must fail")
                .code(),
            "invalid-response-state"
        );
    }

    #[test]
    fn creates_closed_random_identifiers() {
        let request_id = new_request_id().expect("request ID should be created");
        let node_id = new_node_id().expect("node ID should be created");
        assert!(valid_request_id(&request_id));
        assert!(validate_node_id(&node_id));
    }
}
