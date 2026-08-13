use greenways_identity::{
    new_capability_grant_id, new_capability_revocation_id, normalize_operation_capability,
    validate_application_approval_subject, verify_signed_capability_grant,
    verify_signed_capability_revocation, ApplicationApprovalSubject, CapabilityConstraintValue,
    CapabilityGrantRequest, CapabilityRevocationRequest, ProfileIdentityVault,
    SignedCapabilityGrant, SignedCapabilityRevocation,
};
use greenways_provider::{
    validate_invocation, validate_model_id, validate_profile_id, ProviderInvocation,
    MAX_OUTPUT_TOKENS, MAX_TIMEOUT_MS,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::{BTreeMap, HashSet},
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
};

pub const CAPABILITY_AUTHORITY_STATE_PROTOCOL: &str =
    "greenways-capability-authority-state/0-alpha";
pub const CAPABILITY_AUTHORITY_STATUS_PROTOCOL: &str =
    "greenways-capability-authority-status/0-alpha";
pub const CAPABILITY_DECISION_PROTOCOL: &str = "greenways-capability-decision/0-alpha";
pub const CAPABILITY_CHECK_PROTOCOL: &str = "greenways-capability-check/0-alpha";
pub const PROVIDER_GRANT_EVIDENCE_PROTOCOL: &str = "greenways-provider-grant-evidence/0-alpha";
pub const MODEL_GENERATE_CAPABILITY: &str = "model/generate";
pub const PROVIDER_PROFILE_ID_CONSTRAINT: &str = "provider.profile-id";
pub const PROVIDER_MODEL_CONSTRAINT: &str = "provider.model";
pub const PROVIDER_MAX_OUTPUT_TOKENS_CONSTRAINT: &str = "provider.max-output-tokens";
pub const PROVIDER_MAX_TIMEOUT_MS_CONSTRAINT: &str = "provider.max-timeout-ms";

const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_GRANTS: usize = 512;
const MAX_REVOCATIONS: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelGeneratePolicy {
    pub profile_id: String,
    pub model: String,
    pub max_output_tokens: u32,
    pub max_timeout_ms: u64,
}

impl ModelGeneratePolicy {
    pub fn new(
        profile_id: impl Into<String>,
        model: impl Into<String>,
        max_output_tokens: u32,
        max_timeout_ms: u64,
    ) -> Result<Self, CapabilityError> {
        let policy = Self {
            profile_id: profile_id.into(),
            model: model.into(),
            max_output_tokens,
            max_timeout_ms,
        };
        policy.validate()?;
        Ok(policy)
    }

    pub fn from_invocation(invocation: &ProviderInvocation) -> Result<Self, CapabilityError> {
        validate_invocation(invocation)
            .map_err(|_| CapabilityError::Invalid("provider invocation is invalid".to_owned()))?;
        Self::new(
            invocation.profile_id.clone(),
            invocation.model.clone(),
            invocation.max_output_tokens,
            invocation.timeout_ms,
        )
    }

    pub fn constraints(&self) -> BTreeMap<String, CapabilityConstraintValue> {
        BTreeMap::from([
            (
                PROVIDER_PROFILE_ID_CONSTRAINT.to_owned(),
                CapabilityConstraintValue::Text(self.profile_id.clone()),
            ),
            (
                PROVIDER_MODEL_CONSTRAINT.to_owned(),
                CapabilityConstraintValue::Text(self.model.clone()),
            ),
            (
                PROVIDER_MAX_OUTPUT_TOKENS_CONSTRAINT.to_owned(),
                CapabilityConstraintValue::Integer(u64::from(self.max_output_tokens)),
            ),
            (
                PROVIDER_MAX_TIMEOUT_MS_CONSTRAINT.to_owned(),
                CapabilityConstraintValue::Integer(self.max_timeout_ms),
            ),
        ])
    }

    pub fn from_constraints(
        constraints: &BTreeMap<String, CapabilityConstraintValue>,
    ) -> Result<Option<Self>, CapabilityError> {
        if constraints.is_empty() {
            return Ok(None);
        }
        if constraints.len() != 4
            || !constraints.contains_key(PROVIDER_PROFILE_ID_CONSTRAINT)
            || !constraints.contains_key(PROVIDER_MODEL_CONSTRAINT)
            || !constraints.contains_key(PROVIDER_MAX_OUTPUT_TOKENS_CONSTRAINT)
            || !constraints.contains_key(PROVIDER_MAX_TIMEOUT_MS_CONSTRAINT)
        {
            return Err(CapabilityError::Invalid(
                "model/generate provider policy must contain exactly four typed constraints"
                    .to_owned(),
            ));
        }
        let profile_id = constraint_text(constraints, PROVIDER_PROFILE_ID_CONSTRAINT)?;
        let model = constraint_text(constraints, PROVIDER_MODEL_CONSTRAINT)?;
        let max_output_tokens =
            constraint_integer(constraints, PROVIDER_MAX_OUTPUT_TOKENS_CONSTRAINT)?
                .try_into()
                .map_err(|_| {
                    CapabilityError::Invalid(
                        "model/generate output-token policy exceeds its integer bound".to_owned(),
                    )
                })?;
        let max_timeout_ms = constraint_integer(constraints, PROVIDER_MAX_TIMEOUT_MS_CONSTRAINT)?;
        Self::new(profile_id, model, max_output_tokens, max_timeout_ms).map(Some)
    }

    pub fn permits(&self, invocation: &ProviderInvocation) -> Result<bool, CapabilityError> {
        validate_invocation(invocation)
            .map_err(|_| CapabilityError::Invalid("provider invocation is invalid".to_owned()))?;
        self.permits_parameters(
            &invocation.profile_id,
            &invocation.model,
            invocation.max_output_tokens,
            invocation.timeout_ms,
        )
    }

    pub fn permits_parameters(
        &self,
        profile_id: &str,
        model: &str,
        max_output_tokens: u32,
        timeout_ms: u64,
    ) -> Result<bool, CapabilityError> {
        self.validate()?;
        validate_profile_id(profile_id).map_err(|_| {
            CapabilityError::Invalid("provider invocation profile is invalid".to_owned())
        })?;
        validate_model_id(model).map_err(|_| {
            CapabilityError::Invalid("provider invocation model is invalid".to_owned())
        })?;
        if !(1..=MAX_OUTPUT_TOKENS).contains(&max_output_tokens)
            || !(1_000..=MAX_TIMEOUT_MS).contains(&timeout_ms)
        {
            return Err(CapabilityError::Invalid(
                "provider invocation limits are invalid".to_owned(),
            ));
        }
        Ok(profile_id == self.profile_id
            && model == self.model
            && max_output_tokens <= self.max_output_tokens
            && timeout_ms <= self.max_timeout_ms)
    }

    fn validate(&self) -> Result<(), CapabilityError> {
        validate_profile_id(&self.profile_id).map_err(|_| {
            CapabilityError::Invalid("model/generate provider profile policy is invalid".to_owned())
        })?;
        validate_model_id(&self.model).map_err(|_| {
            CapabilityError::Invalid("model/generate provider model policy is invalid".to_owned())
        })?;
        if !(1..=MAX_OUTPUT_TOKENS).contains(&self.max_output_tokens) {
            return Err(CapabilityError::Invalid(
                "model/generate output-token policy is out of bounds".to_owned(),
            ));
        }
        if !(1_000..=MAX_TIMEOUT_MS).contains(&self.max_timeout_ms) {
            return Err(CapabilityError::Invalid(
                "model/generate timeout policy is out of bounds".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderGrantEvidence {
    pub protocol: String,
    pub approval_digest: String,
    pub grant_id: String,
    pub grant_subject_root: String,
    pub capability: String,
}

impl ProviderGrantEvidence {
    pub fn validate(&self) -> Result<(), CapabilityError> {
        if self.protocol != PROVIDER_GRANT_EVIDENCE_PROTOCOL
            || !valid_digest(&self.approval_digest)
            || !valid_grant_id(&self.grant_id)
            || !valid_digest(&self.grant_subject_root)
            || self.capability != MODEL_GENERATE_CAPABILITY
        {
            return Err(CapabilityError::Invalid(
                "provider grant evidence is invalid".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderInvocationAuthority {
    Allowed(ProviderGrantEvidence),
    Denied(String),
}

#[derive(Debug, Clone, Copy)]
struct CapabilityDefinition {
    id: &'static str,
    trusted_publishers: &'static [&'static str],
}

const DEFINITIONS: &[CapabilityDefinition] = &[
    CapabilityDefinition {
        id: "hestia/propose",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "hestia/approve",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "hestia/execute",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "chats/capture",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "userscripts/manage",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "key/public",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "key/sign",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "credential/manage",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "credential/use",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "model/generate",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "model/provide",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "mcp/pair",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "tahto/connect",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "tahto/read",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "tahto/write",
        trusted_publishers: &[],
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CheckCapability {
    pub protocol: String,
    pub subject: ApplicationApprovalSubject,
    pub capability: String,
}

impl CheckCapability {
    pub fn new(
        subject: ApplicationApprovalSubject,
        capability: impl AsRef<str>,
    ) -> Result<Self, CapabilityError> {
        let check = Self {
            protocol: CAPABILITY_CHECK_PROTOCOL.to_owned(),
            subject,
            capability: normalize_capability(capability.as_ref())?,
        };
        check.validate()?;
        Ok(check)
    }

    pub fn validate(&self) -> Result<(), CapabilityError> {
        validate_application_approval_subject(&self.subject)?;
        if self.protocol != CAPABILITY_CHECK_PROTOCOL
            || normalize_capability(&self.capability)? != self.capability
        {
            return Err(CapabilityError::Invalid(
                "capability check is invalid".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn into_arguments(self) -> Result<Map<String, Value>, CapabilityError> {
        match serde_json::to_value(self)? {
            Value::Object(arguments) => Ok(arguments),
            _ => Err(CapabilityError::Invalid(
                "capability check arguments are invalid".to_owned(),
            )),
        }
    }

    pub fn from_arguments(arguments: &Map<String, Value>) -> Result<Self, CapabilityError> {
        let check: Self = serde_json::from_value(Value::Object(arguments.clone()))?;
        check.validate()?;
        Ok(check)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueCapabilityGrant {
    pub capability: String,
    pub subject: ApplicationApprovalSubject,
    #[serde(default)]
    pub constraints: BTreeMap<String, CapabilityConstraintValue>,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityGrantView {
    pub grant: SignedCapabilityGrant,
    pub revocation: Option<SignedCapabilityRevocation>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityAuthorityStatus {
    pub protocol: String,
    pub state: String,
    pub revision: u64,
    pub grant_count: usize,
    pub active_grant_count: usize,
    pub revoked_grant_count: usize,
    pub expired_grant_count: usize,
    pub signed_records: bool,
    pub arbitrary_signing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityDecision {
    pub protocol: String,
    pub allowed: bool,
    pub reason: String,
    pub grant_id: Option<String>,
    pub grant_subject_root: Option<String>,
    pub capability: String,
    pub approval_digest: String,
    pub observed_at_unix_ms: u64,
}

impl CapabilityDecision {
    pub fn denied(
        check: &CheckCapability,
        reason: &str,
        observed_at_unix_ms: u64,
    ) -> Result<Self, CapabilityError> {
        check.validate()?;
        validate_timestamp(observed_at_unix_ms, "capability decision time")?;
        if !matches!(
            reason,
            "approval-not-found"
                | "approval-subject-mismatch"
                | "approval-revoked"
                | "approval-not-yet-effective"
                | "capability-not-declared"
        ) {
            return Err(CapabilityError::Invalid(
                "application denial reason is unsupported".to_owned(),
            ));
        }
        Ok(decision(
            false,
            reason,
            None,
            check.capability.clone(),
            &check.subject,
            observed_at_unix_ms,
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityAuthorityState {
    protocol: String,
    revision: u64,
    grants: Vec<SignedCapabilityGrant>,
    revocations: Vec<SignedCapabilityRevocation>,
}

impl Default for CapabilityAuthorityState {
    fn default() -> Self {
        Self {
            protocol: CAPABILITY_AUTHORITY_STATE_PROTOCOL.to_owned(),
            revision: 0,
            grants: Vec::new(),
            revocations: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum CapabilityError {
    Io(io::Error),
    Encoding(serde_json::Error),
    Identity(greenways_identity::IdentityError),
    Invalid(String),
    Conflict(String),
    NotFound(String),
}

impl fmt::Display for CapabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Greenways capability I/O failed: {error}"),
            Self::Encoding(_) => {
                formatter.write_str("Greenways capability authority encoding failed")
            }
            Self::Identity(error) => {
                write!(formatter, "Greenways capability signing failed: {error}")
            }
            Self::Invalid(message) => {
                write!(
                    formatter,
                    "Greenways capability authority is invalid: {message}"
                )
            }
            Self::Conflict(message) => {
                write!(
                    formatter,
                    "Greenways capability authority conflict: {message}"
                )
            }
            Self::NotFound(message) => {
                write!(
                    formatter,
                    "Greenways capability grant was not found: {message}"
                )
            }
        }
    }
}

impl Error for CapabilityError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Encoding(error) => Some(error),
            Self::Identity(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for CapabilityError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for CapabilityError {
    fn from(value: serde_json::Error) -> Self {
        Self::Encoding(value)
    }
}

impl From<greenways_identity::IdentityError> for CapabilityError {
    fn from(value: greenways_identity::IdentityError) -> Self {
        Self::Identity(value)
    }
}

pub struct CapabilityAuthority {
    state_path: PathBuf,
    state: CapabilityAuthorityState,
}

impl fmt::Debug for CapabilityAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapabilityAuthority")
            .field("state_path", &self.state_path)
            .field("revision", &self.state.revision)
            .field("grant_count", &self.state.grants.len())
            .field("revocation_count", &self.state.revocations.len())
            .finish()
    }
}

impl CapabilityAuthority {
    pub fn open(state_path: impl Into<PathBuf>) -> Result<Self, CapabilityError> {
        let state_path = state_path.into();
        let state = if state_path.exists() {
            load_state(&state_path)?
        } else {
            CapabilityAuthorityState::default()
        };
        validate_state(&state)?;
        Ok(Self { state_path, state })
    }

    pub fn status(
        &self,
        observed_at_unix_ms: u64,
    ) -> Result<CapabilityAuthorityStatus, CapabilityError> {
        validate_timestamp(observed_at_unix_ms, "capability status time")?;
        let views = self.list(observed_at_unix_ms)?;
        let active = views.iter().filter(|view| view.active).count();
        let revoked = views
            .iter()
            .filter(|view| view.revocation.is_some())
            .count();
        let expired = views
            .iter()
            .filter(|view| {
                view.revocation.is_none() && is_expired(&view.grant, observed_at_unix_ms)
            })
            .count();
        Ok(CapabilityAuthorityStatus {
            protocol: CAPABILITY_AUTHORITY_STATUS_PROTOCOL.to_owned(),
            state: "ready".to_owned(),
            revision: self.state.revision,
            grant_count: views.len(),
            active_grant_count: active,
            revoked_grant_count: revoked,
            expired_grant_count: expired,
            signed_records: true,
            arbitrary_signing: false,
        })
    }

    pub fn list(
        &self,
        observed_at_unix_ms: u64,
    ) -> Result<Vec<CapabilityGrantView>, CapabilityError> {
        validate_timestamp(observed_at_unix_ms, "capability list time")?;
        Ok(self
            .state
            .grants
            .iter()
            .cloned()
            .map(|grant| {
                let revocation = self
                    .state
                    .revocations
                    .iter()
                    .find(|revocation| revocation.revocation.grant_id == grant.grant.id)
                    .cloned();
                let active = revocation.is_none()
                    && grant.grant.issued_at_unix_ms <= observed_at_unix_ms
                    && !is_expired(&grant, observed_at_unix_ms);
                CapabilityGrantView {
                    grant,
                    revocation,
                    active,
                }
            })
            .collect())
    }

    pub fn issue(
        &mut self,
        signer: &ProfileIdentityVault,
        request: IssueCapabilityGrant,
    ) -> Result<SignedCapabilityGrant, CapabilityError> {
        let definition = validate_issue_request(&request)?;
        if !publisher_is_trusted(definition, &request.subject.publisher_id) {
            return Err(CapabilityError::Invalid(format!(
                "{} is restricted to a trusted publisher",
                request.capability
            )));
        }
        if self.state.grants.len() >= MAX_GRANTS {
            return Err(CapabilityError::Conflict(
                "capability grant limit has been reached".to_owned(),
            ));
        }
        let duplicate = self.state.grants.iter().any(|grant| {
            grant.grant.capability == request.capability
                && grant.grant.subject == request.subject
                && self
                    .state
                    .revocations
                    .iter()
                    .all(|revocation| revocation.revocation.grant_id != grant.grant.id)
                && !is_expired(grant, request.issued_at_unix_ms)
        });
        if duplicate {
            return Err(CapabilityError::Conflict(
                "an active exact capability grant already exists".to_owned(),
            ));
        }

        let signed = signer.sign_capability_grant(CapabilityGrantRequest {
            id: new_capability_grant_id()?,
            capability: request.capability,
            subject: request.subject,
            constraints: request.constraints,
            issued_at_unix_ms: request.issued_at_unix_ms,
            expires_at_unix_ms: request.expires_at_unix_ms,
        })?;
        verify_signed_capability_grant(&signed)?;
        validate_signed_grant_semantics(&signed)?;

        let mut next = self.state.clone();
        next.revision = next
            .revision
            .checked_add(1)
            .ok_or_else(|| CapabilityError::Invalid("capability revision overflowed".to_owned()))?;
        next.grants.push(signed.clone());
        persist_state(&self.state_path, &next)?;
        self.state = next;
        Ok(signed)
    }

    pub fn revoke(
        &mut self,
        signer: &ProfileIdentityVault,
        grant_id: &str,
        reason: &str,
        observed_at_unix_ms: u64,
    ) -> Result<SignedCapabilityRevocation, CapabilityError> {
        validate_timestamp(observed_at_unix_ms, "capability revocation time")?;
        let grant = self
            .state
            .grants
            .iter()
            .find(|grant| grant.grant.id == grant_id)
            .ok_or_else(|| CapabilityError::NotFound(grant_id.to_owned()))?;
        if let Some(existing) = self
            .state
            .revocations
            .iter()
            .find(|revocation| revocation.revocation.grant_id == grant_id)
        {
            return Ok(existing.clone());
        }
        if self.state.revocations.len() >= MAX_REVOCATIONS {
            return Err(CapabilityError::Conflict(
                "capability revocation limit has been reached".to_owned(),
            ));
        }
        if observed_at_unix_ms < grant.grant.issued_at_unix_ms {
            return Err(CapabilityError::Invalid(
                "capability revocation predates grant issuance".to_owned(),
            ));
        }
        let signer_identity = signer.public_identity().ok_or_else(|| {
            CapabilityError::Invalid("profile identity is not configured".to_owned())
        })?;
        if signer_identity.subject.id != grant.grant.issuer_identity_id
            || signer_identity.subject.key_id != grant.grant.issuer_key_id
        {
            return Err(CapabilityError::Conflict(
                "another profile identity cannot revoke this grant".to_owned(),
            ));
        }

        let signed = signer.sign_capability_revocation(CapabilityRevocationRequest {
            id: new_capability_revocation_id()?,
            grant_id: grant_id.to_owned(),
            grant_subject_root: grant.subject_root.clone(),
            reason: reason.to_owned(),
            revoked_at_unix_ms: observed_at_unix_ms,
        })?;
        verify_signed_capability_revocation(&signed)?;

        let mut next = self.state.clone();
        next.revision = next
            .revision
            .checked_add(1)
            .ok_or_else(|| CapabilityError::Invalid("capability revision overflowed".to_owned()))?;
        next.revocations.push(signed.clone());
        validate_state(&next)?;
        persist_state(&self.state_path, &next)?;
        self.state = next;
        Ok(signed)
    }

    pub fn check_request(
        &self,
        check: &CheckCapability,
        observed_at_unix_ms: u64,
    ) -> Result<CapabilityDecision, CapabilityError> {
        check.validate()?;
        self.check(&check.subject, &check.capability, observed_at_unix_ms)
    }

    pub fn check(
        &self,
        subject: &ApplicationApprovalSubject,
        capability: &str,
        observed_at_unix_ms: u64,
    ) -> Result<CapabilityDecision, CapabilityError> {
        validate_application_approval_subject(subject)?;
        validate_timestamp(observed_at_unix_ms, "capability decision time")?;
        let capability = normalize_capability(capability)?;
        if definition(&capability).is_none() {
            return Ok(decision(
                false,
                "capability-not-grantable",
                None,
                capability,
                subject,
                observed_at_unix_ms,
            ));
        }

        let matching = self
            .state
            .grants
            .iter()
            .filter(|grant| {
                grant.grant.capability == capability
                    && grant.grant.subject == *subject
                    && grant.grant.issued_at_unix_ms <= observed_at_unix_ms
            })
            .max_by_key(|grant| grant.grant.issued_at_unix_ms);
        let Some(grant) = matching else {
            return Ok(decision(
                false,
                "no-current-grant",
                None,
                capability,
                subject,
                observed_at_unix_ms,
            ));
        };
        if self
            .state
            .revocations
            .iter()
            .any(|revocation| revocation.revocation.grant_id == grant.grant.id)
        {
            return Ok(decision(
                false,
                "grant-revoked",
                Some(grant),
                capability,
                subject,
                observed_at_unix_ms,
            ));
        }
        if is_expired(grant, observed_at_unix_ms) {
            return Ok(decision(
                false,
                "grant-expired",
                Some(grant),
                capability,
                subject,
                observed_at_unix_ms,
            ));
        }
        Ok(decision(
            true,
            "granted",
            Some(grant),
            capability,
            subject,
            observed_at_unix_ms,
        ))
    }

    pub fn authorize_provider_invocation(
        &self,
        check: &CheckCapability,
        invocation: &ProviderInvocation,
        observed_at_unix_ms: u64,
    ) -> Result<ProviderInvocationAuthority, CapabilityError> {
        check.validate()?;
        validate_invocation(invocation)
            .map_err(|_| CapabilityError::Invalid("provider invocation is invalid".to_owned()))?;
        if check.capability != MODEL_GENERATE_CAPABILITY {
            return Err(CapabilityError::Invalid(
                "provider invocation requires model/generate authority".to_owned(),
            ));
        }
        let decision = self.check_request(check, observed_at_unix_ms)?;
        if !decision.allowed {
            return Ok(ProviderInvocationAuthority::Denied(decision.reason));
        }
        let grant_id = decision.grant_id.as_ref().ok_or_else(|| {
            CapabilityError::Invalid("allowed provider decision has no grant ID".to_owned())
        })?;
        let grant = self
            .state
            .grants
            .iter()
            .find(|grant| {
                grant.grant.id == *grant_id
                    && grant.grant.subject == check.subject
                    && grant.grant.capability == check.capability
            })
            .ok_or_else(|| {
                CapabilityError::Invalid(
                    "allowed provider decision does not identify a stored grant".to_owned(),
                )
            })?;
        let Some(policy) = ModelGeneratePolicy::from_constraints(&grant.grant.constraints)? else {
            return Ok(ProviderInvocationAuthority::Denied(
                "provider-policy-missing".to_owned(),
            ));
        };
        if !policy.permits(invocation)? {
            return Ok(ProviderInvocationAuthority::Denied(
                "provider-policy-denied".to_owned(),
            ));
        }
        let evidence = ProviderGrantEvidence {
            protocol: PROVIDER_GRANT_EVIDENCE_PROTOCOL.to_owned(),
            approval_digest: check.subject.approval_digest.clone(),
            grant_id: grant.grant.id.clone(),
            grant_subject_root: grant.subject_root.clone(),
            capability: MODEL_GENERATE_CAPABILITY.to_owned(),
        };
        evidence.validate()?;
        Ok(ProviderInvocationAuthority::Allowed(evidence))
    }

    pub fn matches_provider_grant_evidence(
        &self,
        subject: &ApplicationApprovalSubject,
        evidence: &ProviderGrantEvidence,
    ) -> Result<bool, CapabilityError> {
        Ok(self
            .provider_grant_for_evidence(subject, evidence)?
            .is_some())
    }

    pub fn matches_provider_grant_evidence_for_invocation(
        &self,
        subject: &ApplicationApprovalSubject,
        evidence: &ProviderGrantEvidence,
        invocation: &ProviderInvocation,
    ) -> Result<bool, CapabilityError> {
        let requested = ModelGeneratePolicy::from_invocation(invocation)?;
        self.matches_provider_grant_evidence_for_policy(subject, evidence, &requested)
    }

    pub fn matches_provider_grant_evidence_for_policy(
        &self,
        subject: &ApplicationApprovalSubject,
        evidence: &ProviderGrantEvidence,
        requested: &ModelGeneratePolicy,
    ) -> Result<bool, CapabilityError> {
        let Some(grant) = self.provider_grant_for_evidence(subject, evidence)? else {
            return Ok(false);
        };
        let Some(policy) = ModelGeneratePolicy::from_constraints(&grant.grant.constraints)? else {
            return Ok(false);
        };
        policy.permits_parameters(
            &requested.profile_id,
            &requested.model,
            requested.max_output_tokens,
            requested.max_timeout_ms,
        )
    }

    pub fn matches_active_provider_grant_evidence_for_policy(
        &self,
        subject: &ApplicationApprovalSubject,
        evidence: &ProviderGrantEvidence,
        requested: &ModelGeneratePolicy,
        observed_at_unix_ms: u64,
    ) -> Result<bool, CapabilityError> {
        validate_timestamp(observed_at_unix_ms, "provider authority evidence time")?;
        let Some(grant) = self.provider_grant_for_evidence(subject, evidence)? else {
            return Ok(false);
        };
        if grant.grant.issued_at_unix_ms > observed_at_unix_ms
            || is_expired(grant, observed_at_unix_ms)
            || self.state.revocations.iter().any(|revocation| {
                revocation.revocation.grant_id == grant.grant.id
                    && revocation.revocation.revoked_at_unix_ms <= observed_at_unix_ms
            })
        {
            return Ok(false);
        }
        let Some(policy) = ModelGeneratePolicy::from_constraints(&grant.grant.constraints)? else {
            return Ok(false);
        };
        policy.permits_parameters(
            &requested.profile_id,
            &requested.model,
            requested.max_output_tokens,
            requested.max_timeout_ms,
        )
    }

    fn provider_grant_for_evidence<'a>(
        &'a self,
        subject: &ApplicationApprovalSubject,
        evidence: &ProviderGrantEvidence,
    ) -> Result<Option<&'a SignedCapabilityGrant>, CapabilityError> {
        validate_application_approval_subject(subject)?;
        evidence.validate()?;
        Ok(self.state.grants.iter().find(|grant| {
            grant.grant.id == evidence.grant_id
                && grant.subject_root == evidence.grant_subject_root
                && grant.grant.subject == *subject
                && grant.grant.capability == evidence.capability
                && subject.approval_digest == evidence.approval_digest
        }))
    }
}

fn decision(
    allowed: bool,
    reason: &str,
    grant: Option<&SignedCapabilityGrant>,
    capability: String,
    subject: &ApplicationApprovalSubject,
    observed_at_unix_ms: u64,
) -> CapabilityDecision {
    CapabilityDecision {
        protocol: CAPABILITY_DECISION_PROTOCOL.to_owned(),
        allowed,
        reason: reason.to_owned(),
        grant_id: grant.map(|grant| grant.grant.id.clone()),
        grant_subject_root: grant.map(|grant| grant.subject_root.clone()),
        capability,
        approval_digest: subject.approval_digest.clone(),
        observed_at_unix_ms,
    }
}

fn validate_issue_request(
    request: &IssueCapabilityGrant,
) -> Result<&'static CapabilityDefinition, CapabilityError> {
    validate_application_approval_subject(&request.subject)?;
    validate_timestamp(request.issued_at_unix_ms, "capability issue time")?;
    if request
        .expires_at_unix_ms
        .is_some_and(|expires| expires <= request.issued_at_unix_ms)
    {
        return Err(CapabilityError::Invalid(
            "capability expiry must follow issuance".to_owned(),
        ));
    }
    let capability = normalize_capability(&request.capability)?;
    if capability != request.capability {
        return Err(CapabilityError::Invalid(
            "capability must already be canonical".to_owned(),
        ));
    }
    let definition = definition(&capability).ok_or_else(|| {
        CapabilityError::Invalid("capability is not operation-grantable".to_owned())
    })?;
    validate_capability_constraints(&capability, &request.constraints, false)?;
    Ok(definition)
}

fn validate_signed_grant_semantics(signed: &SignedCapabilityGrant) -> Result<(), CapabilityError> {
    let definition = definition(&signed.grant.capability).ok_or_else(|| {
        CapabilityError::Invalid("stored capability is not operation-grantable".to_owned())
    })?;
    if !publisher_is_trusted(definition, &signed.grant.subject.publisher_id) {
        return Err(CapabilityError::Invalid(
            "stored capability publisher is not trusted".to_owned(),
        ));
    }
    validate_capability_constraints(&signed.grant.capability, &signed.grant.constraints, true)?;
    Ok(())
}

fn validate_state(state: &CapabilityAuthorityState) -> Result<(), CapabilityError> {
    if state.protocol != CAPABILITY_AUTHORITY_STATE_PROTOCOL {
        return Err(CapabilityError::Invalid(
            "capability authority protocol is unsupported".to_owned(),
        ));
    }
    if state.grants.len() > MAX_GRANTS || state.revocations.len() > MAX_REVOCATIONS {
        return Err(CapabilityError::Invalid(
            "capability authority record count exceeds its bound".to_owned(),
        ));
    }
    if state.revision != (state.grants.len() + state.revocations.len()) as u64 {
        return Err(CapabilityError::Invalid(
            "capability authority revision does not match its records".to_owned(),
        ));
    }

    let mut grant_ids = HashSet::new();
    for grant in &state.grants {
        verify_signed_capability_grant(grant)?;
        validate_signed_grant_semantics(grant)?;
        if !grant_ids.insert(grant.grant.id.clone()) {
            return Err(CapabilityError::Invalid(
                "capability grant IDs must be unique".to_owned(),
            ));
        }
    }

    let mut revocation_ids = HashSet::new();
    let mut revoked_grants = HashSet::new();
    for revocation in &state.revocations {
        verify_signed_capability_revocation(revocation)?;
        if !revocation_ids.insert(revocation.revocation.id.clone())
            || !revoked_grants.insert(revocation.revocation.grant_id.clone())
        {
            return Err(CapabilityError::Invalid(
                "capability revocations must be unique".to_owned(),
            ));
        }
        let grant = state
            .grants
            .iter()
            .find(|grant| grant.grant.id == revocation.revocation.grant_id)
            .ok_or_else(|| {
                CapabilityError::Invalid(
                    "capability revocation references an unknown grant".to_owned(),
                )
            })?;
        if grant.grant.issuer_identity_id != revocation.revocation.issuer_identity_id
            || grant.grant.issuer_key_id != revocation.revocation.issuer_key_id
            || grant.subject_root != revocation.revocation.grant_subject_root
            || revocation.revocation.revoked_at_unix_ms < grant.grant.issued_at_unix_ms
        {
            return Err(CapabilityError::Invalid(
                "capability revocation does not match its grant authority".to_owned(),
            ));
        }
    }
    Ok(())
}

fn load_state(path: &Path) -> Result<CapabilityAuthorityState, CapabilityError> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err(CapabilityError::Invalid(
            "capability authority state exceeds its byte limit".to_owned(),
        ));
    }
    let state = serde_json::from_slice(&bytes)?;
    validate_state(&state)?;
    Ok(state)
}

fn persist_state(path: &Path, state: &CapabilityAuthorityState) -> Result<(), CapabilityError> {
    validate_state(state)?;
    let mut bytes = serde_json::to_vec_pretty(state)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_STATE_BYTES {
        return Err(CapabilityError::Invalid(
            "capability authority state exceeds its byte limit".to_owned(),
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        CapabilityError::Invalid("capability authority state has no parent".to_owned())
    })?;
    ensure_private_dir(parent)?;
    let temporary = path.with_extension(format!("json.tmp-{}", process::id()));
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    if let Err(error) = (|| -> Result<(), io::Error> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        set_private_file(&temporary)?;
        fs::rename(&temporary, path)?;
        set_private_file(path)?;
        sync_parent(parent)?;
        Ok(())
    })() {
        let _ = fs::remove_file(&temporary);
        return Err(CapabilityError::Io(error));
    }
    Ok(())
}

fn definition(capability: &str) -> Option<&'static CapabilityDefinition> {
    DEFINITIONS
        .iter()
        .find(|definition| definition.id == capability)
}

fn publisher_is_trusted(definition: &CapabilityDefinition, publisher_id: &str) -> bool {
    definition.trusted_publishers.is_empty()
        || definition.trusted_publishers.contains(&publisher_id)
}

fn validate_capability_constraints(
    capability: &str,
    constraints: &BTreeMap<String, CapabilityConstraintValue>,
    allow_legacy_model_policy: bool,
) -> Result<(), CapabilityError> {
    if capability == MODEL_GENERATE_CAPABILITY {
        let policy = ModelGeneratePolicy::from_constraints(constraints)?;
        if policy.is_none() && !allow_legacy_model_policy {
            return Err(CapabilityError::Invalid(
                "model/generate requires one closed provider policy".to_owned(),
            ));
        }
        return Ok(());
    }
    if constraints.keys().any(|key| key.starts_with("provider.")) {
        return Err(CapabilityError::Invalid(
            "provider policy constraints are valid only for model/generate".to_owned(),
        ));
    }
    Ok(())
}

fn constraint_text(
    constraints: &BTreeMap<String, CapabilityConstraintValue>,
    key: &str,
) -> Result<String, CapabilityError> {
    match constraints.get(key) {
        Some(CapabilityConstraintValue::Text(value)) => Ok(value.clone()),
        _ => Err(CapabilityError::Invalid(format!(
            "model/generate constraint {key} must be text"
        ))),
    }
}

fn constraint_integer(
    constraints: &BTreeMap<String, CapabilityConstraintValue>,
    key: &str,
) -> Result<u64, CapabilityError> {
    match constraints.get(key) {
        Some(CapabilityConstraintValue::Integer(value)) => Ok(*value),
        _ => Err(CapabilityError::Invalid(format!(
            "model/generate constraint {key} must be an integer"
        ))),
    }
}

fn valid_digest(value: &str) -> bool {
    value
        .strip_prefix("sha256:")
        .is_some_and(|suffix| suffix.len() == 64 && suffix.bytes().all(is_lower_hex))
}

fn valid_grant_id(value: &str) -> bool {
    value
        .strip_prefix("grant/")
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(is_lower_hex))
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

pub fn normalize_capability(value: &str) -> Result<String, CapabilityError> {
    normalize_operation_capability(value).map_err(CapabilityError::from)
}

fn validate_timestamp(value: u64, label: &str) -> Result<(), CapabilityError> {
    if value == 0 {
        Err(CapabilityError::Invalid(format!(
            "{label} must be positive"
        )))
    } else {
        Ok(())
    }
}

fn is_expired(grant: &SignedCapabilityGrant, observed_at_unix_ms: u64) -> bool {
    grant
        .grant
        .expires_at_unix_ms
        .is_some_and(|expires| observed_at_unix_ms >= expires)
}

fn ensure_private_dir(path: &Path) -> Result<(), CapabilityError> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file(path: &Path) -> Result<(), io::Error> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    let _ = path;
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), io::Error> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use greenways_identity::{ProfileIdentityVault, DIGEST_TEST_VALUE};
    use greenways_provider::{ModelMessage, ModelMessageRole};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_HOME: AtomicUsize = AtomicUsize::new(1);

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(label: &str) -> Self {
            let sequence = NEXT_HOME.fetch_add(1, Ordering::Relaxed);
            Self(std::env::temp_dir().join(format!(
                "greenways-capabilities-{label}-{}-{sequence}",
                process::id()
            )))
        }

        fn identity(&self) -> PathBuf {
            self.0.join("identity.json")
        }

        fn capabilities(&self) -> PathBuf {
            self.0.join("capabilities.json")
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn signer(home: &TestHome) -> ProfileIdentityVault {
        let mut signer = ProfileIdentityVault::open_test(home.identity())
            .expect("test profile identity should open");
        signer
            .create("authority", 1_000)
            .expect("test profile identity should be created");
        signer
    }

    fn subject(publisher: &str, digest: &str) -> ApplicationApprovalSubject {
        ApplicationApprovalSubject {
            kind: "app".to_owned(),
            app_id: "hara-playground".to_owned(),
            version: "1.2.3".to_owned(),
            publisher_id: publisher.to_owned(),
            lock_digest: None,
            approval_digest: digest.to_owned(),
        }
    }

    fn provider_constraints() -> BTreeMap<String, CapabilityConstraintValue> {
        ModelGeneratePolicy::new("openai.personal", "gpt-5", 512, 30_000)
            .expect("provider policy should build")
            .constraints()
    }

    #[test]
    fn issues_checks_and_revokes_an_exact_signed_grant() {
        let home = TestHome::new("lifecycle");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        let approval = subject("hara-lang", DIGEST_TEST_VALUE);
        let grant = authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "model/generate".to_owned(),
                    subject: approval.clone(),
                    constraints: provider_constraints(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: Some(10_000),
                },
            )
            .expect("capability grant should issue");
        assert!(verify_signed_capability_grant(&grant).is_ok());
        let allowed = authority
            .check(&approval, "model/generate", 3_000)
            .expect("capability decision should complete");
        assert!(allowed.allowed);
        assert_eq!(allowed.grant_id.as_deref(), Some(grant.grant.id.as_str()));
        assert_eq!(
            allowed.grant_subject_root.as_deref(),
            Some(grant.subject_root.as_str())
        );

        let changed = subject(
            "hara-lang",
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        );
        assert!(
            !authority
                .check(&changed, "model/generate", 3_000)
                .expect("changed approval decision")
                .allowed
        );

        let revocation = authority
            .revoke(&signer, &grant.grant.id, "user-revoked", 4_000)
            .expect("grant should revoke");
        assert!(verify_signed_capability_revocation(&revocation).is_ok());
        let denied = authority
            .check(&approval, "model/generate", 5_000)
            .expect("revoked decision should complete");
        assert!(!denied.allowed);
        assert_eq!(denied.reason, "grant-revoked");
        assert_eq!(
            authority.status(5_000).expect("status").revoked_grant_count,
            1
        );
    }

    #[test]
    fn round_trips_one_closed_exact_capability_check() {
        let approval = subject("hara-lang", DIGEST_TEST_VALUE);
        let check = CheckCapability::new(approval.clone(), "Model/Generate")
            .expect("check should normalize");
        assert_eq!(check.capability, "model/generate");
        let arguments = check
            .clone()
            .into_arguments()
            .expect("arguments should encode");
        assert_eq!(
            CheckCapability::from_arguments(&arguments).expect("arguments should decode"),
            check
        );
        let mut changed = arguments;
        changed.insert("extra".to_owned(), Value::Bool(true));
        assert!(CheckCapability::from_arguments(&changed).is_err());

        let denial = CapabilityDecision::denied(&check, "approval-not-found", 3_000)
            .expect("closed denial should build");
        assert!(!denial.allowed);
        assert_eq!(denial.approval_digest, approval.approval_digest);
        assert!(denial.grant_id.is_none());
        assert!(denial.grant_subject_root.is_none());
    }

    #[test]
    fn enforces_one_typed_provider_policy_before_invocation() {
        let home = TestHome::new("provider-policy");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        let approval = subject("hara-lang", DIGEST_TEST_VALUE);
        let policy = ModelGeneratePolicy::new("openai.personal", "gpt-5", 512, 30_000)
            .expect("provider policy should build");
        let grant = authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: MODEL_GENERATE_CAPABILITY.to_owned(),
                    subject: approval.clone(),
                    constraints: policy.constraints(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .expect("provider grant should issue");
        let check = CheckCapability::new(approval.clone(), MODEL_GENERATE_CAPABILITY)
            .expect("provider check should build");
        let invocation = ProviderInvocation::new(
            "openai.personal",
            "gpt-5",
            vec![ModelMessage {
                role: ModelMessageRole::User,
                content: "Hello".to_owned(),
            }],
            128,
            5_000,
        )
        .expect("provider invocation should build");
        let allowed = authority
            .authorize_provider_invocation(&check, &invocation, 3_000)
            .expect("provider authority should decide");
        let ProviderInvocationAuthority::Allowed(evidence) = allowed else {
            panic!("matching provider policy should allow");
        };
        assert_eq!(evidence.grant_id, grant.grant.id);
        assert_eq!(evidence.grant_subject_root, grant.subject_root);
        assert_eq!(evidence.approval_digest, approval.approval_digest);
        assert!(evidence.validate().is_ok());
        assert!(authority
            .matches_provider_grant_evidence_for_invocation(&approval, &evidence, &invocation,)
            .expect("stored evidence should match the exact invocation"));

        let changed_profile = ProviderInvocation::new(
            "openai.other",
            "gpt-5",
            invocation.messages.clone(),
            invocation.max_output_tokens,
            invocation.timeout_ms,
        )
        .expect("changed invocation should remain structurally valid");
        assert_eq!(
            authority
                .authorize_provider_invocation(&check, &changed_profile, 3_000)
                .expect("changed profile should decide"),
            ProviderInvocationAuthority::Denied("provider-policy-denied".to_owned())
        );
        assert!(!authority
            .matches_provider_grant_evidence_for_invocation(&approval, &evidence, &changed_profile,)
            .expect("redirected evidence should fail exact provider policy"));

        let changed_model = ProviderInvocation::new(
            "openai.personal",
            "gpt-5.1",
            invocation.messages.clone(),
            invocation.max_output_tokens,
            invocation.timeout_ms,
        )
        .expect("changed invocation should remain structurally valid");
        assert_eq!(
            authority
                .authorize_provider_invocation(&check, &changed_model, 3_000)
                .expect("changed model should decide"),
            ProviderInvocationAuthority::Denied("provider-policy-denied".to_owned())
        );

        let changed_limit =
            ProviderInvocation::new("openai.personal", "gpt-5", invocation.messages, 513, 30_001)
                .expect("changed invocation should remain structurally valid");
        assert_eq!(
            authority
                .authorize_provider_invocation(&check, &changed_limit, 3_000)
                .expect("changed limits should decide"),
            ProviderInvocationAuthority::Denied("provider-policy-denied".to_owned())
        );
    }

    #[test]
    fn historical_provider_evidence_survives_later_revocation_only_at_its_authorization_time() {
        let home = TestHome::new("provider-policy-history");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        let approval = subject("hara-lang", DIGEST_TEST_VALUE);
        let policy = ModelGeneratePolicy::new("openai.personal", "gpt-5", 512, 30_000)
            .expect("provider policy should build");
        let grant = authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: MODEL_GENERATE_CAPABILITY.to_owned(),
                    subject: approval.clone(),
                    constraints: policy.constraints(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .expect("provider grant should issue");
        let evidence = ProviderGrantEvidence {
            protocol: PROVIDER_GRANT_EVIDENCE_PROTOCOL.to_owned(),
            approval_digest: approval.approval_digest.clone(),
            grant_id: grant.grant.id.clone(),
            grant_subject_root: grant.subject_root.clone(),
            capability: MODEL_GENERATE_CAPABILITY.to_owned(),
        };
        authority
            .revoke(&signer, &grant.grant.id, "user-revoked", 4_000)
            .expect("provider grant should revoke");

        assert!(
            authority
                .matches_active_provider_grant_evidence_for_policy(
                    &approval, &evidence, &policy, 3_000,
                )
                .expect("pre-revocation evidence should remain valid")
        );
        assert!(
            !authority
                .matches_active_provider_grant_evidence_for_policy(
                    &approval, &evidence, &policy, 5_000,
                )
                .expect("post-revocation evidence should be denied")
        );
    }

    #[test]
    fn legacy_unconstrained_grants_do_not_authorize_provider_use() {
        let home = TestHome::new("provider-policy-missing");
        let signer = signer(&home);
        let approval = subject("hara-lang", DIGEST_TEST_VALUE);
        let signed = signer
            .sign_capability_grant(CapabilityGrantRequest {
                id: new_capability_grant_id().expect("legacy grant ID"),
                capability: MODEL_GENERATE_CAPABILITY.to_owned(),
                subject: approval.clone(),
                constraints: BTreeMap::new(),
                issued_at_unix_ms: 2_000,
                expires_at_unix_ms: None,
            })
            .expect("legacy grant should sign");
        let legacy_state = CapabilityAuthorityState {
            protocol: CAPABILITY_AUTHORITY_STATE_PROTOCOL.to_owned(),
            revision: 1,
            grants: vec![signed],
            revocations: Vec::new(),
        };
        persist_state(&home.capabilities(), &legacy_state)
            .expect("legacy grant state should persist");
        let authority = CapabilityAuthority::open(home.capabilities())
            .expect("legacy grant should remain loadable");
        let check = CheckCapability::new(approval, MODEL_GENERATE_CAPABILITY)
            .expect("provider check should build");
        let invocation = ProviderInvocation::new(
            "openai.personal",
            "gpt-5",
            vec![ModelMessage {
                role: ModelMessageRole::User,
                content: "Hello".to_owned(),
            }],
            128,
            5_000,
        )
        .expect("provider invocation should build");
        assert_eq!(
            authority
                .authorize_provider_invocation(&check, &invocation, 3_000)
                .expect("legacy grant should decide"),
            ProviderInvocationAuthority::Denied("provider-policy-missing".to_owned())
        );
    }

    #[test]
    fn rejects_unknown_or_cross_capability_provider_constraints() {
        let home = TestHome::new("provider-policy-shape");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        assert!(authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: MODEL_GENERATE_CAPABILITY.to_owned(),
                    subject: subject("hara-lang", DIGEST_TEST_VALUE),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 1_500,
                    expires_at_unix_ms: None,
                },
            )
            .is_err());

        let mut incomplete = BTreeMap::new();
        incomplete.insert(
            PROVIDER_PROFILE_ID_CONSTRAINT.to_owned(),
            CapabilityConstraintValue::Text("openai.personal".to_owned()),
        );
        assert!(authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: MODEL_GENERATE_CAPABILITY.to_owned(),
                    subject: subject("hara-lang", DIGEST_TEST_VALUE),
                    constraints: incomplete,
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .is_err());

        let mut cross_capability = BTreeMap::new();
        cross_capability.insert(
            PROVIDER_PROFILE_ID_CONSTRAINT.to_owned(),
            CapabilityConstraintValue::Text("openai.personal".to_owned()),
        );
        assert!(authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "tahto/read".to_owned(),
                    subject: subject("hara-lang", DIGEST_TEST_VALUE),
                    constraints: cross_capability,
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .is_err());
    }

    #[test]
    fn enforces_the_closed_vocabulary_and_trusted_publishers() {
        let home = TestHome::new("policy");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        assert!(authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "device/root".to_owned(),
                    subject: subject("greenways-ai", DIGEST_TEST_VALUE),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .is_err());
        assert!(authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "chats/capture".to_owned(),
                    subject: subject("other-publisher", DIGEST_TEST_VALUE),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .is_err());
        assert!(authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "chats/capture".to_owned(),
                    subject: subject("greenways-ai", DIGEST_TEST_VALUE),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .is_ok());
    }

    #[test]
    fn expiration_and_duplicate_issue_are_fail_closed() {
        let home = TestHome::new("expiration");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        let approval = subject("hara-lang", DIGEST_TEST_VALUE);
        let request = IssueCapabilityGrant {
            capability: "model/generate".to_owned(),
            subject: approval.clone(),
            constraints: provider_constraints(),
            issued_at_unix_ms: 2_000,
            expires_at_unix_ms: Some(3_000),
        };
        authority
            .issue(&signer, request.clone())
            .expect("first grant should issue");
        assert!(authority.issue(&signer, request).is_err());
        let decision = authority
            .check(&approval, "model/generate", 3_000)
            .expect("expired decision should complete");
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "grant-expired");
    }

    #[test]
    fn rejects_tampered_persisted_signed_records() {
        let home = TestHome::new("tamper");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "model/generate".to_owned(),
                    subject: subject("hara-lang", DIGEST_TEST_VALUE),
                    constraints: provider_constraints(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .expect("grant should issue");
        let mut state: serde_json::Value =
            serde_json::from_slice(&fs::read(home.capabilities()).expect("capability state"))
                .expect("capability state JSON");
        state["grants"][0]["grant"]["capability"] =
            serde_json::Value::String("tahto/write".to_owned());
        fs::write(
            home.capabilities(),
            serde_json::to_vec_pretty(&state).expect("tampered state JSON"),
        )
        .expect("tampered state should write");
        assert!(CapabilityAuthority::open(home.capabilities()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_capability_authority_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let home = TestHome::new("permissions");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "model/generate".to_owned(),
                    subject: subject("hara-lang", DIGEST_TEST_VALUE),
                    constraints: provider_constraints(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .expect("grant should issue");
        assert_eq!(
            fs::metadata(home.capabilities())
                .expect("capability metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(home.capabilities().parent().expect("capability parent"))
                .expect("capability parent metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
