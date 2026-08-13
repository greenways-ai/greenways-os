mod import_status;

pub use import_status::{
    HestiaImportError, HestiaImportStatus, HESTIA_IMPORT_ARTIFACT_COUNT,
    HESTIA_IMPORT_PACKAGE, HESTIA_IMPORT_REPOSITORY, HESTIA_IMPORT_REVISION,
    HESTIA_IMPORT_STATE, HESTIA_IMPORT_STATUS_PROTOCOL, HESTIA_IMPORT_VERIFICATION_SCOPE,
};

use greenways_capabilities::{CapabilityDecision, CheckCapability, CAPABILITY_DECISION_PROTOCOL};
use greenways_identity::{validate_application_descriptor, ApplicationDescriptor};
use serde::{Deserialize, Serialize};
use std::{error::Error, fmt};

pub const HESTIA_ROOM_INVOCATION_PROTOCOL: &str = "hestia-room-invocation/0-alpha";
pub const HESTIA_ROOM_AUTHORITY_DECISION_PROTOCOL: &str = "hestia-room-authority-decision/0-alpha";
pub const LOCAL_ROOM_AUTHORITY_EVIDENCE_PROTOCOL: &str =
    "greenways-local-room-authority-evidence/0-alpha";
pub const PREPARED_ROOM_EXECUTION_PROTOCOL: &str = "greenways-prepared-room-execution/0-alpha";
pub const PREPARED_ROOM_EXECUTION_STATE: &str = "prepared";

const DIGEST_PREFIX: &str = "sha256:";
const GRANT_PREFIX: &str = "grant/";
const MAX_IDENTIFIER_BYTES: usize = 240;
const MAX_OPERATION_BYTES: usize = 160;
const MAX_CONTENT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HestiaApplicationIdentity {
    pub app_id: String,
    pub version: String,
    pub publisher_id: String,
    pub manifest_digest: String,
    pub lock_digest: Option<String>,
    pub approval_digest: String,
}

impl HestiaApplicationIdentity {
    pub fn validate(&self) -> Result<(), RoomExecutionError> {
        validate_application_descriptor(&ApplicationDescriptor {
            app_id: self.app_id.clone(),
            version: self.version.clone(),
            publisher_id: self.publisher_id.clone(),
            manifest_digest: self.manifest_digest.clone(),
            lock_digest: self.lock_digest.clone(),
        })
        .map_err(|_| {
            RoomExecutionError::new(
                "invalid-hestia-application",
                "Imported Hestia application identity is invalid.",
            )
        })?;
        validate_digest(&self.approval_digest, "Hestia application approval digest")
    }

    fn matches_local(&self, application: &ApplicationDescriptor, check: &CheckCapability) -> bool {
        self.app_id == application.app_id
            && self.version == application.version
            && self.publisher_id == application.publisher_id
            && self.manifest_digest == application.manifest_digest
            && self.lock_digest == application.lock_digest
            && self.app_id == check.subject.app_id
            && self.version == check.subject.version
            && self.publisher_id == check.subject.publisher_id
            && self.lock_digest == check.subject.lock_digest
            && self.approval_digest == check.subject.approval_digest
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HestiaRoomInvocation {
    pub protocol: String,
    pub request_id: String,
    pub room_id: String,
    pub governance_root: String,
    pub membership_root: String,
    pub member_profile_root: String,
    pub member_node_id: Option<String>,
    pub source_id: String,
    pub source_mandate_root: String,
    pub grant_root: String,
    pub application: HestiaApplicationIdentity,
    pub operation: String,
    pub arguments_digest: String,
    pub input_bytes: u64,
    pub max_output_bytes: u64,
    pub timeout_ms: u64,
    pub created_at: String,
    pub expires_at: String,
}

impl HestiaRoomInvocation {
    pub fn validate(&self) -> Result<(), RoomExecutionError> {
        if self.protocol != HESTIA_ROOM_INVOCATION_PROTOCOL {
            return Err(RoomExecutionError::new(
                "unsupported-hestia-invocation",
                "Imported Hestia room invocation protocol is unsupported.",
            ));
        }
        validate_identifier(&self.request_id, "Hestia request ID")?;
        validate_identifier(&self.room_id, "Hestia room ID")?;
        validate_digest(&self.governance_root, "Hestia governance root")?;
        validate_digest(&self.membership_root, "Hestia membership root")?;
        validate_digest(&self.member_profile_root, "Hestia member profile root")?;
        if let Some(node_id) = &self.member_node_id {
            validate_identifier(node_id, "Hestia member node ID")?;
        }
        validate_identifier(&self.source_id, "Hestia source ID")?;
        validate_digest(&self.source_mandate_root, "Hestia source mandate root")?;
        validate_digest(&self.grant_root, "Hestia room application grant root")?;
        self.application.validate()?;
        validate_operation(&self.operation, "Hestia room operation")?;
        validate_digest(&self.arguments_digest, "Hestia arguments digest")?;
        if self.input_bytes > MAX_CONTENT_BYTES
            || self.max_output_bytes == 0
            || self.max_output_bytes > MAX_CONTENT_BYTES
            || self.timeout_ms == 0
            || self.timeout_ms > MAX_TIMEOUT_MS
        {
            return Err(RoomExecutionError::new(
                "invalid-hestia-limits",
                "Imported Hestia room invocation limits are invalid.",
            ));
        }
        validate_canonical_instant(&self.created_at, "Hestia invocation creation time")?;
        validate_canonical_instant(&self.expires_at, "Hestia invocation expiry")?;
        if self.created_at >= self.expires_at {
            return Err(RoomExecutionError::new(
                "invalid-hestia-validity",
                "Imported Hestia room invocation validity interval is empty.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HestiaRoomAuthorityDecision {
    pub protocol: String,
    pub allowed: bool,
    pub reason: String,
    pub request_id: String,
    pub room_id: String,
    pub operation: String,
    pub membership_root: Option<String>,
    pub source_mandate_root: Option<String>,
    pub grant_root: Option<String>,
    pub requires_user_interaction: bool,
}

impl HestiaRoomAuthorityDecision {
    pub fn validate(&self) -> Result<(), RoomExecutionError> {
        if self.protocol != HESTIA_ROOM_AUTHORITY_DECISION_PROTOCOL {
            return Err(RoomExecutionError::new(
                "unsupported-hestia-decision",
                "Imported Hestia room authority decision protocol is unsupported.",
            ));
        }
        validate_identifier(&self.request_id, "Hestia decision request ID")?;
        validate_identifier(&self.room_id, "Hestia decision room ID")?;
        validate_operation(&self.operation, "Hestia decision operation")?;
        validate_reason(&self.reason, "Hestia decision reason")?;
        if self.allowed {
            if self.reason != "allowed" {
                return Err(RoomExecutionError::new(
                    "invalid-hestia-decision",
                    "Allowed Hestia decision must use the allowed reason.",
                ));
            }
            validate_digest(
                self.membership_root.as_deref().ok_or_else(|| {
                    RoomExecutionError::new(
                        "missing-hestia-authority",
                        "Allowed Hestia decision has no membership root.",
                    )
                })?,
                "Hestia decision membership root",
            )?;
            validate_digest(
                self.source_mandate_root.as_deref().ok_or_else(|| {
                    RoomExecutionError::new(
                        "missing-hestia-authority",
                        "Allowed Hestia decision has no source mandate root.",
                    )
                })?,
                "Hestia decision source mandate root",
            )?;
            validate_digest(
                self.grant_root.as_deref().ok_or_else(|| {
                    RoomExecutionError::new(
                        "missing-hestia-authority",
                        "Allowed Hestia decision has no room application grant root.",
                    )
                })?,
                "Hestia decision room application grant root",
            )?;
        } else if self.membership_root.is_some()
            || self.source_mandate_root.is_some()
            || self.grant_root.is_some()
            || self.requires_user_interaction
        {
            return Err(RoomExecutionError::new(
                "invalid-hestia-denial",
                "Denied Hestia decision cannot project successful authority evidence.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalRoomAuthorityEvidence {
    pub protocol: String,
    pub application: ApplicationDescriptor,
    pub check: CheckCapability,
    pub decision: CapabilityDecision,
}

impl LocalRoomAuthorityEvidence {
    pub fn validate(&self) -> Result<(), RoomExecutionError> {
        if self.protocol != LOCAL_ROOM_AUTHORITY_EVIDENCE_PROTOCOL {
            return Err(RoomExecutionError::new(
                "unsupported-local-room-authority",
                "Local room authority evidence protocol is unsupported.",
            ));
        }
        validate_application_descriptor(&self.application).map_err(|_| {
            RoomExecutionError::new(
                "invalid-local-application",
                "Local application descriptor is invalid.",
            )
        })?;
        self.check.validate().map_err(|_| {
            RoomExecutionError::new(
                "invalid-local-capability-check",
                "Local application capability check is invalid.",
            )
        })?;
        if self.application.app_id != self.check.subject.app_id
            || self.application.version != self.check.subject.version
            || self.application.publisher_id != self.check.subject.publisher_id
            || self.application.lock_digest != self.check.subject.lock_digest
        {
            return Err(RoomExecutionError::new(
                "local-application-mismatch",
                "Local application descriptor differs from its approval subject.",
            ));
        }
        if self.decision.protocol != CAPABILITY_DECISION_PROTOCOL
            || !self.decision.allowed
            || self.decision.reason != "granted"
            || self.decision.capability != self.check.capability
            || self.decision.approval_digest != self.check.subject.approval_digest
            || self.decision.observed_at_unix_ms == 0
        {
            return Err(RoomExecutionError::new(
                "local-capability-denied",
                "Local application capability decision is not an exact active grant.",
            ));
        }
        validate_grant_id(self.decision.grant_id.as_deref().ok_or_else(|| {
            RoomExecutionError::new(
                "missing-local-capability-grant",
                "Allowed local capability decision has no grant ID.",
            )
        })?)?;
        validate_digest(
            self.decision.grant_subject_root.as_deref().ok_or_else(|| {
                RoomExecutionError::new(
                    "missing-local-capability-grant",
                    "Allowed local capability decision has no grant root.",
                )
            })?,
            "Local capability grant root",
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedRoomExecution {
    pub protocol: String,
    pub state: String,
    pub request_id: String,
    pub room_id: String,
    pub governance_root: String,
    pub member_profile_root: String,
    pub member_node_id: Option<String>,
    pub source_id: String,
    pub application: ApplicationDescriptor,
    pub operation: String,
    pub arguments_digest: String,
    pub input_bytes: u64,
    pub max_output_bytes: u64,
    pub timeout_ms: u64,
    pub expires_at: String,
    pub local_application_approval_root: String,
    pub local_capability: String,
    pub local_capability_grant_id: String,
    pub local_capability_grant_root: String,
    pub hestia_membership_root: String,
    pub hestia_source_mandate_root: String,
    pub hestia_room_application_grant_root: String,
    pub requires_user_interaction: bool,
    pub authorized_at_unix_ms: u64,
}

impl PreparedRoomExecution {
    pub fn validate(&self) -> Result<(), RoomExecutionError> {
        if self.protocol != PREPARED_ROOM_EXECUTION_PROTOCOL
            || self.state != PREPARED_ROOM_EXECUTION_STATE
        {
            return Err(RoomExecutionError::new(
                "unsupported-prepared-room-execution",
                "Prepared room execution protocol or state is unsupported.",
            ));
        }
        validate_identifier(&self.request_id, "Prepared room request ID")?;
        validate_identifier(&self.room_id, "Prepared room ID")?;
        validate_digest(&self.governance_root, "Prepared room governance root")?;
        validate_digest(
            &self.member_profile_root,
            "Prepared room member profile root",
        )?;
        if let Some(node_id) = &self.member_node_id {
            validate_identifier(node_id, "Prepared room member node ID")?;
        }
        validate_identifier(&self.source_id, "Prepared room source ID")?;
        validate_application_descriptor(&self.application).map_err(|_| {
            RoomExecutionError::new(
                "invalid-prepared-application",
                "Prepared room application descriptor is invalid.",
            )
        })?;
        validate_operation(&self.operation, "Prepared room operation")?;
        validate_digest(&self.arguments_digest, "Prepared room arguments digest")?;
        if self.input_bytes > MAX_CONTENT_BYTES
            || self.max_output_bytes == 0
            || self.max_output_bytes > MAX_CONTENT_BYTES
            || self.timeout_ms == 0
            || self.timeout_ms > MAX_TIMEOUT_MS
        {
            return Err(RoomExecutionError::new(
                "invalid-prepared-limits",
                "Prepared room execution limits are invalid.",
            ));
        }
        validate_canonical_instant(&self.expires_at, "Prepared room expiry")?;
        validate_digest(
            &self.local_application_approval_root,
            "Local application approval root",
        )?;
        validate_operation(&self.local_capability, "Local capability")?;
        validate_grant_id(&self.local_capability_grant_id)?;
        validate_digest(
            &self.local_capability_grant_root,
            "Local capability grant root",
        )?;
        validate_digest(&self.hestia_membership_root, "Hestia membership root")?;
        validate_digest(
            &self.hestia_source_mandate_root,
            "Hestia source mandate root",
        )?;
        validate_digest(
            &self.hestia_room_application_grant_root,
            "Hestia room application grant root",
        )?;
        if self.authorized_at_unix_ms == 0 {
            return Err(RoomExecutionError::new(
                "invalid-local-authority-time",
                "Prepared room local authority time must be positive.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomExecutionError {
    code: &'static str,
    message: String,
}

impl RoomExecutionError {
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

impl fmt::Display for RoomExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for RoomExecutionError {}

pub fn prepare_room_execution(
    local: &LocalRoomAuthorityEvidence,
    invocation: &HestiaRoomInvocation,
    decision: &HestiaRoomAuthorityDecision,
) -> Result<PreparedRoomExecution, RoomExecutionError> {
    local.validate()?;
    invocation.validate()?;
    decision.validate()?;
    if !decision.allowed {
        return Err(RoomExecutionError::new(
            "hestia-room-authority-denied",
            "Hestia denied the exact room invocation.",
        ));
    }
    if decision.request_id != invocation.request_id
        || decision.room_id != invocation.room_id
        || decision.operation != invocation.operation
    {
        return Err(RoomExecutionError::new(
            "hestia-decision-mismatch",
            "Hestia decision does not identify the exact room invocation.",
        ));
    }
    if decision.membership_root.as_deref() != Some(invocation.membership_root.as_str())
        || decision.source_mandate_root.as_deref() != Some(invocation.source_mandate_root.as_str())
        || decision.grant_root.as_deref() != Some(invocation.grant_root.as_str())
    {
        return Err(RoomExecutionError::new(
            "hestia-authority-root-mismatch",
            "Hestia decision roots differ from the exact room invocation.",
        ));
    }
    if !invocation
        .application
        .matches_local(&local.application, &local.check)
    {
        return Err(RoomExecutionError::new(
            "cross-authority-application-mismatch",
            "Hestia and local Greenways authority identify different applications.",
        ));
    }

    let local_capability_grant_id = local.decision.grant_id.clone().ok_or_else(|| {
        RoomExecutionError::new(
            "missing-local-capability-grant",
            "Validated local capability decision has no grant ID.",
        )
    })?;
    let local_capability_grant_root =
        local.decision.grant_subject_root.clone().ok_or_else(|| {
            RoomExecutionError::new(
                "missing-local-capability-grant",
                "Validated local capability decision has no grant root.",
            )
        })?;

    let prepared = PreparedRoomExecution {
        protocol: PREPARED_ROOM_EXECUTION_PROTOCOL.to_owned(),
        state: PREPARED_ROOM_EXECUTION_STATE.to_owned(),
        request_id: invocation.request_id.clone(),
        room_id: invocation.room_id.clone(),
        governance_root: invocation.governance_root.clone(),
        member_profile_root: invocation.member_profile_root.clone(),
        member_node_id: invocation.member_node_id.clone(),
        source_id: invocation.source_id.clone(),
        application: local.application.clone(),
        operation: invocation.operation.clone(),
        arguments_digest: invocation.arguments_digest.clone(),
        input_bytes: invocation.input_bytes,
        max_output_bytes: invocation.max_output_bytes,
        timeout_ms: invocation.timeout_ms,
        expires_at: invocation.expires_at.clone(),
        local_application_approval_root: local.check.subject.approval_digest.clone(),
        local_capability: local.check.capability.clone(),
        local_capability_grant_id,
        local_capability_grant_root,
        hestia_membership_root: invocation.membership_root.clone(),
        hestia_source_mandate_root: invocation.source_mandate_root.clone(),
        hestia_room_application_grant_root: invocation.grant_root.clone(),
        requires_user_interaction: decision.requires_user_interaction,
        authorized_at_unix_ms: local.decision.observed_at_unix_ms,
    };
    prepared.validate()?;
    Ok(prepared)
}

fn validate_identifier(value: &str, name: &str) -> Result<(), RoomExecutionError> {
    if value.is_empty()
        || value.len() > MAX_IDENTIFIER_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(RoomExecutionError::new(
            "invalid-identifier",
            format!("{name} is invalid."),
        ));
    }
    Ok(())
}

fn validate_operation(value: &str, name: &str) -> Result<(), RoomExecutionError> {
    if value.is_empty()
        || value.len() > MAX_OPERATION_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(RoomExecutionError::new(
            "invalid-operation",
            format!("{name} is invalid."),
        ));
    }
    Ok(())
}

fn validate_reason(value: &str, name: &str) -> Result<(), RoomExecutionError> {
    if value.is_empty()
        || value.len() > MAX_OPERATION_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(RoomExecutionError::new(
            "invalid-decision-reason",
            format!("{name} is invalid."),
        ));
    }
    Ok(())
}

fn validate_digest(value: &str, name: &str) -> Result<(), RoomExecutionError> {
    if value
        .strip_prefix(DIGEST_PREFIX)
        .is_none_or(|suffix| suffix.len() != 64 || !suffix.bytes().all(is_lower_hex))
    {
        return Err(RoomExecutionError::new(
            "invalid-digest",
            format!("{name} is invalid."),
        ));
    }
    Ok(())
}

fn validate_grant_id(value: &str) -> Result<(), RoomExecutionError> {
    if value
        .strip_prefix(GRANT_PREFIX)
        .is_none_or(|suffix| suffix.len() != 32 || !suffix.bytes().all(is_lower_hex))
    {
        return Err(RoomExecutionError::new(
            "invalid-local-capability-grant",
            "Local capability grant ID is invalid.",
        ));
    }
    Ok(())
}

fn validate_canonical_instant(value: &str, name: &str) -> Result<(), RoomExecutionError> {
    let bytes = value.as_bytes();
    let punctuation = [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
        (23, b'Z'),
    ];
    let valid_shape = bytes.len() == 24
        && punctuation
            .iter()
            .all(|(position, expected)| bytes[*position] == *expected)
        && bytes.iter().enumerate().all(|(position, byte)| {
            punctuation
                .iter()
                .any(|(punctuation_position, _)| *punctuation_position == position)
                || byte.is_ascii_digit()
        });
    if !valid_shape {
        return Err(RoomExecutionError::new(
            "invalid-instant",
            format!("{name} must use canonical UTC millisecond form."),
        ));
    }
    Ok(())
}

const fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

#[cfg(test)]
mod tests {
    use super::*;
    use greenways_capabilities::CAPABILITY_CHECK_PROTOCOL;
    use greenways_identity::ApplicationApprovalSubject;
    use serde_json::{json, Value};

    fn digest(character: char) -> String {
        format!("sha256:{}", character.to_string().repeat(64))
    }

    fn descriptor() -> ApplicationDescriptor {
        ApplicationDescriptor {
            app_id: "greenways.chat".to_owned(),
            version: "0.1.0".to_owned(),
            publisher_id: "greenways-ai".to_owned(),
            manifest_digest: digest('1'),
            lock_digest: Some(digest('2')),
        }
    }

    fn local_evidence() -> LocalRoomAuthorityEvidence {
        let application = descriptor();
        let approval_digest = digest('3');
        LocalRoomAuthorityEvidence {
            protocol: LOCAL_ROOM_AUTHORITY_EVIDENCE_PROTOCOL.to_owned(),
            application: application.clone(),
            check: CheckCapability {
                protocol: CAPABILITY_CHECK_PROTOCOL.to_owned(),
                subject: ApplicationApprovalSubject {
                    kind: "app".to_owned(),
                    app_id: application.app_id,
                    version: application.version,
                    publisher_id: application.publisher_id,
                    lock_digest: application.lock_digest,
                    approval_digest: approval_digest.clone(),
                },
                capability: "model/generate".to_owned(),
            },
            decision: CapabilityDecision {
                protocol: CAPABILITY_DECISION_PROTOCOL.to_owned(),
                allowed: true,
                reason: "granted".to_owned(),
                grant_id: Some(format!("grant/{}", "a".repeat(32))),
                grant_subject_root: Some(digest('4')),
                capability: "model/generate".to_owned(),
                approval_digest,
                observed_at_unix_ms: 1_786_579_200_000,
            },
        }
    }

    fn invocation() -> HestiaRoomInvocation {
        let application = descriptor();
        HestiaRoomInvocation {
            protocol: HESTIA_ROOM_INVOCATION_PROTOCOL.to_owned(),
            request_id: "room-request/0001".to_owned(),
            room_id: "room/design-studio".to_owned(),
            governance_root: digest('5'),
            membership_root: digest('6'),
            member_profile_root: digest('7'),
            member_node_id: Some("node/bob-macbook".to_owned()),
            source_id: "source/alice-chatgpt-browser".to_owned(),
            source_mandate_root: digest('8'),
            grant_root: digest('9'),
            application: HestiaApplicationIdentity {
                app_id: application.app_id,
                version: application.version,
                publisher_id: application.publisher_id,
                manifest_digest: application.manifest_digest,
                lock_digest: application.lock_digest,
                approval_digest: digest('3'),
            },
            operation: "message.submit".to_owned(),
            arguments_digest: digest('b'),
            input_bytes: 1_200,
            max_output_bytes: 50_000,
            timeout_ms: 3_600_000,
            created_at: "2026-08-12T23:59:00.000Z".to_owned(),
            expires_at: "2026-08-13T01:00:00.000Z".to_owned(),
        }
    }

    fn decision(invocation: &HestiaRoomInvocation) -> HestiaRoomAuthorityDecision {
        HestiaRoomAuthorityDecision {
            protocol: HESTIA_ROOM_AUTHORITY_DECISION_PROTOCOL.to_owned(),
            allowed: true,
            reason: "allowed".to_owned(),
            request_id: invocation.request_id.clone(),
            room_id: invocation.room_id.clone(),
            operation: invocation.operation.clone(),
            membership_root: Some(invocation.membership_root.clone()),
            source_mandate_root: Some(invocation.source_mandate_root.clone()),
            grant_root: Some(invocation.grant_root.clone()),
            requires_user_interaction: true,
        }
    }

    #[test]
    fn prepares_an_unclaimed_room_execution_from_both_authorities() {
        let local = local_evidence();
        let invocation = invocation();
        let decision = decision(&invocation);
        let prepared = prepare_room_execution(&local, &invocation, &decision).unwrap();

        assert_eq!(prepared.protocol, PREPARED_ROOM_EXECUTION_PROTOCOL);
        assert_eq!(prepared.state, PREPARED_ROOM_EXECUTION_STATE);
        assert_eq!(prepared.request_id, invocation.request_id);
        assert_eq!(
            prepared.local_application_approval_root,
            local.check.subject.approval_digest
        );
        assert_eq!(
            prepared.local_capability_grant_root,
            local.decision.grant_subject_root.unwrap()
        );
        assert_eq!(prepared.hestia_membership_root, invocation.membership_root);
        assert_eq!(
            prepared.hestia_source_mandate_root,
            invocation.source_mandate_root
        );
        assert_eq!(
            prepared.hestia_room_application_grant_root,
            invocation.grant_root
        );
        assert!(prepared.requires_user_interaction);
        prepared.validate().unwrap();
    }

    #[test]
    fn rejects_a_local_capability_denial() {
        let mut local = local_evidence();
        local.decision.allowed = false;
        local.decision.reason = "grant-revoked".to_owned();
        local.decision.grant_id = None;
        local.decision.grant_subject_root = None;
        let invocation = invocation();
        let error =
            prepare_room_execution(&local, &invocation, &decision(&invocation)).unwrap_err();
        assert_eq!(error.code(), "local-capability-denied");
    }

    #[test]
    fn rejects_a_hestia_denial() {
        let local = local_evidence();
        let invocation = invocation();
        let mut denied = decision(&invocation);
        denied.allowed = false;
        denied.reason = "grant-inactive".to_owned();
        denied.membership_root = None;
        denied.source_mandate_root = None;
        denied.grant_root = None;
        denied.requires_user_interaction = false;

        let error = prepare_room_execution(&local, &invocation, &denied).unwrap_err();
        assert_eq!(error.code(), "hestia-room-authority-denied");
    }

    #[test]
    fn rejects_cross_authority_application_substitution() {
        let local = local_evidence();
        let mut invocation = invocation();
        invocation.application.manifest_digest = digest('c');
        let error =
            prepare_room_execution(&local, &invocation, &decision(&invocation)).unwrap_err();
        assert_eq!(error.code(), "cross-authority-application-mismatch");
    }

    #[test]
    fn rejects_changed_hestia_authority_roots() {
        let local = local_evidence();
        let invocation = invocation();
        let mut changed = decision(&invocation);
        changed.grant_root = Some(digest('d'));
        let error = prepare_room_execution(&local, &invocation, &changed).unwrap_err();
        assert_eq!(error.code(), "hestia-authority-root-mismatch");
    }

    #[test]
    fn imported_envelopes_reject_unknown_secret_fields() {
        let mut value = serde_json::to_value(invocation()).unwrap();
        let Value::Object(ref mut object) = value else {
            panic!("invocation must encode as an object");
        };
        object.insert("providerCredential".to_owned(), json!("must-not-cross"));
        assert!(serde_json::from_value::<HestiaRoomInvocation>(value).is_err());

        let mut local_value = serde_json::to_value(local_evidence()).unwrap();
        let Value::Object(ref mut object) = local_value else {
            panic!("local evidence must encode as an object");
        };
        object.insert("browserCookie".to_owned(), json!("must-not-cross"));
        assert!(serde_json::from_value::<LocalRoomAuthorityEvidence>(local_value).is_err());
    }

    #[test]
    fn prepared_execution_contains_no_route_provider_or_secret_projection() {
        let local = local_evidence();
        let invocation = invocation();
        let prepared = prepare_room_execution(&local, &invocation, &decision(&invocation)).unwrap();
        let encoded = serde_json::to_string(&prepared).unwrap();
        for forbidden in [
            "credential",
            "browserCookie",
            "providerProfile",
            "routeId",
            "claimId",
            "privateKey",
        ] {
            assert!(!encoded.contains(forbidden), "forbidden field: {forbidden}");
        }
    }
}
