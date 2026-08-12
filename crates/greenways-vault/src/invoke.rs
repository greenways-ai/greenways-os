use super::{ProviderKind, VaultError};
use greenways_provider::{
    ModelMessageRole, ProviderInvocation, ProviderResult, ProviderUsage, MAX_PROVIDER_OUTPUT_CHARS,
    PROVIDER_RESULT_PROTOCOL,
};
use serde_json::{json, Value};
use std::{io::Read, str, time::Duration};

const OPENAI_ENDPOINT: &str = "https://api.openai.com/v1/responses";
const ANTHROPIC_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const OPENROUTER_ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";
const MAX_PROVIDER_RESPONSE_BYTES: usize = 1024 * 1024;

pub(super) trait ProviderTransport: Send + Sync {
    fn invoke(
        &self,
        provider: ProviderKind,
        secret: &[u8],
        invocation: &ProviderInvocation,
        completed_at_unix_ms: u64,
    ) -> Result<ProviderResult, ProviderCallError>;
}

#[derive(Debug, Default)]
pub(super) struct SystemProviderTransport;

impl ProviderTransport for SystemProviderTransport {
    fn invoke(
        &self,
        provider: ProviderKind,
        secret: &[u8],
        invocation: &ProviderInvocation,
        completed_at_unix_ms: u64,
    ) -> Result<ProviderResult, ProviderCallError> {
        let secret = str::from_utf8(secret).map_err(|_| ProviderCallError::Rejected)?;
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_millis(invocation.timeout_ms))
            .redirects(0)
            .build();
        let body = provider_request_body(provider, invocation)?;
        let request = match provider {
            ProviderKind::OpenAi => agent
                .post(OPENAI_ENDPOINT)
                .set("Authorization", &format!("Bearer {secret}"))
                .set("Content-Type", "application/json"),
            ProviderKind::Anthropic => agent
                .post(ANTHROPIC_ENDPOINT)
                .set("x-api-key", secret)
                .set("anthropic-version", "2023-06-01")
                .set("Content-Type", "application/json"),
            ProviderKind::OpenRouter => agent
                .post(OPENROUTER_ENDPOINT)
                .set("Authorization", &format!("Bearer {secret}"))
                .set("Content-Type", "application/json")
                .set("X-Title", "Greenways OS"),
        };
        let response = match request.send_json(body) {
            Ok(response) if (200..300).contains(&response.status()) => response,
            Ok(_) => return Err(ProviderCallError::Uncertain),
            Err(ureq::Error::Status(code, _)) if (400..500).contains(&code) => {
                return Err(ProviderCallError::Rejected)
            }
            Err(_) => return Err(ProviderCallError::Uncertain),
        };
        let data = bounded_json(response)?;
        normalized_result(provider, invocation, &data, completed_at_unix_ms)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ProviderCallError {
    Rejected,
    Uncertain,
}

impl From<ProviderCallError> for VaultError {
    fn from(value: ProviderCallError) -> Self {
        match value {
            ProviderCallError::Rejected => Self::ProviderRejected,
            ProviderCallError::Uncertain => Self::ProviderUncertain,
        }
    }
}

fn provider_request_body(
    provider: ProviderKind,
    invocation: &ProviderInvocation,
) -> Result<Value, ProviderCallError> {
    match provider {
        ProviderKind::OpenAi => Ok(json!({
            "model": invocation.model,
            "input": invocation.messages,
            "max_output_tokens": invocation.max_output_tokens,
            "store": false,
        })),
        ProviderKind::OpenRouter => Ok(json!({
            "model": invocation.model,
            "messages": invocation.messages,
            "max_tokens": invocation.max_output_tokens,
            "stream": false,
        })),
        ProviderKind::Anthropic => {
            let system = invocation
                .messages
                .iter()
                .filter(|message| message.role == ModelMessageRole::System)
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>()
                .join("\n\n");
            let messages = invocation
                .messages
                .iter()
                .filter(|message| message.role != ModelMessageRole::System)
                .collect::<Vec<_>>();
            if messages.is_empty() {
                return Err(ProviderCallError::Rejected);
            }
            let mut body = json!({
                "model": invocation.model,
                "max_tokens": invocation.max_output_tokens,
                "messages": messages,
            });
            if !system.is_empty() {
                body.as_object_mut()
                    .expect("Anthropic provider body is an object")
                    .insert("system".to_owned(), Value::String(system));
            }
            Ok(body)
        }
    }
}

fn bounded_json(response: ureq::Response) -> Result<Value, ProviderCallError> {
    if response
        .header("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_PROVIDER_RESPONSE_BYTES)
    {
        return Err(ProviderCallError::Uncertain);
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take((MAX_PROVIDER_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ProviderCallError::Uncertain)?;
    if bytes.len() > MAX_PROVIDER_RESPONSE_BYTES {
        return Err(ProviderCallError::Uncertain);
    }
    serde_json::from_slice(&bytes).map_err(|_| ProviderCallError::Uncertain)
}

fn normalized_result(
    provider: ProviderKind,
    invocation: &ProviderInvocation,
    data: &Value,
    completed_at_unix_ms: u64,
) -> Result<ProviderResult, ProviderCallError> {
    let output = match provider {
        ProviderKind::OpenAi => openai_output(data),
        ProviderKind::Anthropic => anthropic_output(data),
        ProviderKind::OpenRouter => openrouter_output(data),
    };
    if output.is_empty() || output.chars().count() > MAX_PROVIDER_OUTPUT_CHARS {
        return Err(ProviderCallError::Uncertain);
    }
    let result = ProviderResult {
        protocol: PROVIDER_RESULT_PROTOCOL.to_owned(),
        provider: provider.as_str().to_owned(),
        profile_id: invocation.profile_id.clone(),
        model: invocation.model.clone(),
        provider_response_id: bounded_response_id(data.get("id")),
        output,
        usage: provider_usage(provider, data),
        completed_at_unix_ms,
    };
    result
        .validate()
        .map_err(|_| ProviderCallError::Uncertain)?;
    Ok(result)
}

fn openai_output(data: &Value) -> String {
    if let Some(output) = data.get("output_text").and_then(Value::as_str) {
        if !output.is_empty() {
            return output.to_owned();
        }
    }
    data.get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>()
}

fn anthropic_output(data: &Value) -> String {
    data.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>()
}

fn openrouter_output(data: &Value) -> String {
    data.get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn provider_usage(provider: ProviderKind, data: &Value) -> Option<ProviderUsage> {
    let usage = data.get("usage")?;
    let (input_tokens, output_tokens, total_tokens) = match provider {
        ProviderKind::OpenAi | ProviderKind::Anthropic => (
            token(usage.get("input_tokens")),
            token(usage.get("output_tokens")),
            token(usage.get("total_tokens")),
        ),
        ProviderKind::OpenRouter => (
            token(usage.get("prompt_tokens")),
            token(usage.get("completion_tokens")),
            token(usage.get("total_tokens")),
        ),
    };
    let total_tokens = total_tokens.or_else(|| match (input_tokens, output_tokens) {
        (Some(input), Some(output)) => input.checked_add(output),
        _ => None,
    });
    if input_tokens.is_none() && output_tokens.is_none() && total_tokens.is_none() {
        None
    } else {
        Some(ProviderUsage {
            input_tokens,
            output_tokens,
            total_tokens,
        })
    }
}

fn token(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_u64)
}

fn bounded_response_id(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?;
    if value.is_empty()
        || value.len() > 200
        || !value.as_bytes().iter().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-')
        })
    {
        None
    } else {
        Some(value.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use greenways_provider::{ModelMessage, ProviderInvocation};

    fn invocation() -> ProviderInvocation {
        ProviderInvocation::new(
            "openai.personal",
            "gpt-5",
            vec![ModelMessage {
                role: ModelMessageRole::User,
                content: "Hello".to_owned(),
            }],
            128,
            5_000,
        )
        .expect("invocation")
    }

    #[test]
    fn fixes_provider_endpoints_and_request_shapes() {
        let invocation = invocation();
        let openai = provider_request_body(ProviderKind::OpenAi, &invocation).expect("openai body");
        assert_eq!(openai["store"], false);
        assert!(openai.get("endpoint").is_none());
        let router =
            provider_request_body(ProviderKind::OpenRouter, &invocation).expect("router body");
        assert_eq!(router["stream"], false);
        let anthropic =
            provider_request_body(ProviderKind::Anthropic, &invocation).expect("anthropic body");
        assert_eq!(anthropic["messages"].as_array().expect("messages").len(), 1);
    }

    #[test]
    fn normalizes_all_provider_text_shapes() {
        let invocation = invocation();
        let openai = normalized_result(
            ProviderKind::OpenAi,
            &invocation,
            &json!({
                "id": "resp_12345678",
                "output": [{"type": "message", "content": [{"type": "output_text", "text": "hello"}]}],
                "usage": {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3}
            }),
            1,
        )
        .expect("openai result");
        assert_eq!(openai.output, "hello");

        let anthropic = normalized_result(
            ProviderKind::Anthropic,
            &invocation,
            &json!({"id": "msg_12345678", "content": [{"type": "text", "text": "hello"}]}),
            1,
        )
        .expect("anthropic result");
        assert_eq!(anthropic.output, "hello");

        let router = normalized_result(
            ProviderKind::OpenRouter,
            &invocation,
            &json!({"id": "gen_12345678", "choices": [{"message": {"content": "hello"}}]}),
            1,
        )
        .expect("router result");
        assert_eq!(router.output, "hello");
    }
}
