use greenways_authority::{
    read_credential_file, AuthorityError, LocalClient, LocalClientRole, LocalSession,
};
use greenways_local::{AuthenticatedLocalClient, LocalError};
use greenways_protocol::{new_request_id, DaemonStatus, LocalRequest, LocalResponse, Outcome};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    env,
    error::Error,
    fmt,
    io::{self, Read, Write},
    path::PathBuf,
};

pub const BROWSER_BRIDGE_PROTOCOL: &str = "greenways-browser-bridge/0-alpha";
pub const BROWSER_BRIDGE_RESULT_PROTOCOL: &str = "greenways-browser-bridge-result/0-alpha";
pub const BROWSER_BRIDGE_STATUS_PROTOCOL: &str = "greenways-browser-bridge-status/0-alpha";
pub const BROWSER_HOST_NAME: &str = "ai.greenways.browser_bridge";
pub const BROWSER_CLIENT_LABEL: &str = "Chrome browser bridge";
pub const BROWSER_HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const NATIVE_INPUT_LIMIT: usize = 4 * 1024 * 1024;
pub const NATIVE_OUTPUT_LIMIT: usize = 1024 * 1024;
const MAX_ERROR_BYTES: usize = 400;
const INVALID_REQUEST_ID: &str = "bridge/request/invalid0001";
const REQUEST_PREFIX: &str = "bridge/request/";
const MIN_REQUEST_SUFFIX_BYTES: usize = 8;
const MAX_REQUEST_SUFFIX_BYTES: usize = 160;

fn valid_request_id(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix(REQUEST_PREFIX) else {
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
        && value.chars().all(|character| !character.is_control())
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserBridgeCommand {
    Connect,
    Status,
    Disconnect,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BrowserBridgeRequest {
    pub protocol: String,
    #[serde(rename = "type")]
    pub request_type: String,
    pub id: String,
    pub command: BrowserBridgeCommand,
}

impl BrowserBridgeRequest {
    pub fn validate(&self) -> Result<(), BridgeFailure> {
        if self.protocol != BROWSER_BRIDGE_PROTOCOL
            || self.request_type != "request"
            || !valid_request_id(&self.id)
        {
            return Err(BridgeFailure::protocol_mismatch());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BrowserBridgeState {
    Connecting,
    Connected,
    DaemonUnavailable,
    CredentialUnavailable,
    AuthenticationRejected,
    SessionExpired,
    ProtocolMismatch,
    Disconnected,
}

impl BrowserBridgeState {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::DaemonUnavailable => "daemon-unavailable",
            Self::CredentialUnavailable => "credential-unavailable",
            Self::AuthenticationRejected => "authentication-rejected",
            Self::SessionExpired => "session-expired",
            Self::ProtocolMismatch => "protocol-mismatch",
            Self::Disconnected => "disconnected",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserBridgeErrorView {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserBridgeStatus {
    pub protocol: String,
    pub state: BrowserBridgeState,
    pub daemon: Option<Value>,
    pub actor: Option<Value>,
    pub identity: Option<Value>,
    pub session: Option<Value>,
    pub error: Option<BrowserBridgeErrorView>,
    pub observed_at_unix_ms: u64,
}

impl BrowserBridgeStatus {
    fn empty(
        state: BrowserBridgeState,
        error: Option<BrowserBridgeErrorView>,
        observed_at_unix_ms: u64,
    ) -> Self {
        Self {
            protocol: BROWSER_BRIDGE_STATUS_PROTOCOL.to_owned(),
            state,
            daemon: None,
            actor: None,
            identity: None,
            session: None,
            error,
            observed_at_unix_ms,
        }
    }

    fn connected(projection: BrowserProjection, observed_at_unix_ms: u64) -> Self {
        Self {
            protocol: BROWSER_BRIDGE_STATUS_PROTOCOL.to_owned(),
            state: BrowserBridgeState::Connected,
            daemon: Some(projection.daemon),
            actor: Some(projection.actor),
            identity: projection.identity,
            session: Some(projection.session),
            error: None,
            observed_at_unix_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserBridgeResponse {
    pub protocol: String,
    #[serde(rename = "type")]
    pub response_type: String,
    pub id: String,
    pub ok: bool,
    pub status: BrowserBridgeStatus,
    pub error: Option<BrowserBridgeErrorView>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BrowserProjection {
    pub daemon: Value,
    pub actor: Value,
    pub identity: Option<Value>,
    pub session: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeFailure {
    state: BrowserBridgeState,
    message: String,
}

impl BridgeFailure {
    pub fn new(state: BrowserBridgeState, message: impl Into<String>) -> Self {
        let message = message.into();
        let message = if valid_public_text(&message, MAX_ERROR_BYTES) {
            message
        } else {
            "The browser bridge could not complete the request.".to_owned()
        };
        Self { state, message }
    }

    pub fn protocol_mismatch() -> Self {
        Self::new(
            BrowserBridgeState::ProtocolMismatch,
            "Native bridge request is not supported.",
        )
    }

    fn view(&self) -> BrowserBridgeErrorView {
        BrowserBridgeErrorView {
            code: self.state.code().to_owned(),
            message: self.message.clone(),
        }
    }
}

impl fmt::Display for BridgeFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.state.code(), self.message)
    }
}

impl Error for BridgeFailure {}

pub trait BrowserConnection {
    fn snapshot(&mut self) -> Result<BrowserProjection, BridgeFailure>;
}

pub trait BrowserConnector {
    fn connect(&self) -> Result<Box<dyn BrowserConnection>, BridgeFailure>;
}

pub struct BrowserBridgeHost<C> {
    connector: C,
    connection: Option<Box<dyn BrowserConnection>>,
    status: BrowserBridgeStatus,
    now: fn() -> u64,
}

impl<C: BrowserConnector> BrowserBridgeHost<C> {
    pub fn new(connector: C) -> Self {
        Self::new_with_clock(connector, now_unix_ms)
    }

    pub fn new_with_clock(connector: C, now: fn() -> u64) -> Self {
        Self {
            connector,
            connection: None,
            status: BrowserBridgeStatus::empty(BrowserBridgeState::Disconnected, None, now()),
            now,
        }
    }

    pub fn snapshot(&self) -> BrowserBridgeStatus {
        self.status.clone()
    }

    fn set_failure(&mut self, failure: &BridgeFailure) -> BrowserBridgeStatus {
        self.connection = None;
        self.status = BrowserBridgeStatus::empty(failure.state, Some(failure.view()), (self.now)());
        self.snapshot()
    }

    fn connect(&mut self) -> BrowserBridgeStatus {
        self.connection = None;
        self.status =
            BrowserBridgeStatus::empty(BrowserBridgeState::Connecting, None, (self.now)());
        match self.connector.connect() {
            Ok(mut connection) => match connection.snapshot() {
                Ok(projection) => {
                    self.status = BrowserBridgeStatus::connected(projection, (self.now)());
                    self.connection = Some(connection);
                    self.snapshot()
                }
                Err(error) => self.set_failure(&error),
            },
            Err(error) => self.set_failure(&error),
        }
    }

    fn refresh(&mut self) -> BrowserBridgeStatus {
        let Some(connection) = self.connection.as_mut() else {
            return self.snapshot();
        };
        match connection.snapshot() {
            Ok(projection) => {
                self.status = BrowserBridgeStatus::connected(projection, (self.now)());
                self.snapshot()
            }
            Err(error) => self.set_failure(&error),
        }
    }

    fn disconnect(&mut self) -> BrowserBridgeStatus {
        self.connection = None;
        self.status =
            BrowserBridgeStatus::empty(BrowserBridgeState::Disconnected, None, (self.now)());
        self.snapshot()
    }

    pub fn handle_value(&mut self, value: Value) -> BrowserBridgeResponse {
        let candidate_id = value
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| valid_request_id(value))
            .unwrap_or(INVALID_REQUEST_ID)
            .to_owned();
        let request = serde_json::from_value::<BrowserBridgeRequest>(value)
            .map_err(|_| BridgeFailure::protocol_mismatch())
            .and_then(|request| {
                request.validate()?;
                Ok(request)
            });
        match request {
            Ok(request) => {
                let status = match request.command {
                    BrowserBridgeCommand::Connect => self.connect(),
                    BrowserBridgeCommand::Status => self.refresh(),
                    BrowserBridgeCommand::Disconnect => self.disconnect(),
                };
                BrowserBridgeResponse {
                    protocol: BROWSER_BRIDGE_RESULT_PROTOCOL.to_owned(),
                    response_type: "response".to_owned(),
                    id: request.id,
                    ok: true,
                    status,
                    error: None,
                }
            }
            Err(error) => BrowserBridgeResponse {
                protocol: BROWSER_BRIDGE_RESULT_PROTOCOL.to_owned(),
                response_type: "response".to_owned(),
                id: candidate_id,
                ok: false,
                status: self.set_failure(&error),
                error: Some(error.view()),
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct SystemBrowserConnector {
    socket_path: PathBuf,
    credential_path: PathBuf,
}

impl SystemBrowserConnector {
    pub fn resolve() -> Result<Self, BridgeFailure> {
        let home = env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
            BridgeFailure::new(
                BrowserBridgeState::CredentialUnavailable,
                "The browser bridge user home is unavailable.",
            )
        })?;
        let greenways_home = home.join(".greenways");
        Ok(Self {
            socket_path: greenways_home.join("run").join("greenwaysd.sock"),
            credential_path: greenways_home.join("clients").join("browser-bridge.json"),
        })
    }

    #[cfg(test)]
    fn from_paths(socket_path: PathBuf, credential_path: PathBuf) -> Self {
        Self {
            socket_path,
            credential_path,
        }
    }
}

impl BrowserConnector for SystemBrowserConnector {
    fn connect(&self) -> Result<Box<dyn BrowserConnection>, BridgeFailure> {
        let credential =
            read_credential_file(&self.credential_path).map_err(map_credential_error)?;
        if credential.role != LocalClientRole::BrowserBridge {
            return Err(BridgeFailure::new(
                BrowserBridgeState::AuthenticationRejected,
                "The configured credential is not an exact browser-bridge credential.",
            ));
        }
        drop(credential);
        let client = AuthenticatedLocalClient::connect(&self.socket_path, &self.credential_path)
            .map_err(map_local_error)?;
        if client.session().role != LocalClientRole::BrowserBridge
            || client.session().label != BROWSER_CLIENT_LABEL
        {
            return Err(BridgeFailure::new(
                BrowserBridgeState::AuthenticationRejected,
                "The daemon returned an invalid browser-bridge session.",
            ));
        }
        Ok(Box::new(SystemBrowserConnection {
            client,
            authenticated_requests: 0,
        }))
    }
}

struct SystemBrowserConnection {
    client: AuthenticatedLocalClient,
    authenticated_requests: u32,
}

impl BrowserConnection for SystemBrowserConnection {
    fn snapshot(&mut self) -> Result<BrowserProjection, BridgeFailure> {
        let daemon_response = self
            .client
            .send(&LocalRequest::status(
                new_request_id().map_err(map_protocol_error)?,
            ))
            .map_err(map_local_error)?;
        self.authenticated_requests = self.authenticated_requests.saturating_add(1);
        let daemon = project_daemon(response_value(daemon_response)?)?;

        let actor_response = self.client.whoami().map_err(map_local_error)?;
        self.authenticated_requests = self.authenticated_requests.saturating_add(1);
        let actor = project_actor(response_value(actor_response)?)?;

        let identity_response = self
            .client
            .identity_public_card()
            .map_err(map_local_error)?;
        self.authenticated_requests = self.authenticated_requests.saturating_add(1);
        let identity = if identity_response.outcome == Outcome::Error
            && identity_response
                .error
                .as_ref()
                .map(|error| error.code.as_str())
                == Some("identity-unconfigured")
        {
            None
        } else {
            Some(project_identity(response_value(identity_response)?)?)
        };

        let session = project_session(self.client.session(), self.authenticated_requests)?;
        Ok(BrowserProjection {
            daemon,
            actor,
            identity,
            session,
        })
    }
}

fn response_value(response: LocalResponse) -> Result<Value, BridgeFailure> {
    match response.outcome {
        Outcome::Ok => response.value.ok_or_else(BridgeFailure::protocol_mismatch),
        Outcome::Error => {
            let code = response.error.as_ref().map(|error| error.code.as_str());
            let failure = match code {
                Some("authentication-rejected") => BridgeFailure::new(
                    BrowserBridgeState::AuthenticationRejected,
                    "The browser bridge credential was rejected.",
                ),
                Some("session-expired" | "session-unavailable") => BridgeFailure::new(
                    BrowserBridgeState::SessionExpired,
                    "The browser bridge session expired.",
                ),
                _ => BridgeFailure::protocol_mismatch(),
            };
            Err(failure)
        }
    }
}

fn project_daemon(value: Value) -> Result<Value, BridgeFailure> {
    let status: DaemonStatus =
        serde_json::from_value(value).map_err(|_| BridgeFailure::protocol_mismatch())?;
    if !valid_public_text(&status.node_id, 160)
        || !valid_public_text(&status.daemon_version, 80)
        || !valid_public_text(&status.local_protocol, 120)
        || status.generation == 0
        || status.started_at_unix_ms == 0
        || status.observed_at_unix_ms == 0
        || !valid_public_text(&status.profile_mode, 80)
        || !valid_public_text(&status.authority_mode, 80)
    {
        return Err(BridgeFailure::protocol_mismatch());
    }
    Ok(json!({
        "protocol": status.protocol,
        "nodeId": status.node_id,
        "daemonVersion": status.daemon_version,
        "localProtocol": status.local_protocol,
        "generation": status.generation,
        "stateRevision": status.state_revision,
        "startedAtUnixMs": status.started_at_unix_ms,
        "observedAtUnixMs": status.observed_at_unix_ms,
        "profileMode": status.profile_mode,
        "authorityMode": status.authority_mode,
    }))
}

fn project_actor(value: Value) -> Result<Value, BridgeFailure> {
    let actor: LocalClient =
        serde_json::from_value(value).map_err(|_| BridgeFailure::protocol_mismatch())?;
    if actor.role != LocalClientRole::BrowserBridge
        || actor.label != BROWSER_CLIENT_LABEL
        || actor.revoked_at_unix_ms.is_some()
        || !valid_public_text(&actor.id, 160)
    {
        return Err(BridgeFailure::new(
            BrowserBridgeState::AuthenticationRejected,
            "The browser bridge client is unavailable.",
        ));
    }
    Ok(json!({
        "protocol": actor.protocol,
        "id": actor.id,
        "role": actor.role.as_str(),
        "label": actor.label,
        "createdAtUnixMs": actor.created_at_unix_ms,
        "revokedAtUnixMs": Value::Null,
    }))
}

fn project_identity(value: Value) -> Result<Value, BridgeFailure> {
    let subject = if value.get("protocol").and_then(Value::as_str)
        == Some("greenways-signed-profile-identity/0-alpha")
    {
        value.get("subject").cloned()
    } else {
        Some(value)
    }
    .ok_or_else(BridgeFailure::protocol_mismatch)?;
    let object = subject
        .as_object()
        .ok_or_else(BridgeFailure::protocol_mismatch)?;
    let protocol = required_text(object, "protocol", 120)?;
    let id = required_text(object, "id", 160)?;
    let handle = required_text(object, "handle", 80)?;
    let key_id = required_text(object, "keyId", 80)?;
    let algorithm = required_text(object, "algorithm", 80)?;
    let created_at_unix_ms = required_u64(object, "createdAtUnixMs")?;
    if protocol != "greenways-profile-identity/0-alpha" || !valid_digest(&key_id) {
        return Err(BridgeFailure::protocol_mismatch());
    }
    Ok(json!({
        "protocol": protocol,
        "id": id,
        "handle": handle,
        "keyId": key_id,
        "algorithm": algorithm,
        "createdAtUnixMs": created_at_unix_ms,
    }))
}

fn project_session(
    session: &LocalSession,
    authenticated_requests: u32,
) -> Result<Value, BridgeFailure> {
    if session.role != LocalClientRole::BrowserBridge
        || session.label != BROWSER_CLIENT_LABEL
        || !valid_public_text(&session.protocol, 120)
        || !valid_public_text(&session.client_id, 160)
        || session.opened_at_unix_ms == 0
        || session.expires_at_unix_ms <= session.opened_at_unix_ms
    {
        return Err(BridgeFailure::protocol_mismatch());
    }
    Ok(json!({
        "protocol": session.protocol,
        "clientId": session.client_id,
        "role": session.role.as_str(),
        "label": session.label,
        "openedAtUnixMs": session.opened_at_unix_ms,
        "expiresAtUnixMs": session.expires_at_unix_ms,
        "remainingRequests": session.remaining_requests.saturating_sub(authenticated_requests),
    }))
}

fn required_text(
    object: &Map<String, Value>,
    field: &str,
    maximum: usize,
) -> Result<String, BridgeFailure> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(BridgeFailure::protocol_mismatch)?;
    if !valid_public_text(value, maximum) {
        return Err(BridgeFailure::protocol_mismatch());
    }
    Ok(value.to_owned())
}

fn required_u64(object: &Map<String, Value>, field: &str) -> Result<u64, BridgeFailure> {
    object
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(BridgeFailure::protocol_mismatch)
}

fn map_credential_error(error: AuthorityError) -> BridgeFailure {
    match error {
        AuthorityError::Io(_) | AuthorityError::NotFound(_) => BridgeFailure::new(
            BrowserBridgeState::CredentialUnavailable,
            "The browser bridge credential file is unavailable.",
        ),
        _ => BridgeFailure::new(
            BrowserBridgeState::AuthenticationRejected,
            "The configured credential is not an exact browser-bridge credential.",
        ),
    }
}

fn map_local_error(error: LocalError) -> BridgeFailure {
    match error {
        LocalError::Io(_) => BridgeFailure::new(
            BrowserBridgeState::DaemonUnavailable,
            "The local daemon socket is unavailable.",
        ),
        LocalError::Authority(error) => map_credential_error(error),
        LocalError::AuthenticationRejected | LocalError::SessionMismatch => BridgeFailure::new(
            BrowserBridgeState::AuthenticationRejected,
            "The browser bridge credential was rejected.",
        ),
        LocalError::MissingHome => BridgeFailure::new(
            BrowserBridgeState::CredentialUnavailable,
            "The browser bridge user home is unavailable.",
        ),
        LocalError::Protocol(_)
        | LocalError::Encoding(_)
        | LocalError::ResponseMismatch
        | LocalError::UnsupportedPlatform => BridgeFailure::protocol_mismatch(),
    }
}

fn map_protocol_error(_: greenways_protocol::ProtocolError) -> BridgeFailure {
    BridgeFailure::protocol_mismatch()
}

pub fn read_native_message<R: Read>(reader: &mut R) -> io::Result<Option<Value>> {
    let mut header = [0_u8; 4];
    let mut read = 0;
    while read < header.len() {
        let count = reader.read(&mut header[read..])?;
        if count == 0 {
            if read == 0 {
                return Ok(None);
            }
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "native message header is incomplete",
            ));
        }
        read += count;
    }
    let length = u32::from_ne_bytes(header) as usize;
    if length > NATIVE_INPUT_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native message exceeds the configured limit",
        ));
    }
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body).map(Some).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "native message contains invalid JSON",
        )
    })
}

pub fn write_native_message<W: Write, T: Serialize>(writer: &mut W, value: &T) -> io::Result<()> {
    let body = serde_json::to_vec(value).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "native host output is not valid JSON",
        )
    })?;
    if body.len() > NATIVE_OUTPUT_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "native host output exceeds Chrome's limit",
        ));
    }
    let length = u32::try_from(body.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "native host output is too large",
        )
    })?;
    writer.write_all(&length.to_ne_bytes())?;
    writer.write_all(&body)?;
    writer.flush()
}

pub fn protocol_error_response(observed_at_unix_ms: u64) -> BrowserBridgeResponse {
    let error = BridgeFailure::protocol_mismatch();
    BrowserBridgeResponse {
        protocol: BROWSER_BRIDGE_RESULT_PROTOCOL.to_owned(),
        response_type: "response".to_owned(),
        id: INVALID_REQUEST_ID.to_owned(),
        ok: false,
        status: BrowserBridgeStatus::empty(error.state, Some(error.view()), observed_at_unix_ms),
        error: Some(error.view()),
    }
}

pub fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(1)
}

pub fn run_native_host<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
) -> Result<(), Box<dyn Error>> {
    let connector = SystemBrowserConnector::resolve()?;
    let mut host = BrowserBridgeHost::new(connector);
    loop {
        match read_native_message(reader) {
            Ok(Some(value)) => write_native_message(writer, &host.handle_value(value))?,
            Ok(None) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::InvalidData => {
                write_native_message(writer, &protocol_error_response(now_unix_ms()))?;
                return Ok(());
            }
            Err(error) => return Err(Box::new(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::RefCell, rc::Rc};

    fn fixed_now() -> u64 {
        1_786_500_001_000
    }

    fn request(command: &str) -> Value {
        json!({
            "protocol": BROWSER_BRIDGE_PROTOCOL,
            "type": "request",
            "id": format!("bridge/request/{command}00000001"),
            "command": command,
        })
    }

    #[derive(Clone)]
    struct FakeConnector {
        snapshots: Rc<RefCell<Vec<Result<BrowserProjection, BridgeFailure>>>>,
    }

    impl BrowserConnector for FakeConnector {
        fn connect(&self) -> Result<Box<dyn BrowserConnection>, BridgeFailure> {
            Ok(Box::new(FakeConnection {
                snapshots: Rc::clone(&self.snapshots),
            }))
        }
    }

    struct FakeConnection {
        snapshots: Rc<RefCell<Vec<Result<BrowserProjection, BridgeFailure>>>>,
    }

    impl BrowserConnection for FakeConnection {
        fn snapshot(&mut self) -> Result<BrowserProjection, BridgeFailure> {
            self.snapshots.borrow_mut().remove(0)
        }
    }

    fn projection() -> BrowserProjection {
        BrowserProjection {
            daemon: json!({"protocol": "greenways-daemon-status/0-alpha", "nodeId": "node/test"}),
            actor: json!({"protocol": "greenways-local-client/0-alpha", "role": "browser-bridge"}),
            identity: None,
            session: json!({"protocol": "greenways-local-session/0-alpha", "role": "browser-bridge"}),
        }
    }

    #[test]
    fn accepts_only_the_three_closed_commands() {
        let connector = FakeConnector {
            snapshots: Rc::new(RefCell::new(vec![Ok(projection())])),
        };
        let mut host = BrowserBridgeHost::new_with_clock(connector, fixed_now);
        let connected = host.handle_value(request("connect"));
        assert!(connected.ok);
        assert_eq!(connected.status.state, BrowserBridgeState::Connected);

        let invalid = host.handle_value(json!({
            "protocol": BROWSER_BRIDGE_PROTOCOL,
            "type": "request",
            "id": "bridge/request/invoke00000001",
            "command": "invoke",
        }));
        assert!(!invalid.ok);
        assert_eq!(invalid.status.state, BrowserBridgeState::ProtocolMismatch);

        let extra = host.handle_value(json!({
            "protocol": BROWSER_BRIDGE_PROTOCOL,
            "type": "request",
            "id": "bridge/request/status00000001",
            "command": "status",
            "extra": true,
        }));
        assert!(!extra.ok);
    }

    #[test]
    fn connects_refreshes_and_disconnects_without_bearer_authority() {
        let connector = FakeConnector {
            snapshots: Rc::new(RefCell::new(vec![Ok(projection()), Ok(projection())])),
        };
        let mut host = BrowserBridgeHost::new_with_clock(connector, fixed_now);
        assert!(host.handle_value(request("connect")).ok);
        assert!(host.handle_value(request("status")).ok);
        let disconnected = host.handle_value(request("disconnect"));
        assert_eq!(disconnected.status.state, BrowserBridgeState::Disconnected);
        let encoded = serde_json::to_string(&disconnected).expect("response");
        assert!(!encoded.contains("gwc_"));
        assert!(!encoded.contains("local/session/"));
        assert!(!encoded.contains("token"));
    }

    #[test]
    fn native_framing_handles_adjacent_messages() {
        let first = serde_json::to_vec(&json!({"one": 1})).expect("first");
        let second = serde_json::to_vec(&json!({"two": 2})).expect("second");
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(first.len() as u32).to_ne_bytes());
        bytes.extend_from_slice(&first);
        bytes.extend_from_slice(&(second.len() as u32).to_ne_bytes());
        bytes.extend_from_slice(&second);
        let mut cursor = std::io::Cursor::new(bytes);
        assert_eq!(
            read_native_message(&mut cursor).expect("first"),
            Some(json!({"one": 1}))
        );
        assert_eq!(
            read_native_message(&mut cursor).expect("second"),
            Some(json!({"two": 2}))
        );
        assert_eq!(read_native_message(&mut cursor).expect("eof"), None);
    }

    #[test]
    fn invalid_native_frame_returns_one_bounded_error_then_terminates() {
        let mut input = std::io::Cursor::new(
            u32::try_from(NATIVE_INPUT_LIMIT + 1)
                .expect("native input limit")
                .to_ne_bytes()
                .to_vec(),
        );
        let mut output = Vec::new();
        run_native_host(&mut input, &mut output).expect("bounded invalid frame response");

        let mut output = std::io::Cursor::new(output);
        let response = read_native_message(&mut output)
            .expect("response frame")
            .expect("response");
        assert_eq!(response["ok"], false);
        assert_eq!(response["status"]["state"], "protocol-mismatch");
        assert_eq!(
            read_native_message(&mut output).expect("response eof"),
            None
        );
    }

    #[test]
    fn system_connector_paths_are_fixed() {
        let connector = SystemBrowserConnector::from_paths(
            PathBuf::from("/fixed/run/greenwaysd.sock"),
            PathBuf::from("/fixed/clients/browser-bridge.json"),
        );
        assert!(connector.socket_path.ends_with("greenwaysd.sock"));
        assert!(connector.credential_path.ends_with("browser-bridge.json"));
    }
}
