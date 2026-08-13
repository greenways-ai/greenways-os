use greenways_authority::{
    read_credential_file, valid_client_id, AuthorityError, LocalClient, LocalClientRole,
    LocalSession, LOCAL_CLIENT_PROTOCOL, LOCAL_SESSION_PROTOCOL,
};
use greenways_hestia::HestiaImportStatus;
use greenways_identity::{
    verify_signed_profile_identity, SignedProfileIdentity, PROFILE_IDENTITY_PROTOCOL,
    SIGNED_PROFILE_IDENTITY_PROTOCOL,
};
use greenways_local::{AuthenticatedLocalClient, GreenwaysPaths, LocalClient as PublicLocalClient};
use greenways_protocol::{
    validate_node_id, DaemonStatus, LocalRequest, LocalResponse, Outcome, DAEMON_STATUS_PROTOCOL,
    LOCAL_PROTOCOL,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    error::Error,
    fmt, io,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const DESKTOP_BRIDGE_PROTOCOL: &str = "greenways-desktop-bridge/0-alpha";
pub const DESKTOP_BRIDGE_RESULT_PROTOCOL: &str = "greenways-desktop-bridge-result/0-alpha";
pub const DESKTOP_CONNECTION_STATUS_PROTOCOL: &str = "greenways-desktop-connection-status/0-alpha";
pub const DESKTOP_SESSION_PROJECTION_PROTOCOL: &str =
    "greenways-desktop-session-projection/0-alpha";
pub const MAX_DESKTOP_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_DESKTOP_RESPONSE_BYTES: usize = 256 * 1024;
const INVALID_REQUEST_ID: &str = "desktop/request/invalid0001";
const DESKTOP_REQUEST_PREFIX: &str = "desktop/request/";
const MAX_REQUEST_ID_BYTES: usize = 180;
const MAX_PUBLIC_TEXT_BYTES: usize = 400;
const MAX_JSON_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_SESSION_LIFETIME_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopCommand {
    Connect,
    Refresh,
    Disconnect,
    Quit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopBridgeRequest {
    pub protocol: String,
    pub request_id: String,
    pub command: DesktopCommand,
}

impl DesktopBridgeRequest {
    pub fn validate(&self) -> Result<(), DesktopBridgeError> {
        if self.protocol != DESKTOP_BRIDGE_PROTOCOL {
            return Err(DesktopBridgeError::ProtocolMismatch(
                "The Desktop bridge request protocol is unsupported.".to_owned(),
            ));
        }
        if !valid_desktop_request_id(&self.request_id) {
            return Err(DesktopBridgeError::ProtocolMismatch(
                "The Desktop bridge request ID is invalid.".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopConnectionState {
    Connecting,
    Connected,
    DesktopBridgeUnavailable,
    DaemonUnavailable,
    CredentialUnavailable,
    AuthenticationRejected,
    SessionExpired,
    ProtocolMismatch,
    Disconnected,
}

impl DesktopConnectionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::DesktopBridgeUnavailable => "desktop-bridge-unavailable",
            Self::DaemonUnavailable => "daemon-unavailable",
            Self::CredentialUnavailable => "credential-unavailable",
            Self::AuthenticationRejected => "authentication-rejected",
            Self::SessionExpired => "session-expired",
            Self::ProtocolMismatch => "protocol-mismatch",
            Self::Disconnected => "disconnected",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopPublicError {
    pub code: DesktopConnectionState,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopDaemonProjection {
    pub protocol: String,
    pub node_id: String,
    pub daemon_version: String,
    pub local_protocol: String,
    pub generation: u64,
    pub state_revision: u64,
    pub started_at_unix_ms: u64,
    pub observed_at_unix_ms: u64,
    pub profile_mode: String,
    pub authority_mode: String,
}

impl DesktopDaemonProjection {
    fn validate(&self) -> Result<(), DesktopBridgeError> {
        if self.protocol != DAEMON_STATUS_PROTOCOL
            || self.local_protocol != LOCAL_PROTOCOL
            || self.authority_mode != "daemon"
            || !validate_node_id(&self.node_id)
            || !valid_public_text(&self.daemon_version, 80)
            || self.generation == 0
            || self.generation > MAX_JSON_SAFE_INTEGER
            || self.state_revision > MAX_JSON_SAFE_INTEGER
            || self.started_at_unix_ms == 0
            || self.started_at_unix_ms > MAX_JSON_SAFE_INTEGER
            || self.observed_at_unix_ms < self.started_at_unix_ms
            || self.observed_at_unix_ms > MAX_JSON_SAFE_INTEGER
            || !valid_public_text(&self.profile_mode, 80)
        {
            return Err(DesktopBridgeError::ProtocolMismatch(
                "The Desktop daemon projection is invalid.".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopActorProjection {
    pub protocol: String,
    pub id: String,
    pub role: String,
    pub label: String,
    pub created_at_unix_ms: u64,
    pub revoked_at_unix_ms: Option<u64>,
}

impl DesktopActorProjection {
    fn validate(&self) -> Result<(), DesktopBridgeError> {
        if self.protocol != LOCAL_CLIENT_PROTOCOL
            || !valid_client_id(&self.id)
            || self.role != LocalClientRole::Desktop.as_str()
            || !valid_public_text(&self.label, 120)
            || self.created_at_unix_ms == 0
            || self.created_at_unix_ms > MAX_JSON_SAFE_INTEGER
            || self.revoked_at_unix_ms.is_some()
        {
            return Err(DesktopBridgeError::ProtocolMismatch(
                "The Desktop actor projection is invalid.".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopIdentityProjection {
    pub protocol: String,
    pub id: String,
    pub handle: String,
    pub key_id: String,
    pub algorithm: String,
    pub created_at_unix_ms: u64,
}

impl DesktopIdentityProjection {
    fn validate(&self) -> Result<(), DesktopBridgeError> {
        if self.protocol != PROFILE_IDENTITY_PROTOCOL
            || !valid_prefixed_hex_id(&self.id, "identity/")
            || !valid_public_text(&self.handle, 48)
            || !valid_digest(&self.key_id)
            || self.algorithm != "p256-sha256-fixed"
            || self.created_at_unix_ms == 0
            || self.created_at_unix_ms > MAX_JSON_SAFE_INTEGER
        {
            return Err(DesktopBridgeError::ProtocolMismatch(
                "The Desktop identity projection is invalid.".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopSessionProjection {
    pub protocol: String,
    pub opened_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub remaining_requests: u32,
}

impl DesktopSessionProjection {
    fn validate(&self) -> Result<(), DesktopBridgeError> {
        if self.protocol != DESKTOP_SESSION_PROJECTION_PROTOCOL
            || self.opened_at_unix_ms == 0
            || self.opened_at_unix_ms > MAX_JSON_SAFE_INTEGER
            || self.expires_at_unix_ms <= self.opened_at_unix_ms
            || self.expires_at_unix_ms > MAX_JSON_SAFE_INTEGER
            || self.expires_at_unix_ms - self.opened_at_unix_ms > MAX_SESSION_LIFETIME_MS
            || self.remaining_requests > 1024
        {
            return Err(DesktopBridgeError::ProtocolMismatch(
                "The Desktop session projection is invalid.".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopConnectionSnapshot {
    pub protocol: String,
    pub state: DesktopConnectionState,
    pub daemon: Option<DesktopDaemonProjection>,
    pub actor: Option<DesktopActorProjection>,
    pub identity: Option<DesktopIdentityProjection>,
    pub hestia_import: Option<HestiaImportStatus>,
    pub session: Option<DesktopSessionProjection>,
    pub error: Option<DesktopPublicError>,
    pub observed_at_unix_ms: u64,
}

impl DesktopConnectionSnapshot {
    pub fn disconnected(observed_at_unix_ms: u64) -> Self {
        Self {
            protocol: DESKTOP_CONNECTION_STATUS_PROTOCOL.to_owned(),
            state: DesktopConnectionState::Disconnected,
            daemon: None,
            actor: None,
            identity: None,
            hestia_import: None,
            session: None,
            error: None,
            observed_at_unix_ms,
        }
    }

    pub fn connecting(observed_at_unix_ms: u64) -> Self {
        Self {
            protocol: DESKTOP_CONNECTION_STATUS_PROTOCOL.to_owned(),
            state: DesktopConnectionState::Connecting,
            daemon: None,
            actor: None,
            identity: None,
            hestia_import: None,
            session: None,
            error: None,
            observed_at_unix_ms,
        }
    }

    pub fn failed(error: DesktopBridgeError, observed_at_unix_ms: u64) -> Self {
        let state = error.state();
        Self {
            protocol: DESKTOP_CONNECTION_STATUS_PROTOCOL.to_owned(),
            state,
            daemon: None,
            actor: None,
            identity: None,
            hestia_import: None,
            session: None,
            error: Some(DesktopPublicError {
                code: state,
                message: error.public_message(),
            }),
            observed_at_unix_ms,
        }
    }

    pub fn validate(&self) -> Result<(), DesktopBridgeError> {
        if self.protocol != DESKTOP_CONNECTION_STATUS_PROTOCOL || self.observed_at_unix_ms == 0 {
            return Err(DesktopBridgeError::ProtocolMismatch(
                "The Desktop connection projection is invalid.".to_owned(),
            ));
        }
        let connected_shape = self.daemon.is_some()
            && self.actor.is_some()
            && self.hestia_import.is_some()
            && self.session.is_some()
            && self.error.is_none();
        match self.state {
            DesktopConnectionState::Connected if !connected_shape => {
                return Err(DesktopBridgeError::ProtocolMismatch(
                    "A connected Desktop projection is incomplete.".to_owned(),
                ));
            }
            DesktopConnectionState::Connected => {}
            DesktopConnectionState::Connecting | DesktopConnectionState::Disconnected
                if self.daemon.is_some()
                    || self.actor.is_some()
                    || self.identity.is_some()
                    || self.hestia_import.is_some()
                    || self.session.is_some()
                    || self.error.is_some() =>
            {
                return Err(DesktopBridgeError::ProtocolMismatch(
                    "An inactive Desktop projection contains authority data.".to_owned(),
                ));
            }
            DesktopConnectionState::Connecting | DesktopConnectionState::Disconnected => {}
            _ if self.daemon.is_some()
                || self.actor.is_some()
                || self.identity.is_some()
                || self.hestia_import.is_some()
                || self.session.is_some()
                || self.error.is_none() =>
            {
                return Err(DesktopBridgeError::ProtocolMismatch(
                    "A failed Desktop projection contains authority data.".to_owned(),
                ));
            }
            _ => {}
        }
        if let Some(daemon) = &self.daemon {
            daemon.validate()?;
        }
        if let Some(actor) = &self.actor {
            actor.validate()?;
        }
        if let Some(identity) = &self.identity {
            identity.validate()?;
        }
        if let Some(hestia_import) = &self.hestia_import {
            hestia_import.validate().map_err(|_| {
                DesktopBridgeError::ProtocolMismatch(
                    "The Desktop Hestia import projection is invalid.".to_owned(),
                )
            })?;
        }
        if let Some(session) = &self.session {
            session.validate()?;
        }
        if let Some(error) = &self.error {
            if error.code != self.state
                || matches!(
                    error.code,
                    DesktopConnectionState::Connecting
                        | DesktopConnectionState::Connected
                        | DesktopConnectionState::Disconnected
                )
                || !valid_public_text(&error.message, MAX_PUBLIC_TEXT_BYTES)
            {
                return Err(DesktopBridgeError::ProtocolMismatch(
                    "The Desktop failure evidence is invalid.".to_owned(),
                ));
            }
        }
        validate_no_secret_projection(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopBridgeResponse {
    pub protocol: String,
    pub request_id: String,
    pub snapshot: DesktopConnectionSnapshot,
}

impl DesktopBridgeResponse {
    pub fn new(request_id: impl Into<String>, snapshot: DesktopConnectionSnapshot) -> Self {
        Self {
            protocol: DESKTOP_BRIDGE_RESULT_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            snapshot,
        }
    }

    pub fn invalid(error: DesktopBridgeError, observed_at_unix_ms: u64) -> Self {
        Self::new(
            INVALID_REQUEST_ID,
            DesktopConnectionSnapshot::failed(error, observed_at_unix_ms),
        )
    }

    pub fn validate(&self) -> Result<(), DesktopBridgeError> {
        if self.protocol != DESKTOP_BRIDGE_RESULT_PROTOCOL
            || !valid_desktop_request_id(&self.request_id)
        {
            return Err(DesktopBridgeError::ProtocolMismatch(
                "The Desktop bridge result is invalid.".to_owned(),
            ));
        }
        self.snapshot.validate()
    }
}

#[derive(Debug)]
pub enum DesktopBridgeError {
    DaemonUnavailable(String),
    CredentialUnavailable(String),
    AuthenticationRejected(String),
    SessionExpired(String),
    ProtocolMismatch(String),
}

impl DesktopBridgeError {
    pub const fn state(&self) -> DesktopConnectionState {
        match self {
            Self::DaemonUnavailable(_) => DesktopConnectionState::DaemonUnavailable,
            Self::CredentialUnavailable(_) => DesktopConnectionState::CredentialUnavailable,
            Self::AuthenticationRejected(_) => DesktopConnectionState::AuthenticationRejected,
            Self::SessionExpired(_) => DesktopConnectionState::SessionExpired,
            Self::ProtocolMismatch(_) => DesktopConnectionState::ProtocolMismatch,
        }
    }

    pub fn public_message(&self) -> String {
        let message = match self {
            Self::DaemonUnavailable(message)
            | Self::CredentialUnavailable(message)
            | Self::AuthenticationRejected(message)
            | Self::SessionExpired(message)
            | Self::ProtocolMismatch(message) => message,
        };
        if valid_public_text(message, MAX_PUBLIC_TEXT_BYTES) {
            message.clone()
        } else {
            "The Greenways Desktop connection could not be completed.".to_owned()
        }
    }
}

impl fmt::Display for DesktopBridgeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{}: {}",
            self.state().as_str(),
            self.public_message()
        )
    }
}

impl Error for DesktopBridgeError {}

pub trait DesktopConnectionBackend {
    fn connect(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError>;
    fn refresh(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError>;
    fn disconnect(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError>;
}

pub struct DesktopBridgeHost<B> {
    backend: B,
    snapshot: DesktopConnectionSnapshot,
}

impl<B: DesktopConnectionBackend> DesktopBridgeHost<B> {
    pub fn new(backend: B, observed_at_unix_ms: u64) -> Self {
        Self {
            backend,
            snapshot: DesktopConnectionSnapshot::disconnected(observed_at_unix_ms),
        }
    }

    pub fn snapshot(&self) -> &DesktopConnectionSnapshot {
        &self.snapshot
    }

    pub fn handle(
        &mut self,
        request: DesktopBridgeRequest,
    ) -> Result<(DesktopBridgeResponse, bool), DesktopBridgeError> {
        request.validate()?;
        let quit = request.command == DesktopCommand::Quit;
        let result = match request.command {
            DesktopCommand::Connect => self.backend.connect(),
            DesktopCommand::Refresh => self.backend.refresh(),
            DesktopCommand::Disconnect | DesktopCommand::Quit => self.backend.disconnect(),
        };
        self.snapshot = match result {
            Ok(snapshot) => snapshot,
            Err(error) => DesktopConnectionSnapshot::failed(error, now_unix_ms()?),
        };
        self.snapshot.validate()?;
        let response = DesktopBridgeResponse::new(request.request_id, self.snapshot.clone());
        response.validate()?;
        Ok((response, quit))
    }
}

pub struct DaemonDesktopBackend {
    paths: GreenwaysPaths,
    credential_path: PathBuf,
    client: Option<AuthenticatedLocalClient>,
    authenticated_requests: u32,
}

impl fmt::Debug for DaemonDesktopBackend {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DaemonDesktopBackend")
            .field("home", &self.paths.home)
            .field("connected", &self.client.is_some())
            .field("authenticated_requests", &self.authenticated_requests)
            .finish()
    }
}

impl DaemonDesktopBackend {
    pub fn resolve() -> Result<Self, DesktopBridgeError> {
        let paths = GreenwaysPaths::resolve(None).map_err(map_local_error)?;
        let credential_path = default_credential_path(&paths.home);
        Ok(Self::new(paths, credential_path))
    }

    pub fn new(paths: GreenwaysPaths, credential_path: PathBuf) -> Self {
        Self {
            paths,
            credential_path,
            client: None,
            authenticated_requests: 0,
        }
    }

    fn public_status(&self) -> Result<DesktopDaemonProjection, DesktopBridgeError> {
        let response = PublicLocalClient::from_paths(&self.paths)
            .status()
            .map_err(map_local_error)?;
        decode_daemon_status(&response)
    }

    fn require_desktop_credential(&self) -> Result<(), DesktopBridgeError> {
        let credential = read_credential_file(&self.credential_path).map_err(|_| {
            DesktopBridgeError::CredentialUnavailable(
                "The fixed Desktop credential is missing, malformed, symbolic, or not private."
                    .to_owned(),
            )
        })?;
        if credential.role != LocalClientRole::Desktop {
            return Err(DesktopBridgeError::AuthenticationRejected(
                "The configured local credential is not enrolled with the Desktop role.".to_owned(),
            ));
        }
        Ok(())
    }

    fn require_request_capacity(&mut self, requested: u32) -> Result<(), DesktopBridgeError> {
        let client = self.client.as_ref().ok_or_else(|| {
            DesktopBridgeError::SessionExpired(
                "The Desktop daemon session is no longer active.".to_owned(),
            )
        })?;
        let session = client.session();
        let now = now_unix_ms()?;
        let available = session
            .remaining_requests
            .saturating_sub(self.authenticated_requests);
        if now >= session.expires_at_unix_ms || available < requested {
            self.client = None;
            return Err(DesktopBridgeError::SessionExpired(
                "The Desktop daemon session expired. Reconnect to continue.".to_owned(),
            ));
        }
        Ok(())
    }

    fn authenticated_request(
        &mut self,
        operation: &str,
    ) -> Result<LocalResponse, DesktopBridgeError> {
        let (expires_at_unix_ms, remaining_requests) = {
            let client = self.client.as_ref().ok_or_else(|| {
                DesktopBridgeError::SessionExpired(
                    "The Desktop daemon session is no longer active.".to_owned(),
                )
            })?;
            let session = client.session();
            (session.expires_at_unix_ms, session.remaining_requests)
        };
        let now = now_unix_ms()?;
        if now >= expires_at_unix_ms || self.authenticated_requests >= remaining_requests {
            self.client = None;
            return Err(DesktopBridgeError::SessionExpired(
                "The Desktop daemon session expired. Reconnect to continue.".to_owned(),
            ));
        }
        let client = self.client.as_mut().ok_or_else(|| {
            DesktopBridgeError::SessionExpired(
                "The Desktop daemon session is no longer active.".to_owned(),
            )
        })?;
        let request = match operation {
            "status" => {
                LocalRequest::status(greenways_protocol::new_request_id().map_err(|_| {
                    DesktopBridgeError::ProtocolMismatch(
                        "The Desktop bridge could not allocate a local request ID.".to_owned(),
                    )
                })?)
            }
            "client.whoami" => {
                LocalRequest::whoami(greenways_protocol::new_request_id().map_err(|_| {
                    DesktopBridgeError::ProtocolMismatch(
                        "The Desktop bridge could not allocate a local request ID.".to_owned(),
                    )
                })?)
            }
            "identity.public-card" => LocalRequest::identity_public_card(
                greenways_protocol::new_request_id().map_err(|_| {
                    DesktopBridgeError::ProtocolMismatch(
                        "The Desktop bridge could not allocate a local request ID.".to_owned(),
                    )
                })?,
            ),
            "hestia.import.status" => LocalRequest::hestia_import_status(
                greenways_protocol::new_request_id().map_err(|_| {
                    DesktopBridgeError::ProtocolMismatch(
                        "The Desktop bridge could not allocate a local request ID.".to_owned(),
                    )
                })?,
            ),
            _ => {
                return Err(DesktopBridgeError::ProtocolMismatch(
                    "The Desktop bridge attempted an unsupported daemon operation.".to_owned(),
                ));
            }
        };
        let response = client.send(&request).map_err(map_local_error)?;
        self.authenticated_requests = self.authenticated_requests.saturating_add(1);
        Ok(response)
    }

    fn connected_snapshot(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError> {
        self.require_request_capacity(4)?;
        let expected_client_id = self
            .client
            .as_ref()
            .ok_or_else(|| {
                DesktopBridgeError::SessionExpired(
                    "The Desktop daemon session is no longer active.".to_owned(),
                )
            })?
            .session()
            .client_id
            .clone();
        let daemon = decode_daemon_status(&self.authenticated_request("status")?)?;
        let actor = decode_desktop_actor(
            &self.authenticated_request("client.whoami")?,
            &expected_client_id,
        )?;
        let identity_response = self.authenticated_request("identity.public-card")?;
        let identity = decode_public_identity(&identity_response)?;
        let hestia_import =
            decode_hestia_import_status(&self.authenticated_request("hestia.import.status")?)?;
        let client = self.client.as_ref().ok_or_else(|| {
            DesktopBridgeError::SessionExpired("The Desktop daemon session disappeared.".to_owned())
        })?;
        let session = project_session(client.session(), self.authenticated_requests)?;
        let snapshot = DesktopConnectionSnapshot {
            protocol: DESKTOP_CONNECTION_STATUS_PROTOCOL.to_owned(),
            state: DesktopConnectionState::Connected,
            daemon: Some(daemon),
            actor: Some(actor),
            identity,
            hestia_import: Some(hestia_import),
            session: Some(session),
            error: None,
            observed_at_unix_ms: now_unix_ms()?,
        };
        snapshot.validate()?;
        Ok(snapshot)
    }
}

impl DesktopConnectionBackend for DaemonDesktopBackend {
    fn connect(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError> {
        self.client = None;
        self.authenticated_requests = 0;
        self.require_desktop_credential()?;
        let _ = self.public_status()?;
        let client = AuthenticatedLocalClient::from_paths(&self.paths, &self.credential_path)
            .map_err(map_local_error)?;
        if client.session().role != LocalClientRole::Desktop {
            return Err(DesktopBridgeError::AuthenticationRejected(
                "The daemon opened a session for a non-Desktop local role.".to_owned(),
            ));
        }
        self.client = Some(client);
        match self.connected_snapshot() {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                self.client = None;
                Err(error)
            }
        }
    }

    fn refresh(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError> {
        if self.client.is_none() {
            return Ok(DesktopConnectionSnapshot::disconnected(now_unix_ms()?));
        }
        match self.connected_snapshot() {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                self.client = None;
                Err(error)
            }
        }
    }

    fn disconnect(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError> {
        self.client = None;
        self.authenticated_requests = 0;
        Ok(DesktopConnectionSnapshot::disconnected(now_unix_ms()?))
    }
}

pub fn decode_request(bytes: &[u8]) -> Result<DesktopBridgeRequest, DesktopBridgeError> {
    if bytes.len() > MAX_DESKTOP_REQUEST_BYTES {
        return Err(DesktopBridgeError::ProtocolMismatch(
            "Desktop bridge requests are limited to 64 KiB.".to_owned(),
        ));
    }
    let request: DesktopBridgeRequest = serde_json::from_slice(bytes).map_err(|_| {
        DesktopBridgeError::ProtocolMismatch(
            "Desktop bridge input must be one closed JSON object.".to_owned(),
        )
    })?;
    request.validate()?;
    Ok(request)
}

pub fn encode_response(response: &DesktopBridgeResponse) -> Result<Vec<u8>, DesktopBridgeError> {
    response.validate()?;
    let mut bytes = serde_json::to_vec(response).map_err(|_| {
        DesktopBridgeError::ProtocolMismatch(
            "The Desktop bridge result could not be encoded.".to_owned(),
        )
    })?;
    bytes.push(b'\n');
    if bytes.len() > MAX_DESKTOP_RESPONSE_BYTES {
        return Err(DesktopBridgeError::ProtocolMismatch(
            "The Desktop bridge result exceeded its size limit.".to_owned(),
        ));
    }
    Ok(bytes)
}

fn decode_daemon_status(
    response: &LocalResponse,
) -> Result<DesktopDaemonProjection, DesktopBridgeError> {
    let value = require_ok(response)?;
    let status: DaemonStatus = serde_json::from_value(value.clone()).map_err(|_| {
        DesktopBridgeError::ProtocolMismatch(
            "The daemon returned an invalid status projection.".to_owned(),
        )
    })?;
    if status.protocol != DAEMON_STATUS_PROTOCOL
        || status.local_protocol != LOCAL_PROTOCOL
        || status.authority_mode != "daemon"
        || !validate_node_id(&status.node_id)
        || status.daemon_version.is_empty()
        || status.daemon_version.len() > 80
        || status.generation == 0
        || status.started_at_unix_ms == 0
        || status.observed_at_unix_ms < status.started_at_unix_ms
        || !valid_public_text(&status.profile_mode, 80)
    {
        return Err(DesktopBridgeError::ProtocolMismatch(
            "The daemon status does not match the Desktop contract.".to_owned(),
        ));
    }
    Ok(DesktopDaemonProjection {
        protocol: status.protocol,
        node_id: status.node_id,
        daemon_version: status.daemon_version,
        local_protocol: status.local_protocol,
        generation: status.generation,
        state_revision: status.state_revision,
        started_at_unix_ms: status.started_at_unix_ms,
        observed_at_unix_ms: status.observed_at_unix_ms,
        profile_mode: status.profile_mode,
        authority_mode: status.authority_mode,
    })
}

fn decode_desktop_actor(
    response: &LocalResponse,
    expected_client_id: &str,
) -> Result<DesktopActorProjection, DesktopBridgeError> {
    let value = require_ok(response)?;
    let actor: LocalClient = serde_json::from_value(value.clone()).map_err(|_| {
        DesktopBridgeError::ProtocolMismatch(
            "The daemon returned an invalid Desktop actor.".to_owned(),
        )
    })?;
    if actor.protocol != LOCAL_CLIENT_PROTOCOL
        || !valid_client_id(&actor.id)
        || actor.id != expected_client_id
        || actor.role != LocalClientRole::Desktop
        || !valid_public_text(&actor.label, 120)
        || actor.created_at_unix_ms == 0
    {
        return Err(DesktopBridgeError::ProtocolMismatch(
            "The daemon actor does not match the Desktop role.".to_owned(),
        ));
    }
    if actor.revoked_at_unix_ms.is_some() {
        return Err(DesktopBridgeError::AuthenticationRejected(
            "The enrolled Desktop client has been revoked.".to_owned(),
        ));
    }
    Ok(DesktopActorProjection {
        protocol: actor.protocol,
        id: actor.id,
        role: actor.role.as_str().to_owned(),
        label: actor.label,
        created_at_unix_ms: actor.created_at_unix_ms,
        revoked_at_unix_ms: None,
    })
}

fn decode_public_identity(
    response: &LocalResponse,
) -> Result<Option<DesktopIdentityProjection>, DesktopBridgeError> {
    if response.outcome == Outcome::Error
        && response
            .error
            .as_ref()
            .is_some_and(|error| error.code == "identity-unconfigured")
    {
        return Ok(None);
    }
    let value = require_ok(response)?;
    let identity: SignedProfileIdentity = serde_json::from_value(value.clone()).map_err(|_| {
        DesktopBridgeError::ProtocolMismatch(
            "The daemon returned an invalid public identity.".to_owned(),
        )
    })?;
    if identity.protocol != SIGNED_PROFILE_IDENTITY_PROTOCOL
        || identity.subject.protocol != PROFILE_IDENTITY_PROTOCOL
        || verify_signed_profile_identity(&identity).is_err()
    {
        return Err(DesktopBridgeError::ProtocolMismatch(
            "The public identity evidence did not verify.".to_owned(),
        ));
    }
    let subject = identity.subject;
    Ok(Some(DesktopIdentityProjection {
        protocol: subject.protocol,
        id: subject.id,
        handle: subject.handle,
        key_id: subject.key_id,
        algorithm: subject.algorithm,
        created_at_unix_ms: subject.created_at_unix_ms,
    }))
}

fn decode_hestia_import_status(
    response: &LocalResponse,
) -> Result<HestiaImportStatus, DesktopBridgeError> {
    let value = require_ok(response)?;
    let status: HestiaImportStatus = serde_json::from_value(value.clone()).map_err(|_| {
        DesktopBridgeError::ProtocolMismatch(
            "The daemon returned an invalid Hestia import status.".to_owned(),
        )
    })?;
    status.validate().map_err(|_| {
        DesktopBridgeError::ProtocolMismatch(
            "The daemon returned unsupported Hestia import readiness.".to_owned(),
        )
    })?;
    Ok(status)
}

fn project_session(
    session: &LocalSession,
    authenticated_requests: u32,
) -> Result<DesktopSessionProjection, DesktopBridgeError> {
    if session.protocol != LOCAL_SESSION_PROTOCOL
        || session.role != LocalClientRole::Desktop
        || session.opened_at_unix_ms == 0
        || session.expires_at_unix_ms <= session.opened_at_unix_ms
        || session.expires_at_unix_ms - session.opened_at_unix_ms > MAX_SESSION_LIFETIME_MS
        || session.remaining_requests == 0
    {
        return Err(DesktopBridgeError::ProtocolMismatch(
            "The daemon returned an invalid Desktop session.".to_owned(),
        ));
    }
    Ok(DesktopSessionProjection {
        protocol: DESKTOP_SESSION_PROJECTION_PROTOCOL.to_owned(),
        opened_at_unix_ms: session.opened_at_unix_ms,
        expires_at_unix_ms: session.expires_at_unix_ms,
        remaining_requests: session
            .remaining_requests
            .saturating_sub(authenticated_requests),
    })
}

fn require_ok(response: &LocalResponse) -> Result<&Value, DesktopBridgeError> {
    if response.outcome == Outcome::Ok {
        return response.value.as_ref().ok_or_else(|| {
            DesktopBridgeError::ProtocolMismatch(
                "The daemon returned an empty successful response.".to_owned(),
            )
        });
    }
    let error = response.error.as_ref().ok_or_else(|| {
        DesktopBridgeError::ProtocolMismatch(
            "The daemon returned an incomplete error response.".to_owned(),
        )
    })?;
    match error.code.as_str() {
        "authentication-rejected" | "authentication-required" | "authority-denied" => {
            Err(DesktopBridgeError::AuthenticationRejected(
                "The daemon rejected the enrolled Desktop client.".to_owned(),
            ))
        }
        "session-expired" | "session-unavailable" => Err(DesktopBridgeError::SessionExpired(
            "The Desktop daemon session expired. Reconnect to continue.".to_owned(),
        )),
        _ => Err(DesktopBridgeError::ProtocolMismatch(
            "The daemon returned an unsupported local error.".to_owned(),
        )),
    }
}

fn map_local_error(error: greenways_local::LocalError) -> DesktopBridgeError {
    match error {
        greenways_local::LocalError::MissingHome => DesktopBridgeError::CredentialUnavailable(
            "Greenways home is unavailable. Configure the local installation first.".to_owned(),
        ),
        greenways_local::LocalError::Io(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound
                    | io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::BrokenPipe
                    | io::ErrorKind::TimedOut
                    | io::ErrorKind::UnexpectedEof
            ) =>
        {
            DesktopBridgeError::DaemonUnavailable(
                "The local Greenways daemon is not reachable.".to_owned(),
            )
        }
        greenways_local::LocalError::Io(_) => DesktopBridgeError::DaemonUnavailable(
            "The local Greenways transport is unavailable.".to_owned(),
        ),
        greenways_local::LocalError::Authority(AuthorityError::CredentialRejected) => {
            DesktopBridgeError::AuthenticationRejected(
                "The daemon rejected the enrolled Desktop credential.".to_owned(),
            )
        }
        greenways_local::LocalError::Authority(_) => DesktopBridgeError::CredentialUnavailable(
            "The fixed Desktop credential is unavailable or not private.".to_owned(),
        ),
        greenways_local::LocalError::AuthenticationRejected
        | greenways_local::LocalError::SessionMismatch => {
            DesktopBridgeError::AuthenticationRejected(
                "The daemon rejected the enrolled Desktop credential.".to_owned(),
            )
        }
        greenways_local::LocalError::Protocol(_)
        | greenways_local::LocalError::Encoding(_)
        | greenways_local::LocalError::ResponseMismatch
        | greenways_local::LocalError::UnsupportedPlatform => DesktopBridgeError::ProtocolMismatch(
            "Greenways Desktop and greenwaysd do not share a supported local protocol.".to_owned(),
        ),
    }
}

fn validate_no_secret_projection(
    snapshot: &DesktopConnectionSnapshot,
) -> Result<(), DesktopBridgeError> {
    let value = serde_json::to_value(snapshot).map_err(|_| {
        DesktopBridgeError::ProtocolMismatch(
            "The Desktop snapshot could not be inspected.".to_owned(),
        )
    })?;
    scan_public_value(&value)
}

fn scan_public_value(value: &Value) -> Result<(), DesktopBridgeError> {
    match value {
        Value::Object(values) => {
            for (key, value) in values {
                let normalized = key
                    .bytes()
                    .filter(|byte| byte.is_ascii_alphanumeric())
                    .map(|byte| byte.to_ascii_lowercase())
                    .map(char::from)
                    .collect::<String>();
                if [
                    "token",
                    "credential",
                    "secret",
                    "password",
                    "cookie",
                    "authorization",
                    "privatekey",
                    "keyhandle",
                    "providerhandle",
                    "sessionid",
                ]
                .iter()
                .any(|forbidden| normalized.contains(forbidden))
                {
                    return Err(DesktopBridgeError::ProtocolMismatch(
                        "The Desktop snapshot attempted to expose confidential authority."
                            .to_owned(),
                    ));
                }
                scan_public_value(value)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                scan_public_value(value)?;
            }
        }
        Value::String(value)
            if value.starts_with("gwc_")
                || value.starts_with("local/session/")
                || value.starts_with("profile-key-")
                || value.starts_with("provider-key-")
                || value.starts_with("credential-key-") =>
        {
            return Err(DesktopBridgeError::ProtocolMismatch(
                "The Desktop snapshot attempted to expose a local credential.".to_owned(),
            ));
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}

fn valid_desktop_request_id(value: &str) -> bool {
    value.len() <= MAX_REQUEST_ID_BYTES
        && value
            .strip_prefix(DESKTOP_REQUEST_PREFIX)
            .is_some_and(|suffix| {
                (8..=160).contains(&suffix.len())
                    && suffix.bytes().all(|byte| {
                        byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-')
                    })
            })
}

fn valid_public_text(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}

fn valid_prefixed_hex_id(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|suffix| {
        suffix.len() == 32
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|suffix| {
        suffix.len() == 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

pub fn now_unix_ms() -> Result<u64, DesktopBridgeError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| {
            DesktopBridgeError::ProtocolMismatch(
                "The system clock is before the Unix epoch.".to_owned(),
            )
        })?
        .as_millis();
    u64::try_from(millis).map_err(|_| {
        DesktopBridgeError::ProtocolMismatch("The system clock is outside its bound.".to_owned())
    })
}

pub fn default_credential_path(home: &Path) -> PathBuf {
    home.join("clients").join("desktop.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Debug)]
    struct FakeBackend {
        connect: VecDeque<Result<DesktopConnectionSnapshot, DesktopBridgeError>>,
        refresh: VecDeque<Result<DesktopConnectionSnapshot, DesktopBridgeError>>,
        disconnected_at: u64,
    }

    impl DesktopConnectionBackend for FakeBackend {
        fn connect(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError> {
            self.connect.pop_front().expect("connect result")
        }

        fn refresh(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError> {
            self.refresh.pop_front().expect("refresh result")
        }

        fn disconnect(&mut self) -> Result<DesktopConnectionSnapshot, DesktopBridgeError> {
            Ok(DesktopConnectionSnapshot::disconnected(
                self.disconnected_at,
            ))
        }
    }

    fn connected_snapshot(identity: bool) -> DesktopConnectionSnapshot {
        DesktopConnectionSnapshot {
            protocol: DESKTOP_CONNECTION_STATUS_PROTOCOL.to_owned(),
            state: DesktopConnectionState::Connected,
            daemon: Some(DesktopDaemonProjection {
                protocol: DAEMON_STATUS_PROTOCOL.to_owned(),
                node_id: "node/00112233445566778899aabbccddeeff".to_owned(),
                daemon_version: "0.1.0".to_owned(),
                local_protocol: LOCAL_PROTOCOL.to_owned(),
                generation: 4,
                state_revision: 9,
                started_at_unix_ms: 1,
                observed_at_unix_ms: 2,
                profile_mode: "configured".to_owned(),
                authority_mode: "daemon".to_owned(),
            }),
            actor: Some(DesktopActorProjection {
                protocol: LOCAL_CLIENT_PROTOCOL.to_owned(),
                id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
                role: "desktop".to_owned(),
                label: "Greenways Desktop".to_owned(),
                created_at_unix_ms: 1,
                revoked_at_unix_ms: None,
            }),
            identity: identity.then(|| DesktopIdentityProjection {
                protocol: PROFILE_IDENTITY_PROTOCOL.to_owned(),
                id: "identity/00112233445566778899aabbccddeeff".to_owned(),
                handle: "greenways".to_owned(),
                key_id: "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_owned(),
                algorithm: "p256-sha256-fixed".to_owned(),
                created_at_unix_ms: 1,
            }),
            hestia_import: Some(
                HestiaImportStatus::from_compiled_lock().expect("compiled Hestia import"),
            ),
            session: Some(DesktopSessionProjection {
                protocol: DESKTOP_SESSION_PROJECTION_PROTOCOL.to_owned(),
                opened_at_unix_ms: 1,
                expires_at_unix_ms: 300_001,
                remaining_requests: 124,
            }),
            error: None,
            observed_at_unix_ms: 2,
        }
    }

    fn request(command: DesktopCommand) -> DesktopBridgeRequest {
        DesktopBridgeRequest {
            protocol: DESKTOP_BRIDGE_PROTOCOL.to_owned(),
            request_id: "desktop/request/0011223344556677".to_owned(),
            command,
        }
    }

    #[test]
    fn rejects_unknown_request_fields() {
        let bytes = br#"{"protocol":"greenways-desktop-bridge/0-alpha","requestId":"desktop/request/00112233","command":"connect","role":"developer"}"#;
        assert!(decode_request(bytes).is_err());
    }

    #[test]
    fn accepts_only_closed_commands_and_request_ids() {
        assert!(request(DesktopCommand::Connect).validate().is_ok());
        let mut changed = request(DesktopCommand::Connect);
        changed.request_id = "local/request/00112233".to_owned();
        assert!(changed.validate().is_err());
    }

    #[test]
    fn state_machine_connects_refreshes_and_disconnects() {
        let backend = FakeBackend {
            connect: VecDeque::from([Ok(connected_snapshot(true))]),
            refresh: VecDeque::from([Ok(connected_snapshot(false))]),
            disconnected_at: 9,
        };
        let mut host = DesktopBridgeHost::new(backend, 1);
        let (connected, quit) = host.handle(request(DesktopCommand::Connect)).unwrap();
        assert!(!quit);
        assert_eq!(connected.snapshot.state, DesktopConnectionState::Connected);
        assert!(connected.snapshot.identity.is_some());
        let (degraded, _) = host.handle(request(DesktopCommand::Refresh)).unwrap();
        assert_eq!(degraded.snapshot.state, DesktopConnectionState::Connected);
        assert!(degraded.snapshot.identity.is_none());
        let (disconnected, _) = host.handle(request(DesktopCommand::Disconnect)).unwrap();
        assert_eq!(
            disconnected.snapshot.state,
            DesktopConnectionState::Disconnected
        );
    }

    #[test]
    fn failure_state_contains_no_partial_authority_projection() {
        let snapshot = DesktopConnectionSnapshot::failed(
            DesktopBridgeError::AuthenticationRejected("Re-enrol Desktop.".to_owned()),
            1,
        );
        assert_eq!(
            snapshot.state,
            DesktopConnectionState::AuthenticationRejected
        );
        assert!(snapshot.daemon.is_none());
        assert!(snapshot.actor.is_none());
        assert!(snapshot.identity.is_none());
        assert!(snapshot.hestia_import.is_none());
        assert!(snapshot.session.is_none());
        assert!(snapshot.validate().is_ok());
    }

    #[test]
    fn connected_projection_never_contains_session_id_or_credential() {
        let snapshot = connected_snapshot(true);
        snapshot.validate().expect("projection should validate");
        let encoded = serde_json::to_string(&snapshot).unwrap();
        for forbidden in [
            "gwc_",
            "sessionId",
            "credential",
            "privateKey",
            "keyHandle",
            "providerHandle",
        ] {
            assert!(!encoded.contains(forbidden), "found {forbidden}");
        }
    }

    #[test]
    fn connected_projection_requires_exact_hestia_import_readiness() {
        let snapshot = connected_snapshot(true);
        let status = snapshot
            .hestia_import
            .as_ref()
            .expect("connected snapshot must include Hestia import status");
        assert_eq!(status.repository, "greenways-ai/hestia");
        assert_eq!(status.package, "@greenways/hestia-browser");
        assert_eq!(status.artifact_count, 12);
        assert_eq!(status.verification_scope, "compiled-lock");
        assert_eq!(status.admitted_room_projection_count, 0);
        assert!(!status.room_projections_admitted);

        let mut missing = connected_snapshot(true);
        missing.hestia_import = None;
        assert!(missing.validate().is_err());

        let mut changed = connected_snapshot(true);
        changed.hestia_import.as_mut().unwrap().protocol = "changed".to_owned();
        assert!(changed.validate().is_err());

        let mut changed = connected_snapshot(true);
        changed.hestia_import.as_mut().unwrap().repository = "other/hestia".to_owned();
        assert!(changed.validate().is_err());

        let mut changed = connected_snapshot(true);
        changed.hestia_import.as_mut().unwrap().package = "@other/hestia".to_owned();
        assert!(changed.validate().is_err());

        let mut changed = connected_snapshot(true);
        changed.hestia_import.as_mut().unwrap().revision = "0".repeat(40);
        assert!(changed.validate().is_err());

        let mut changed = connected_snapshot(true);
        changed
            .hestia_import
            .as_mut()
            .unwrap()
            .room_projections_admitted = true;
        assert!(changed.validate().is_err());
    }

    #[test]
    fn failed_and_inactive_snapshots_reject_hestia_import_metadata() {
        let import = HestiaImportStatus::from_compiled_lock().expect("compiled Hestia import");
        let mut disconnected = DesktopConnectionSnapshot::disconnected(1);
        disconnected.hestia_import = Some(import.clone());
        assert!(disconnected.validate().is_err());

        let mut failed = DesktopConnectionSnapshot::failed(
            DesktopBridgeError::DaemonUnavailable("Daemon unavailable.".to_owned()),
            1,
        );
        failed.hestia_import = Some(import);
        assert!(failed.validate().is_err());
    }

    #[test]
    fn decodes_only_the_closed_hestia_import_status() {
        let status = HestiaImportStatus::from_compiled_lock().expect("compiled Hestia import");
        let response = LocalResponse::ok(
            "local/request/hestia001",
            serde_json::to_value(&status).expect("status should encode"),
        );
        assert_eq!(decode_hestia_import_status(&response).unwrap(), status);

        let mut value = serde_json::to_value(&status).expect("status should encode");
        value
            .as_object_mut()
            .unwrap()
            .insert("artifactPaths".to_owned(), serde_json::json!([]));
        let changed = LocalResponse::ok("local/request/hestia002", value);
        assert!(decode_hestia_import_status(&changed).is_err());
    }

    #[test]
    fn nested_projection_protocols_and_error_state_are_closed() {
        let mut snapshot = connected_snapshot(true);
        snapshot.daemon.as_mut().unwrap().authority_mode = "browser".to_owned();
        assert!(snapshot.validate().is_err());

        let mut failure = DesktopConnectionSnapshot::failed(
            DesktopBridgeError::DaemonUnavailable("Daemon unavailable.".to_owned()),
            1,
        );
        failure.error.as_mut().unwrap().code = DesktopConnectionState::AuthenticationRejected;
        assert!(failure.validate().is_err());
    }

    #[test]
    fn secret_scanner_normalizes_key_separators_and_rejects_session_values() {
        assert!(scan_public_value(&serde_json::json!({
            "session_id": "redacted"
        }))
        .is_err());
        assert!(scan_public_value(&serde_json::json!({
            "message": "local/session/00112233445566778899aabbccddeeff"
        }))
        .is_err());
    }

    #[test]
    fn session_projection_accounts_for_authenticated_requests() {
        let session = LocalSession {
            protocol: LOCAL_SESSION_PROTOCOL.to_owned(),
            id: "local/session/00112233445566778899aabbccddeeff".to_owned(),
            client_id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
            role: LocalClientRole::Desktop,
            label: "Greenways Desktop".to_owned(),
            opened_at_unix_ms: 1,
            expires_at_unix_ms: 300_001,
            remaining_requests: 128,
        };
        assert_eq!(
            project_session(&session, 4).unwrap().remaining_requests,
            124
        );
    }

    #[test]
    fn wrong_role_is_never_projected_as_desktop() {
        let response = LocalResponse::ok(
            "local/request/00112233",
            serde_json::json!({
                "protocol": LOCAL_CLIENT_PROTOCOL,
                "id": "local/client/00112233445566778899aabbccddeeff",
                "role": "developer",
                "label": "Developer",
                "createdAtUnixMs": 1,
                "revokedAtUnixMs": null
            }),
        );
        assert!(
            decode_desktop_actor(&response, "local/client/00112233445566778899aabbccddeeff")
                .is_err()
        );
    }

    #[test]
    fn identity_unconfigured_is_a_connected_degraded_state() {
        let response = LocalResponse::error(
            "local/request/00112233",
            "identity-unconfigured",
            "Create an identity.",
        );
        assert_eq!(decode_public_identity(&response).unwrap(), None);
        assert!(connected_snapshot(false).validate().is_ok());
    }

    #[test]
    fn desktop_implements_the_reviewed_shared_connection_vocabulary() {
        let value: Value = serde_json::from_str(include_str!(
            "../../../protocol/fixtures/desktop-connection-states.json"
        ))
        .expect("vocabulary should decode");
        assert_eq!(
            value.get("protocol").and_then(Value::as_str),
            Some("greenways-connection-state-vocabulary/0-alpha")
        );
        let mut expected = value
            .get("shared")
            .and_then(Value::as_array)
            .expect("shared states")
            .iter()
            .chain(
                value
                    .get("desktopOnly")
                    .and_then(Value::as_array)
                    .expect("Desktop states")
                    .iter(),
            )
            .map(|value| value.as_str().expect("state string").to_owned())
            .collect::<Vec<_>>();
        expected.sort();
        let mut actual = [
            DesktopConnectionState::Connecting,
            DesktopConnectionState::Connected,
            DesktopConnectionState::DesktopBridgeUnavailable,
            DesktopConnectionState::DaemonUnavailable,
            DesktopConnectionState::CredentialUnavailable,
            DesktopConnectionState::AuthenticationRejected,
            DesktopConnectionState::SessionExpired,
            DesktopConnectionState::ProtocolMismatch,
            DesktopConnectionState::Disconnected,
        ]
        .into_iter()
        .map(|state| state.as_str().to_owned())
        .collect::<Vec<_>>();
        actual.sort();
        assert_eq!(actual, expected);
    }
}
