use crate::ContractError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const CURRENT_SUITE_PROTOCOL: &str = "greenways.suite.current/0-alpha";
pub const SUITE_APPLICATION_PROTOCOL: &str = "greenways.suite.application/0-alpha";
pub const SHARED_REFERENCE_PROTOCOL: &str = "greenways.reference.shared/0-alpha";
pub const HANDOFF_PROTOCOL: &str = "greenways.handoff/0-alpha";
pub const SUITE_RESULT_PROTOCOL: &str = "greenways.result/0-alpha";
pub const CURRENT_SUITE_REVISION: &str = "0.1.0";

pub const SPACES_APPLICATION_ID: &str = "spaces";
pub const FLOW_APPLICATION_ID: &str = "flow";
pub const SPACES_PACKAGE_ID: &str = "greenways/spaces";
pub const FLOW_PACKAGE_ID: &str = "greenways/flow";
pub const RESEARCH_APPLICATION_ID: &str = "research";
pub const BUILD_APPLICATION_ID: &str = "build";
pub const IMAGINE_APPLICATION_ID: &str = "imagine";
pub const WORLD_APPLICATION_ID: &str = "world";

pub const SPACES_QUESTION_TO_FLOW_OPERATION: &str = "spaces.question.send-to-flow-project";
pub const SPACES_BRIEF_TO_FLOW_OPERATION: &str = "spaces.brief.send-to-flow-project";
pub const FLOW_RESULT_TO_SPACES_OPERATION: &str = "flow.result.return-to-spaces";
pub const FLOW_ARTIFACT_TO_SPACES_OPERATION: &str = "flow.artifact.add-to-spaces";

pub const SPACES_TO_FLOW_HANDOFF_ID: &str = "handoff/gate0/spaces-question-to-flow";
pub const FLOW_TO_SPACES_HANDOFF_ID: &str = "handoff/gate0/flow-result-to-spaces";

const MAX_REVISION_BYTES: usize = 64;
const MAX_ID_BYTES: usize = 256;
const MAX_KIND_BYTES: usize = 64;
const MAX_TITLE_BYTES: usize = 160;
const MAX_DETAIL_BYTES: usize = 400;
const MAX_RESULT_MESSAGE_BYTES: usize = 400;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum CurrentApplicationId {
    Spaces,
    Flow,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LegacyApplicationId {
    Research,
    Build,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApplicationPurpose {
    Understand,
    Coordinate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VersionLaw {
    Exact,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CompatibilityDisposition {
    InventoryRequired,
    Absent,
    SafeDisplayAlias,
    VersionedCompatibilityAlias,
    ExplicitMigration,
    RetainedTechnicalIdentity,
    IncompatibleBlocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationPackageMetadata {
    pub id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompatibilitySlot {
    pub legacy_application_id: LegacyApplicationId,
    pub target_application_id: CurrentApplicationId,
    pub disposition: CompatibilityDisposition,
    pub discoverable: bool,
    pub grants_authority: bool,
}

impl CompatibilitySlot {
    pub fn validate(&self) -> Result<(), ContractError> {
        let owner_matches = matches!(
            (self.legacy_application_id, self.target_application_id),
            (LegacyApplicationId::Research, CurrentApplicationId::Spaces)
                | (LegacyApplicationId::Build, CurrentApplicationId::Flow)
        );
        if !owner_matches {
            return Err(ContractError::new(
                "invalid-compatibility-owner",
                "legacy application identity targets the wrong current owner",
            ));
        }
        if self.discoverable || self.grants_authority {
            return Err(ContractError::new(
                "invalid-compatibility-authority",
                "legacy compatibility cannot advertise or grant a second application identity",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuiteApplicationManifest {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub revision: String,
    pub version_law: VersionLaw,
    pub package: ApplicationPackageMetadata,
    pub display_name: String,
    pub launcher_label: String,
    pub purpose: ApplicationPurpose,
    pub route_prefix: String,
    pub cli_family: Vec<String>,
    pub compatibility: Vec<CompatibilitySlot>,
}

impl SuiteApplicationManifest {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, SUITE_APPLICATION_PROTOCOL)?;
        require_current_revision(&self.revision)?;
        require_current_revision(&self.package.revision)?;
        if self.version_law != VersionLaw::Exact {
            return Err(ContractError::new(
                "invalid-version-law",
                "current application versions require exact matching",
            ));
        }
        validate_identifier(&self.package.id, MAX_ID_BYTES, "invalid-package-id")?;
        validate_text(&self.display_name, MAX_TITLE_BYTES, "invalid-display-name")?;
        validate_text(
            &self.launcher_label,
            MAX_TITLE_BYTES,
            "invalid-launcher-label",
        )?;
        if self.cli_family.len() != 2 || self.cli_family[0] != "greenways" {
            return Err(ContractError::new(
                "invalid-cli-family",
                "current application CLI family must be a closed two-part command",
            ));
        }
        for command in &self.cli_family {
            validate_identifier(command, MAX_KIND_BYTES, "invalid-cli-family")?;
        }
        if self.compatibility.len() != 1 {
            return Err(ContractError::new(
                "invalid-compatibility-slot",
                "current applications require one legacy compatibility inventory slot",
            ));
        }
        self.compatibility[0].validate()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CurrentSuiteManifest {
    pub protocol: String,
    pub revision: String,
    pub version_law: VersionLaw,
    pub applications: Vec<SuiteApplicationManifest>,
}

impl CurrentSuiteManifest {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, CURRENT_SUITE_PROTOCOL)?;
        require_current_revision(&self.revision)?;
        if self.version_law != VersionLaw::Exact || self.applications.len() != 2 {
            return Err(ContractError::new(
                "invalid-current-suite",
                "the current suite is exactly versioned Spaces and Flow",
            ));
        }
        let mut ids = BTreeSet::new();
        for application in &self.applications {
            application.validate()?;
            if !ids.insert(application.application_id) {
                return Err(ContractError::new(
                    "duplicate-current-application",
                    "current application identities must be unique",
                ));
            }
        }
        if ids != BTreeSet::from([CurrentApplicationId::Spaces, CurrentApplicationId::Flow])
            || self != &current_suite_manifest()
        {
            return Err(ContractError::new(
                "invalid-current-suite",
                "the current suite is exactly versioned Spaces and Flow",
            ));
        }
        Ok(())
    }
}

pub fn current_suite_manifest() -> CurrentSuiteManifest {
    CurrentSuiteManifest {
        protocol: CURRENT_SUITE_PROTOCOL.to_owned(),
        revision: CURRENT_SUITE_REVISION.to_owned(),
        version_law: VersionLaw::Exact,
        applications: vec![
            SuiteApplicationManifest {
                protocol: SUITE_APPLICATION_PROTOCOL.to_owned(),
                application_id: CurrentApplicationId::Spaces,
                revision: CURRENT_SUITE_REVISION.to_owned(),
                version_law: VersionLaw::Exact,
                package: ApplicationPackageMetadata {
                    id: SPACES_PACKAGE_ID.to_owned(),
                    revision: CURRENT_SUITE_REVISION.to_owned(),
                },
                display_name: "Greenways Spaces".to_owned(),
                launcher_label: "Spaces".to_owned(),
                purpose: ApplicationPurpose::Understand,
                route_prefix: "/spaces/".to_owned(),
                cli_family: vec!["greenways".to_owned(), SPACES_APPLICATION_ID.to_owned()],
                compatibility: vec![CompatibilitySlot {
                    legacy_application_id: LegacyApplicationId::Research,
                    target_application_id: CurrentApplicationId::Spaces,
                    disposition: CompatibilityDisposition::Absent,
                    discoverable: false,
                    grants_authority: false,
                }],
            },
            SuiteApplicationManifest {
                protocol: SUITE_APPLICATION_PROTOCOL.to_owned(),
                application_id: CurrentApplicationId::Flow,
                revision: CURRENT_SUITE_REVISION.to_owned(),
                version_law: VersionLaw::Exact,
                package: ApplicationPackageMetadata {
                    id: FLOW_PACKAGE_ID.to_owned(),
                    revision: CURRENT_SUITE_REVISION.to_owned(),
                },
                display_name: "Greenways Flow".to_owned(),
                launcher_label: "Flow".to_owned(),
                purpose: ApplicationPurpose::Coordinate,
                route_prefix: "/flow/".to_owned(),
                cli_family: vec!["greenways".to_owned(), FLOW_APPLICATION_ID.to_owned()],
                compatibility: vec![CompatibilitySlot {
                    legacy_application_id: LegacyApplicationId::Build,
                    target_application_id: CurrentApplicationId::Flow,
                    disposition: CompatibilityDisposition::IncompatibleBlocked,
                    discoverable: false,
                    grants_authority: false,
                }],
            },
        ],
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReferenceFreshness {
    Current,
    Stale,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ReferenceAuthorityState {
    Observed,
    ResolutionRequired,
    Denied,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharedReference {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub owner_application_id: CurrentApplicationId,
    pub owner_kind: String,
    pub owner_id: String,
    pub record_kind: String,
    pub logical_id: String,
    pub exact_root: Option<String>,
    pub observed_revision: Option<u64>,
    pub observed_at_unix_ms: u64,
    pub freshness: ReferenceFreshness,
    pub authority_state: ReferenceAuthorityState,
    pub authority_transfer: bool,
    pub summary: String,
    pub detail: Option<String>,
}

impl SharedReference {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, SHARED_REFERENCE_PROTOCOL)?;
        validate_revision(&self.application_revision)?;
        if self.owner_application_id != self.application_id {
            return Err(ContractError::new(
                "cross-owner-reference",
                "shared reference owner does not match its application",
            ));
        }
        validate_identifier(&self.owner_kind, MAX_KIND_BYTES, "invalid-owner-kind")?;
        validate_identifier(&self.owner_id, MAX_ID_BYTES, "invalid-owner-id")?;
        validate_identifier(&self.record_kind, MAX_KIND_BYTES, "invalid-record-kind")?;
        validate_identifier(&self.logical_id, MAX_ID_BYTES, "invalid-reference-id")?;
        if let Some(root) = &self.exact_root {
            validate_digest(root)?;
        }
        if self.observed_revision == Some(0) || self.observed_at_unix_ms == 0 {
            return Err(ContractError::new(
                "invalid-reference-observation",
                "shared reference observation must be positive",
            ));
        }
        if matches!(
            self.freshness,
            ReferenceFreshness::Current | ReferenceFreshness::Stale
        ) && self.observed_revision.is_none()
        {
            return Err(ContractError::new(
                "invalid-reference-freshness",
                "current or stale references require an observed revision",
            ));
        }
        if self.authority_transfer {
            return Err(ContractError::new(
                "reference-authority-transfer",
                "shared references never transfer application authority",
            ));
        }
        validate_text(&self.summary, MAX_TITLE_BYTES, "invalid-reference-summary")?;
        if let Some(detail) = &self.detail {
            validate_text(detail, MAX_DETAIL_BYTES, "invalid-reference-detail")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HandoffState {
    Prepared,
    ApprovalRequired,
    Ready,
    Accepted,
    Importing,
    Creating,
    Completed,
    Partial,
    Rejected,
    Cancelled,
    Failed,
}

impl HandoffState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Prepared,
                Self::ApprovalRequired | Self::Ready | Self::Cancelled
            ) | (
                Self::ApprovalRequired,
                Self::Ready | Self::Rejected | Self::Cancelled
            ) | (
                Self::Ready,
                Self::Accepted | Self::Rejected | Self::Cancelled
            ) | (
                Self::Accepted,
                Self::Importing | Self::Creating | Self::Cancelled
            ) | (
                Self::Importing | Self::Creating,
                Self::Completed | Self::Partial | Self::Cancelled | Self::Failed
            )
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HandoffNoResultCode {
    Rejected,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffEnvelope {
    pub protocol: String,
    pub handoff_id: String,
    pub idempotency_key: String,
    pub source: SharedReference,
    pub target_application_id: CurrentApplicationId,
    pub target_application_revision: String,
    pub target_owner_kind: String,
    pub target_owner_id: String,
    pub operation: String,
    pub expected_result_kind: String,
    pub request_digest: String,
    pub state: HandoffState,
    pub result: Option<SharedReference>,
    pub no_result: Option<HandoffNoResultCode>,
}

impl HandoffEnvelope {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, HANDOFF_PROTOCOL)?;
        validate_identifier(&self.handoff_id, MAX_ID_BYTES, "invalid-handoff-id")?;
        validate_identifier(
            &self.idempotency_key,
            MAX_ID_BYTES,
            "invalid-idempotency-key",
        )?;
        self.source.validate()?;
        validate_revision(&self.target_application_revision)?;
        validate_identifier(
            &self.target_owner_kind,
            MAX_KIND_BYTES,
            "invalid-target-owner-kind",
        )?;
        validate_identifier(
            &self.target_owner_id,
            MAX_ID_BYTES,
            "invalid-target-owner-id",
        )?;
        if self.source.application_id == self.target_application_id {
            return Err(ContractError::new(
                "invalid-handoff-boundary",
                "shared handoffs must cross current application ownership",
            ));
        }
        validate_handoff_operation(
            &self.operation,
            self.source.application_id,
            self.target_application_id,
        )?;
        validate_identifier(
            &self.expected_result_kind,
            MAX_KIND_BYTES,
            "invalid-result-kind",
        )?;
        validate_digest(&self.request_digest)?;

        match self.state {
            HandoffState::Prepared
            | HandoffState::ApprovalRequired
            | HandoffState::Ready
            | HandoffState::Accepted
            | HandoffState::Importing
            | HandoffState::Creating => {
                if self.result.is_some() || self.no_result.is_some() {
                    return Err(ContractError::new(
                        "premature-handoff-result",
                        "non-terminal handoff state cannot claim a result",
                    ));
                }
            }
            HandoffState::Completed | HandoffState::Partial => {
                let result = self.result.as_ref().ok_or_else(|| {
                    ContractError::new(
                        "missing-handoff-result",
                        "completed or partial handoff requires an exact result reference",
                    )
                })?;
                result.validate()?;
                if self.no_result.is_some() || result.application_id != self.target_application_id {
                    return Err(ContractError::new(
                        "cross-owner-handoff-result",
                        "handoff result is not owned by the target application",
                    ));
                }
            }
            HandoffState::Rejected => {
                require_no_result(self, HandoffNoResultCode::Rejected)?;
            }
            HandoffState::Cancelled => {
                require_no_result(self, HandoffNoResultCode::Cancelled)?;
            }
            HandoffState::Failed => {
                require_no_result(self, HandoffNoResultCode::Failed)?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HandoffReplay {
    New,
    ExactReplay,
}

pub fn compare_handoff_replay(
    existing: &HandoffEnvelope,
    candidate: &HandoffEnvelope,
) -> Result<HandoffReplay, SuiteFailure> {
    existing.validate().map_err(invalid_handoff_failure)?;
    candidate.validate().map_err(invalid_handoff_failure)?;
    if existing.idempotency_key != candidate.idempotency_key {
        return Ok(HandoffReplay::New);
    }
    if existing.source == candidate.source
        && existing.target_application_id == candidate.target_application_id
        && existing.target_application_revision == candidate.target_application_revision
        && existing.target_owner_kind == candidate.target_owner_kind
        && existing.target_owner_id == candidate.target_owner_id
        && existing.operation == candidate.operation
        && existing.expected_result_kind == candidate.expected_result_kind
        && existing.request_digest == candidate.request_digest
    {
        Ok(HandoffReplay::ExactReplay)
    } else {
        Err(SuiteFailure {
            code: SuiteFailureCode::IdempotencyCollision,
            message: "Idempotency key is already bound to different handoff content.".to_owned(),
            retryable: false,
            application_id: None,
        })
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SuiteResultState {
    Succeeded,
    Partial,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SuiteFailureCode {
    Unavailable,
    Denied,
    InterventionRequired,
    Stale,
    Divergent,
    ResyncRequired,
    Cancelled,
    TimedOut,
    Failed,
    Incompatible,
    Uncertain,
    UnactivatedApplication,
    IdempotencyCollision,
    UnknownApplication,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuiteFailure {
    pub code: SuiteFailureCode,
    pub message: String,
    pub retryable: bool,
    pub application_id: Option<String>,
}

impl SuiteFailure {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_text(
            &self.message,
            MAX_RESULT_MESSAGE_BYTES,
            "invalid-result-message",
        )?;
        if let Some(application_id) = &self.application_id {
            validate_identifier(application_id, MAX_KIND_BYTES, "invalid-result-application")?;
        }
        if matches!(
            self.code,
            SuiteFailureCode::UnactivatedApplication
                | SuiteFailureCode::Incompatible
                | SuiteFailureCode::UnknownApplication
        ) && self.application_id.is_none()
        {
            return Err(ContractError::new(
                "missing-result-application",
                "application resolution failures require the requested application identity",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SuiteResult<T> {
    pub protocol: String,
    pub state: SuiteResultState,
    pub value: Option<T>,
    pub failure: Option<SuiteFailure>,
}

impl<T> SuiteResult<T> {
    pub fn success(value: T) -> Self {
        Self {
            protocol: SUITE_RESULT_PROTOCOL.to_owned(),
            state: SuiteResultState::Succeeded,
            value: Some(value),
            failure: None,
        }
    }

    pub fn partial(value: T, failure: SuiteFailure) -> Self {
        Self {
            protocol: SUITE_RESULT_PROTOCOL.to_owned(),
            state: SuiteResultState::Partial,
            value: Some(value),
            failure: Some(failure),
        }
    }

    pub fn failed(failure: SuiteFailure) -> Self {
        Self {
            protocol: SUITE_RESULT_PROTOCOL.to_owned(),
            state: SuiteResultState::Failed,
            value: None,
            failure: Some(failure),
        }
    }

    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, SUITE_RESULT_PROTOCOL)?;
        match (self.state, self.value.as_ref(), self.failure.as_ref()) {
            (SuiteResultState::Succeeded, Some(_), None) => Ok(()),
            (SuiteResultState::Partial, Some(_), Some(failure))
            | (SuiteResultState::Failed, None, Some(failure)) => failure.validate(),
            _ => Err(ContractError::new(
                "invalid-suite-result",
                "suite result value and failure do not match its state",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationAvailability {
    pub application_id: CurrentApplicationId,
    pub revision: String,
}

pub fn resolve_application_target(application_id: &str) -> SuiteResult<ApplicationAvailability> {
    match application_id {
        SPACES_APPLICATION_ID => SuiteResult::success(ApplicationAvailability {
            application_id: CurrentApplicationId::Spaces,
            revision: CURRENT_SUITE_REVISION.to_owned(),
        }),
        FLOW_APPLICATION_ID => SuiteResult::success(ApplicationAvailability {
            application_id: CurrentApplicationId::Flow,
            revision: CURRENT_SUITE_REVISION.to_owned(),
        }),
        IMAGINE_APPLICATION_ID | WORLD_APPLICATION_ID => SuiteResult::failed(SuiteFailure {
            code: SuiteFailureCode::UnactivatedApplication,
            message: "Requested application is reserved but is not activated.".to_owned(),
            retryable: false,
            application_id: Some(application_id.to_owned()),
        }),
        RESEARCH_APPLICATION_ID | BUILD_APPLICATION_ID => SuiteResult::failed(SuiteFailure {
            code: SuiteFailureCode::Incompatible,
            message: "Legacy application identity requires explicit compatibility resolution."
                .to_owned(),
            retryable: false,
            application_id: Some(application_id.to_owned()),
        }),
        _ => SuiteResult::failed(SuiteFailure {
            code: SuiteFailureCode::UnknownApplication,
            message: "Requested application identity is unknown.".to_owned(),
            retryable: false,
            application_id: Some(application_id.to_owned()),
        }),
    }
}

fn validate_handoff_operation(
    operation: &str,
    source: CurrentApplicationId,
    target: CurrentApplicationId,
) -> Result<(), ContractError> {
    let valid = match (source, target) {
        (CurrentApplicationId::Spaces, CurrentApplicationId::Flow) => {
            operation == SPACES_QUESTION_TO_FLOW_OPERATION
                || operation == SPACES_BRIEF_TO_FLOW_OPERATION
        }
        (CurrentApplicationId::Flow, CurrentApplicationId::Spaces) => {
            operation == FLOW_RESULT_TO_SPACES_OPERATION
                || operation == FLOW_ARTIFACT_TO_SPACES_OPERATION
        }
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(ContractError::new(
            "invalid-handoff-operation",
            "handoff operation does not match its source and target application owners",
        ))
    }
}

fn require_no_result(
    handoff: &HandoffEnvelope,
    expected: HandoffNoResultCode,
) -> Result<(), ContractError> {
    if handoff.result.is_none() && handoff.no_result == Some(expected) {
        Ok(())
    } else {
        Err(ContractError::new(
            "invalid-handoff-no-result",
            "terminal handoff state requires its exact no-result code",
        ))
    }
}

fn invalid_handoff_failure(_error: ContractError) -> SuiteFailure {
    SuiteFailure {
        code: SuiteFailureCode::Failed,
        message: "Handoff contract is invalid.".to_owned(),
        retryable: false,
        application_id: None,
    }
}

fn require_protocol(actual: &str, expected: &str) -> Result<(), ContractError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ContractError::new(
            "protocol-mismatch",
            "contract uses an unsupported protocol",
        ))
    }
}

fn require_current_revision(revision: &str) -> Result<(), ContractError> {
    if revision == CURRENT_SUITE_REVISION {
        Ok(())
    } else {
        Err(ContractError::new(
            "application-revision-mismatch",
            "current suite application revision requires an exact match",
        ))
    }
}

fn validate_revision(revision: &str) -> Result<(), ContractError> {
    validate_identifier(revision, MAX_REVISION_BYTES, "invalid-application-revision")
}

fn validate_digest(value: &str) -> Result<(), ContractError> {
    if value.strip_prefix("sha256:").is_some_and(|suffix| {
        suffix.len() == 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        Ok(())
    } else {
        Err(ContractError::new(
            "invalid-exact-root",
            "exact root must be a lowercase SHA-256 digest",
        ))
    }
}

fn validate_identifier(
    value: &str,
    maximum: usize,
    code: &'static str,
) -> Result<(), ContractError> {
    let valid = !value.is_empty()
        && value.len() <= maximum
        && !value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains("//")
        && !value.contains("..")
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        });
    if valid {
        Ok(())
    } else {
        Err(ContractError::new(code, "contract identity is invalid"))
    }
}

fn validate_text(value: &str, maximum: usize, code: &'static str) -> Result<(), ContractError> {
    if !value.is_empty() && value.len() <= maximum {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "contract text is outside its byte bound",
        ))
    }
}
