use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{error::Error, fmt};

pub const PROVIDER_INVOCATION_PROTOCOL: &str = "greenways-provider-invocation/0-alpha";
pub const PROVIDER_RESULT_PROTOCOL: &str = "greenways-provider-result/0-alpha";
pub const MAX_PROVIDER_MESSAGES: usize = 64;
pub const MAX_PROVIDER_MESSAGE_CHARS: usize = 64 * 1024;
pub const MAX_PROVIDER_INPUT_BYTES: usize = 60 * 1024;
pub const MAX_PROVIDER_OUTPUT_CHARS: usize = 64 * 1024;
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 2_048;
pub const MAX_OUTPUT_TOKENS: u32 = 8_192;
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
pub const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ModelMessageRole {
    System,
    User,
    Assistant,
}

impl ModelMessageRole {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelMessage {
    pub role: ModelMessageRole,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderInvocation {
    pub protocol: String,
    pub profile_id: String,
    pub model: String,
    pub messages: Vec<ModelMessage>,
    pub max_output_tokens: u32,
    pub timeout_ms: u64,
}

impl ProviderInvocation {
    pub fn new(
        profile_id: impl Into<String>,
        model: impl Into<String>,
        messages: Vec<ModelMessage>,
        max_output_tokens: u32,
        timeout_ms: u64,
    ) -> Result<Self, ProviderProtocolError> {
        let invocation = Self {
            protocol: PROVIDER_INVOCATION_PROTOCOL.to_owned(),
            profile_id: profile_id.into(),
            model: model.into(),
            messages,
            max_output_tokens,
            timeout_ms,
        };
        validate_invocation(&invocation)?;
        Ok(invocation)
    }

    pub fn from_arguments(arguments: &Map<String, Value>) -> Result<Self, ProviderProtocolError> {
        let invocation: Self =
            serde_json::from_value(Value::Object(arguments.clone())).map_err(|_| {
                ProviderProtocolError::new(
                    "invalid-provider-invocation",
                    "Provider invocation arguments must be one closed object.",
                )
            })?;
        validate_invocation(&invocation)?;
        Ok(invocation)
    }

    pub fn into_arguments(self) -> Result<Map<String, Value>, ProviderProtocolError> {
        validate_invocation(&self)?;
        match serde_json::to_value(self).map_err(|_| {
            ProviderProtocolError::new(
                "invalid-provider-invocation",
                "Provider invocation could not be encoded.",
            )
        })? {
            Value::Object(arguments) => Ok(arguments),
            _ => Err(ProviderProtocolError::new(
                "invalid-provider-invocation",
                "Provider invocation must encode as an object.",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderResult {
    pub protocol: String,
    pub provider: String,
    pub profile_id: String,
    pub model: String,
    pub provider_response_id: Option<String>,
    pub output: String,
    pub usage: Option<ProviderUsage>,
    pub completed_at_unix_ms: u64,
}

impl ProviderResult {
    pub fn validate(&self) -> Result<(), ProviderProtocolError> {
        validate_result(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderProtocolError {
    code: &'static str,
    message: String,
}

impl ProviderProtocolError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ProviderProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for ProviderProtocolError {}

pub fn validate_invocation(invocation: &ProviderInvocation) -> Result<(), ProviderProtocolError> {
    if invocation.protocol != PROVIDER_INVOCATION_PROTOCOL {
        return Err(ProviderProtocolError::new(
            "unsupported-provider-protocol",
            "Provider invocation protocol is unsupported.",
        ));
    }
    validate_profile_id(&invocation.profile_id)?;
    validate_model_id(&invocation.model)?;
    if invocation.messages.is_empty() || invocation.messages.len() > MAX_PROVIDER_MESSAGES {
        return Err(ProviderProtocolError::new(
            "invalid-provider-messages",
            format!("Provider invocation must contain 1 to {MAX_PROVIDER_MESSAGES} messages."),
        ));
    }
    for message in &invocation.messages {
        if message.content.trim().is_empty()
            || message.content.chars().count() > MAX_PROVIDER_MESSAGE_CHARS
        {
            return Err(ProviderProtocolError::new(
                "invalid-provider-message",
                "Provider message content is empty or exceeds its character limit.",
            ));
        }
    }
    if !(1..=MAX_OUTPUT_TOKENS).contains(&invocation.max_output_tokens) {
        return Err(ProviderProtocolError::new(
            "invalid-provider-output-limit",
            format!("Provider output limit must be from 1 to {MAX_OUTPUT_TOKENS}."),
        ));
    }
    if !(1_000..=MAX_TIMEOUT_MS).contains(&invocation.timeout_ms) {
        return Err(ProviderProtocolError::new(
            "invalid-provider-timeout",
            format!("Provider timeout must be from 1000 to {MAX_TIMEOUT_MS} milliseconds."),
        ));
    }
    let bytes = serde_json::to_vec(invocation).map_err(|_| {
        ProviderProtocolError::new(
            "invalid-provider-invocation",
            "Provider invocation could not be measured.",
        )
    })?;
    if bytes.len() > MAX_PROVIDER_INPUT_BYTES {
        return Err(ProviderProtocolError::new(
            "provider-input-too-large",
            "Provider invocation exceeds its input byte limit.",
        ));
    }
    Ok(())
}

pub fn validate_result(result: &ProviderResult) -> Result<(), ProviderProtocolError> {
    if result.protocol != PROVIDER_RESULT_PROTOCOL {
        return Err(ProviderProtocolError::new(
            "unsupported-provider-result-protocol",
            "Provider result protocol is unsupported.",
        ));
    }
    if !matches!(
        result.provider.as_str(),
        "openai" | "anthropic" | "openrouter"
    ) {
        return Err(ProviderProtocolError::new(
            "invalid-provider-result",
            "Provider result identifies an unsupported provider.",
        ));
    }
    validate_profile_id(&result.profile_id)?;
    validate_model_id(&result.model)?;
    if result
        .provider_response_id
        .as_ref()
        .is_some_and(|value| !valid_bounded_token(value, 200))
    {
        return Err(ProviderProtocolError::new(
            "invalid-provider-result",
            "Provider response identifier is invalid.",
        ));
    }
    if result.output.is_empty() || result.output.chars().count() > MAX_PROVIDER_OUTPUT_CHARS {
        return Err(ProviderProtocolError::new(
            "invalid-provider-output",
            "Provider output is empty or exceeds its character limit.",
        ));
    }
    if result.completed_at_unix_ms == 0 {
        return Err(ProviderProtocolError::new(
            "invalid-provider-result",
            "Provider completion time must be positive.",
        ));
    }
    if let Some(usage) = &result.usage {
        if let (Some(input), Some(output), Some(total)) =
            (usage.input_tokens, usage.output_tokens, usage.total_tokens)
        {
            if input.checked_add(output).is_none_or(|sum| total < sum) {
                return Err(ProviderProtocolError::new(
                    "invalid-provider-usage",
                    "Provider usage totals are inconsistent.",
                ));
            }
        }
    }
    Ok(())
}

fn validate_profile_id(value: &str) -> Result<(), ProviderProtocolError> {
    let bytes = value.as_bytes();
    if value.is_empty()
        || value.len() > 80
        || !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        || !bytes.iter().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
    {
        return Err(ProviderProtocolError::new(
            "invalid-provider-profile-id",
            "Provider profile ID is invalid.",
        ));
    }
    Ok(())
}

fn validate_model_id(value: &str) -> Result<(), ProviderProtocolError> {
    if value.is_empty()
        || value.len() > 160
        || value.contains("://")
        || !value.as_bytes().iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
    {
        return Err(ProviderProtocolError::new(
            "invalid-provider-model-id",
            "Provider model ID is invalid.",
        ));
    }
    Ok(())
}

fn valid_bounded_token(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.as_bytes().iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invocation() -> ProviderInvocation {
        ProviderInvocation::new(
            "openai.personal",
            "gpt-5",
            vec![ModelMessage {
                role: ModelMessageRole::User,
                content: "Hello".to_owned(),
            }],
            DEFAULT_MAX_OUTPUT_TOKENS,
            DEFAULT_TIMEOUT_MS,
        )
        .expect("provider invocation should be valid")
    }

    #[test]
    fn round_trips_one_closed_provider_invocation() {
        let invocation = invocation();
        let arguments = invocation.clone().into_arguments().expect("arguments");
        assert_eq!(
            ProviderInvocation::from_arguments(&arguments).expect("decoded invocation"),
            invocation
        );
        let mut changed = arguments;
        changed.insert(
            "endpoint".to_owned(),
            Value::String("https://evil.example".to_owned()),
        );
        assert!(ProviderInvocation::from_arguments(&changed).is_err());
    }

    #[test]
    fn rejects_unbounded_or_endpoint_shaped_requests() {
        assert!(ProviderInvocation::new(
            "openai.personal",
            "https://evil.example/model",
            vec![ModelMessage {
                role: ModelMessageRole::User,
                content: "Hello".to_owned(),
            }],
            1,
            1_000,
        )
        .is_err());
        assert!(ProviderInvocation::new("openai.personal", "gpt-5", vec![], 1, 1_000,).is_err());
    }

    #[test]
    fn validates_normalized_provider_results() {
        let result = ProviderResult {
            protocol: PROVIDER_RESULT_PROTOCOL.to_owned(),
            provider: "openai".to_owned(),
            profile_id: "openai.personal".to_owned(),
            model: "gpt-5".to_owned(),
            provider_response_id: Some("resp_12345678".to_owned()),
            output: "Hello".to_owned(),
            usage: Some(ProviderUsage {
                input_tokens: Some(3),
                output_tokens: Some(2),
                total_tokens: Some(5),
            }),
            completed_at_unix_ms: 1,
        };
        assert!(result.validate().is_ok());
        let mut invalid = result;
        invalid.usage = Some(ProviderUsage {
            input_tokens: Some(3),
            output_tokens: Some(3),
            total_tokens: Some(5),
        });
        assert!(invalid.validate().is_err());
    }
}
