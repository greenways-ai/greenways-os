use greenways_identity::normalize_profile_handle;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, error::Error, fmt};

pub const DESKTOP_SETUP_PROTOCOL: &str = "greenways-desktop-setup/0-alpha";
pub const DESKTOP_SETUP_RESULT_PROTOCOL: &str = "greenways-desktop-setup-result/0-alpha";
pub const DESKTOP_SETUP_STATUS_PROTOCOL: &str = "greenways-desktop-setup-status/0-alpha";
pub const DESKTOP_SETUP_COMPONENT_PROTOCOL: &str = "greenways-desktop-setup-component/0-alpha";
pub const MAX_SETUP_COMPONENTS: usize = 5;
const MAX_SETUP_ERROR_BYTES: usize = 400;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const DESKTOP_REQUEST_PREFIX: &str = "desktop/request/";
const MIN_REQUEST_SUFFIX_BYTES: usize = 8;
const MAX_REQUEST_SUFFIX_BYTES: usize = 160;

fn valid_desktop_request_id(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix(DESKTOP_REQUEST_PREFIX) else {
        return false;
    };
    (MIN_REQUEST_SUFFIX_BYTES..=MAX_REQUEST_SUFFIX_BYTES).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn valid_public_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .chars()
            .all(|character| !character.is_control() || character == '\n')
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_error_code(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopSetupOperation {
    Inspect,
    InstallDaemon,
    IssueDesktopClient,
    CreateIdentity,
    InstallBrowserBridge,
    Verify,
    RepairPermissions,
}

impl DesktopSetupOperation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Inspect => "inspect",
            Self::InstallDaemon => "install-daemon",
            Self::IssueDesktopClient => "issue-desktop-client",
            Self::CreateIdentity => "create-identity",
            Self::InstallBrowserBridge => "install-browser-bridge",
            Self::Verify => "verify",
            Self::RepairPermissions => "repair-permissions",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSetupRequest {
    pub protocol: String,
    pub request_id: String,
    pub operation: DesktopSetupOperation,
    pub handle: Option<String>,
}

impl DesktopSetupRequest {
    pub fn validate(&self) -> Result<(), DesktopSetupError> {
        if self.protocol != DESKTOP_SETUP_PROTOCOL {
            return Err(DesktopSetupError::ProtocolMismatch(
                "The Desktop setup request protocol is unsupported.".to_owned(),
            ));
        }
        if !valid_desktop_request_id(&self.request_id) {
            return Err(DesktopSetupError::ProtocolMismatch(
                "The Desktop setup request ID is invalid.".to_owned(),
            ));
        }
        match self.operation {
            DesktopSetupOperation::CreateIdentity => {
                let handle = self.handle.as_deref().ok_or_else(|| {
                    DesktopSetupError::ProtocolMismatch(
                        "The Desktop identity handle is required.".to_owned(),
                    )
                })?;
                let normalized = normalize_profile_handle(handle).map_err(|_| {
                    DesktopSetupError::ProtocolMismatch(
                        "The Desktop identity handle is invalid.".to_owned(),
                    )
                })?;
                if normalized != handle {
                    return Err(DesktopSetupError::ProtocolMismatch(
                        "The Desktop identity handle must already be normalized.".to_owned(),
                    ));
                }
            }
            _ if self.handle.is_some() => {
                return Err(DesktopSetupError::ProtocolMismatch(
                    "This Desktop setup operation accepts no identity handle.".to_owned(),
                ));
            }
            _ => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopSetupState {
    NotInspected,
    Inspecting,
    Ready,
    InstallRequired,
    UpgradeRequired,
    PermissionRepairRequired,
    CredentialRequired,
    CredentialRoleMismatch,
    IdentityOptional,
    BrowserCompanionOptional,
    Verifying,
    Complete,
    RestartRequired,
    ManualRecoveryRequired,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopSetupComponentKind {
    GreenwaysHome,
    Daemon,
    DesktopClient,
    Identity,
    BrowserCompanion,
}

const COMPONENT_ORDER: [DesktopSetupComponentKind; MAX_SETUP_COMPONENTS] = [
    DesktopSetupComponentKind::GreenwaysHome,
    DesktopSetupComponentKind::Daemon,
    DesktopSetupComponentKind::DesktopClient,
    DesktopSetupComponentKind::Identity,
    DesktopSetupComponentKind::BrowserCompanion,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSetupComponent {
    pub protocol: String,
    pub kind: DesktopSetupComponentKind,
    pub state: DesktopSetupState,
    pub version: Option<String>,
    pub digest: Option<String>,
    pub public_id: Option<String>,
    pub error_code: Option<String>,
}

impl DesktopSetupComponent {
    pub fn ready(kind: DesktopSetupComponentKind) -> Self {
        Self {
            protocol: DESKTOP_SETUP_COMPONENT_PROTOCOL.to_owned(),
            kind,
            state: DesktopSetupState::Ready,
            version: None,
            digest: None,
            public_id: None,
            error_code: None,
        }
    }

    pub fn optional(kind: DesktopSetupComponentKind, state: DesktopSetupState) -> Self {
        Self {
            protocol: DESKTOP_SETUP_COMPONENT_PROTOCOL.to_owned(),
            kind,
            state,
            version: None,
            digest: None,
            public_id: None,
            error_code: None,
        }
    }

    pub fn blocked(
        kind: DesktopSetupComponentKind,
        state: DesktopSetupState,
        error_code: &str,
    ) -> Self {
        Self {
            protocol: DESKTOP_SETUP_COMPONENT_PROTOCOL.to_owned(),
            kind,
            state,
            version: None,
            digest: None,
            public_id: None,
            error_code: Some(error_code.to_owned()),
        }
    }

    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = Some(version.into());
        self
    }

    pub fn with_digest(mut self, digest: impl Into<String>) -> Self {
        self.digest = Some(digest.into());
        self
    }

    pub fn with_public_id(mut self, public_id: impl Into<String>) -> Self {
        self.public_id = Some(public_id.into());
        self
    }

    fn validate(&self) -> Result<(), DesktopSetupError> {
        if self.protocol != DESKTOP_SETUP_COMPONENT_PROTOCOL {
            return Err(DesktopSetupError::ProtocolMismatch(
                "A Desktop setup component protocol is unsupported.".to_owned(),
            ));
        }
        if let Some(version) = &self.version {
            if !valid_public_text(version, 80) {
                return Err(DesktopSetupError::ProtocolMismatch(
                    "A Desktop setup component version is invalid.".to_owned(),
                ));
            }
        }
        if let Some(digest) = &self.digest {
            if !valid_digest(digest) {
                return Err(DesktopSetupError::ProtocolMismatch(
                    "A Desktop setup component digest is invalid.".to_owned(),
                ));
            }
        }
        if let Some(public_id) = &self.public_id {
            if !valid_public_text(public_id, 180) {
                return Err(DesktopSetupError::ProtocolMismatch(
                    "A Desktop setup component identifier is invalid.".to_owned(),
                ));
            }
        }
        if let Some(error_code) = &self.error_code {
            if !valid_error_code(error_code) {
                return Err(DesktopSetupError::ProtocolMismatch(
                    "A Desktop setup component error code is invalid.".to_owned(),
                ));
            }
        }
        let transient_component_state = matches!(
            self.state,
            DesktopSetupState::NotInspected
                | DesktopSetupState::Inspecting
                | DesktopSetupState::Verifying
                | DesktopSetupState::Complete
                | DesktopSetupState::Failed
        );
        let optional_component_state = matches!(
            self.state,
            DesktopSetupState::IdentityOptional | DesktopSetupState::BrowserCompanionOptional
        );
        let public_metadata_without_readiness = self.state != DesktopSetupState::Ready
            && (self.version.is_some() || self.digest.is_some() || self.public_id.is_some());
        let invalid_error_shape =
            if self.state == DesktopSetupState::Ready || optional_component_state {
                self.error_code.is_some()
            } else {
                self.error_code.is_none()
            };
        if transient_component_state || public_metadata_without_readiness || invalid_error_shape {
            return Err(DesktopSetupError::ProtocolMismatch(
                "A Desktop setup component state is invalid.".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSetupPublicError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSetupSnapshot {
    pub protocol: String,
    pub state: DesktopSetupState,
    pub components: Vec<DesktopSetupComponent>,
    pub permitted_actions: Vec<DesktopSetupOperation>,
    pub observed_at_unix_ms: u64,
    pub error: Option<DesktopSetupPublicError>,
}

impl DesktopSetupSnapshot {
    pub fn not_inspected(observed_at_unix_ms: u64) -> Self {
        Self {
            protocol: DESKTOP_SETUP_STATUS_PROTOCOL.to_owned(),
            state: DesktopSetupState::NotInspected,
            components: Vec::new(),
            permitted_actions: vec![DesktopSetupOperation::Inspect],
            observed_at_unix_ms,
            error: None,
        }
    }

    pub fn failed(error: DesktopSetupError, observed_at_unix_ms: u64) -> Self {
        Self {
            protocol: DESKTOP_SETUP_STATUS_PROTOCOL.to_owned(),
            state: DesktopSetupState::Failed,
            components: Vec::new(),
            permitted_actions: vec![DesktopSetupOperation::Inspect],
            observed_at_unix_ms,
            error: Some(DesktopSetupPublicError {
                code: error.code().to_owned(),
                message: error.public_message(),
            }),
        }
    }

    pub fn inspected(
        components: Vec<DesktopSetupComponent>,
        observed_at_unix_ms: u64,
    ) -> Result<Self, DesktopSetupError> {
        let state = derive_setup_state(&components)?;
        let snapshot = Self {
            protocol: DESKTOP_SETUP_STATUS_PROTOCOL.to_owned(),
            state,
            permitted_actions: permitted_actions_for_state(state),
            components,
            observed_at_unix_ms,
            error: None,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }

    pub fn validate(&self) -> Result<(), DesktopSetupError> {
        if self.protocol != DESKTOP_SETUP_STATUS_PROTOCOL
            || self.observed_at_unix_ms == 0
            || self.observed_at_unix_ms > MAX_JSON_SAFE_INTEGER
        {
            return Err(DesktopSetupError::ProtocolMismatch(
                "The Desktop setup projection is invalid.".to_owned(),
            ));
        }

        match self.state {
            DesktopSetupState::NotInspected => {
                if !self.components.is_empty()
                    || self.permitted_actions != vec![DesktopSetupOperation::Inspect]
                    || self.error.is_some()
                {
                    return Err(DesktopSetupError::ProtocolMismatch(
                        "The not-inspected Desktop setup projection is invalid.".to_owned(),
                    ));
                }
            }
            DesktopSetupState::Inspecting | DesktopSetupState::Verifying => {
                if !self.components.is_empty()
                    || !self.permitted_actions.is_empty()
                    || self.error.is_some()
                {
                    return Err(DesktopSetupError::ProtocolMismatch(
                        "The active Desktop setup projection is invalid.".to_owned(),
                    ));
                }
            }
            DesktopSetupState::Failed => {
                if !self.components.is_empty()
                    || self.permitted_actions != vec![DesktopSetupOperation::Inspect]
                    || self.error.is_none()
                {
                    return Err(DesktopSetupError::ProtocolMismatch(
                        "The failed Desktop setup projection is invalid.".to_owned(),
                    ));
                }
            }
            _ => {
                if self.components.len() != MAX_SETUP_COMPONENTS
                    || self.error.is_some()
                    || self.permitted_actions != permitted_actions_for_state(self.state)
                {
                    return Err(DesktopSetupError::ProtocolMismatch(
                        "The inspected Desktop setup projection is invalid.".to_owned(),
                    ));
                }
                for (expected, component) in COMPONENT_ORDER.iter().zip(&self.components) {
                    if component.kind != *expected {
                        return Err(DesktopSetupError::ProtocolMismatch(
                            "Desktop setup components are out of order.".to_owned(),
                        ));
                    }
                    component.validate()?;
                }
                if self.state != derive_setup_state(&self.components)? {
                    return Err(DesktopSetupError::ProtocolMismatch(
                        "The Desktop setup state does not match its components.".to_owned(),
                    ));
                }
            }
        }

        if let Some(error) = &self.error {
            if !valid_error_code(&error.code)
                || !valid_public_text(&error.message, MAX_SETUP_ERROR_BYTES)
            {
                return Err(DesktopSetupError::ProtocolMismatch(
                    "The Desktop setup failure evidence is invalid.".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSetupResponse {
    pub protocol: String,
    pub request_id: String,
    pub snapshot: DesktopSetupSnapshot,
}

impl DesktopSetupResponse {
    pub fn new(request_id: impl Into<String>, snapshot: DesktopSetupSnapshot) -> Self {
        Self {
            protocol: DESKTOP_SETUP_RESULT_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            snapshot,
        }
    }

    pub fn invalid(error: DesktopSetupError, observed_at_unix_ms: u64) -> Self {
        Self::new(
            "desktop/request/invalid0001",
            DesktopSetupSnapshot::failed(error, observed_at_unix_ms),
        )
    }

    pub fn validate(&self) -> Result<(), DesktopSetupError> {
        if self.protocol != DESKTOP_SETUP_RESULT_PROTOCOL
            || !valid_desktop_request_id(&self.request_id)
        {
            return Err(DesktopSetupError::ProtocolMismatch(
                "The Desktop setup result is invalid.".to_owned(),
            ));
        }
        self.snapshot.validate()
    }
}

fn derive_setup_state(
    components: &[DesktopSetupComponent],
) -> Result<DesktopSetupState, DesktopSetupError> {
    if components.len() != MAX_SETUP_COMPONENTS {
        return Err(DesktopSetupError::ProtocolMismatch(
            "The Desktop setup component set is incomplete.".to_owned(),
        ));
    }
    let states = components
        .iter()
        .map(|component| component.state)
        .collect::<HashSet<_>>();
    let state = if states.contains(&DesktopSetupState::ManualRecoveryRequired) {
        DesktopSetupState::ManualRecoveryRequired
    } else if states.contains(&DesktopSetupState::PermissionRepairRequired) {
        DesktopSetupState::PermissionRepairRequired
    } else if states.contains(&DesktopSetupState::CredentialRoleMismatch) {
        DesktopSetupState::CredentialRoleMismatch
    } else if states.contains(&DesktopSetupState::UpgradeRequired) {
        DesktopSetupState::UpgradeRequired
    } else if states.contains(&DesktopSetupState::RestartRequired) {
        DesktopSetupState::RestartRequired
    } else if states.contains(&DesktopSetupState::InstallRequired) {
        DesktopSetupState::InstallRequired
    } else if states.contains(&DesktopSetupState::CredentialRequired) {
        DesktopSetupState::CredentialRequired
    } else if states.contains(&DesktopSetupState::IdentityOptional) {
        DesktopSetupState::IdentityOptional
    } else if states.contains(&DesktopSetupState::BrowserCompanionOptional) {
        DesktopSetupState::BrowserCompanionOptional
    } else if states
        .iter()
        .all(|state| *state == DesktopSetupState::Ready)
    {
        DesktopSetupState::Complete
    } else {
        DesktopSetupState::Ready
    };
    Ok(state)
}

fn permitted_actions_for_state(state: DesktopSetupState) -> Vec<DesktopSetupOperation> {
    match state {
        DesktopSetupState::InstallRequired
        | DesktopSetupState::UpgradeRequired
        | DesktopSetupState::RestartRequired => vec![
            DesktopSetupOperation::InstallDaemon,
            DesktopSetupOperation::Inspect,
        ],
        DesktopSetupState::PermissionRepairRequired => vec![
            DesktopSetupOperation::RepairPermissions,
            DesktopSetupOperation::Inspect,
        ],
        DesktopSetupState::CredentialRequired => vec![
            DesktopSetupOperation::IssueDesktopClient,
            DesktopSetupOperation::Inspect,
        ],
        DesktopSetupState::IdentityOptional => vec![
            DesktopSetupOperation::CreateIdentity,
            DesktopSetupOperation::Inspect,
        ],
        DesktopSetupState::NotInspected | DesktopSetupState::Failed => {
            vec![DesktopSetupOperation::Inspect]
        }
        DesktopSetupState::Inspecting | DesktopSetupState::Verifying => Vec::new(),
        _ => vec![DesktopSetupOperation::Inspect],
    }
}

#[derive(Debug)]
pub enum DesktopSetupError {
    ProtocolMismatch(String),
    OperationUnavailable(String),
    InspectionFailed(String),
    InstallationFailed(String),
    UnsafeInstallation(String),
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    UnsupportedPlatform(String),
}

impl DesktopSetupError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::ProtocolMismatch(_) => "setup-protocol-mismatch",
            Self::OperationUnavailable(_) => "setup-operation-unavailable",
            Self::InspectionFailed(_) => "setup-inspection-failed",
            Self::InstallationFailed(_) => "setup-installation-failed",
            Self::UnsafeInstallation(_) => "setup-unsafe-installation",
            Self::UnsupportedPlatform(_) => "setup-platform-unsupported",
        }
    }

    pub fn public_message(&self) -> String {
        let message = match self {
            Self::ProtocolMismatch(message)
            | Self::OperationUnavailable(message)
            | Self::InspectionFailed(message)
            | Self::InstallationFailed(message)
            | Self::UnsafeInstallation(message)
            | Self::UnsupportedPlatform(message) => message,
        };
        if valid_public_text(message, MAX_SETUP_ERROR_BYTES) {
            message.clone()
        } else {
            "The Greenways Desktop setup operation could not be completed.".to_owned()
        }
    }
}

impl fmt::Display for DesktopSetupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code(), self.public_message())
    }
}

impl Error for DesktopSetupError {}

pub trait DesktopSetupBackend {
    fn inspect(&mut self) -> Result<DesktopSetupSnapshot, DesktopSetupError>;
    fn install_daemon(&mut self) -> Result<DesktopSetupSnapshot, DesktopSetupError>;
    fn issue_desktop_client(&mut self) -> Result<DesktopSetupSnapshot, DesktopSetupError>;
    fn create_identity(&mut self, handle: &str) -> Result<DesktopSetupSnapshot, DesktopSetupError>;
    fn repair_permissions(&mut self) -> Result<DesktopSetupSnapshot, DesktopSetupError>;
}

mod host;
mod inspect;
mod service;

#[cfg(test)]
mod tests;

pub use host::{decode_setup_request, encode_setup_response, request_protocol, DesktopSetupHost};
pub use inspect::SystemDesktopSetupBackend;
