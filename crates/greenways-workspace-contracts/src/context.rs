use crate::ContractError;
use serde_json::Value;

const SERVER_CONTEXT_FIELDS: &[&str] = &[
    "actor",
    "actor_id",
    "role",
    "session",
    "session_id",
    "client_id",
    "application_approval",
    "capability_grant",
    "hestia_root",
    "membership_root",
    "mandate_root",
    "grant_root",
];

pub fn reject_server_context(value: &Value) -> Result<(), ContractError> {
    match value {
        Value::Object(fields) => {
            for (field, nested) in fields {
                if SERVER_CONTEXT_FIELDS.contains(&field.as_str()) {
                    return Err(ContractError::new(
                        "forged-context",
                        "request contains server-owned context",
                    ));
                }
                reject_server_context(nested)?;
            }
            Ok(())
        }
        Value::Array(values) => {
            for nested in values {
                reject_server_context(nested)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
