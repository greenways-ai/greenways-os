mod provider;

use greenways_authority::{
    new_local_session, parse_local_client_credential_arguments, valid_client_id, AuthorityError,
    LocalClient, LocalClientRegistry, LocalClientRole, LocalSession,
};
use greenways_identity::{IdentityError, ProfileIdentityVault};
use greenways_local::GreenwaysPaths;
use greenways_protocol::{
    canonical_request, decode_request, encode_response_line, new_node_id, request_digest,
    validate_digest, validate_node_id, validate_response, DaemonPaths, DaemonStatus, LocalRequest,
    LocalResponse, ProtocolError, MAX_REQUEST_BYTES,
};
use greenways_vault::{ProviderVault, VaultError};
use provider::{
    role_may_invoke_provider, trim_receipts_to_fit, validate_provider_claim,
    ProviderInvocationClaim, MAX_PROVIDER_INVOCATION_CLAIMS,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{SystemTime, UNIX_EPOCH},
};

const STATE_PROTOCOL: &str = "greenways-daemon-state/0-alpha";
const RECEIPT_PROTOCOL: &str = "greenways-local-receipt/0-alpha";
const MAX_STATE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RECEIPTS: usize = 64;
const INVALID_REQUEST_ID: &str = "local/request/invalid0";
const SESSION_TTL_MS: u64 = 5 * 60 * 1000;
const SESSION_REQUEST_LIMIT: u32 = 128;
const MAX_CONCURRENT_CONNECTIONS: usize = 32;

#[derive(Debug)]
pub enum DaemonError {
    Io(io::Error),
    Protocol(ProtocolError),
    Authority(AuthorityError),
    Identity(IdentityError),
    Vault(VaultError),
    State(String),
    AlreadyRunning(PathBuf),
    UnsupportedPlatform,
}

impl fmt::Display for DaemonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Greenways daemon I/O failed: {error}"),
            Self::Protocol(error) => write!(formatter, "Greenways daemon protocol failed: {error}"),
            Self::Authority(error) => {
                write!(formatter, "Greenways daemon authority failed: {error}")
            }
            Self::Identity(error) => {
                write!(formatter, "Greenways daemon identity failed: {error}")
            }
            Self::Vault(error) => write!(formatter, "Greenways daemon vault failed: {error}"),
            Self::State(message) => {
                write!(formatter, "Greenways daemon state is invalid: {message}")
            }
            Self::AlreadyRunning(path) => {
                write!(
                    formatter,
                    "Greenways daemon is already listening at {}",
                    path.display()
                )
            }
            Self::UnsupportedPlatform => {
                write!(
                    formatter,
                    "Greenways daemon local IPC is not implemented on this platform"
                )
            }
        }
    }
}

impl Error for DaemonError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Protocol(error) => Some(error),
            Self::Authority(error) => Some(error),
            Self::Identity(error) => Some(error),
            Self::Vault(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for DaemonError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<ProtocolError> for DaemonError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}

impl From<AuthorityError> for DaemonError {
    fn from(value: AuthorityError) -> Self {
        Self::Authority(value)
    }
}

impl From<IdentityError> for DaemonError {
    fn from(value: IdentityError) -> Self {
        Self::Identity(value)
    }
}

impl From<VaultError> for DaemonError {
    fn from(value: VaultError) -> Self {
        Self::Vault(value)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestActor {
    client_id: String,
    role: LocalClientRole,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestReceipt {
    protocol: String,
    request_id: String,
    digest: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    actor: Option<RequestActor>,
    request: String,
    response: LocalResponse,
    committed_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DaemonState {
    protocol: String,
    node_id: String,
    generation: u64,
    created_at_unix_ms: u64,
    last_started_at_unix_ms: u64,
    revision: u64,
    receipts: Vec<RequestReceipt>,
    #[serde(default)]
    provider_invocations: Vec<ProviderInvocationClaim>,
}

#[derive(Debug)]
pub struct Daemon {
    paths: GreenwaysPaths,
    state: DaemonState,
    clients: LocalClientRegistry,
    identity: ProfileIdentityVault,
    vault: ProviderVault,
}

impl Daemon {
    pub fn open(paths: GreenwaysPaths) -> Result<Self, DaemonError> {
        Self::open_at(paths, now_unix_ms()?)
    }

    fn open_at(paths: GreenwaysPaths, observed_at_unix_ms: u64) -> Result<Self, DaemonError> {
        ensure_private_dir(&paths.home)?;
        let clients =
            LocalClientRegistry::open(paths.home.join("state").join("local-clients.json"))?;
        let identity = ProfileIdentityVault::open_system(
            paths.home.join("state").join("profile-identity.json"),
        )?;
        let vault = ProviderVault::open_system(paths.home.join("state").join("providers.json"))?;
        let mut state = if paths.state_file.exists() {
            load_state(&paths.state_file)?
        } else {
            DaemonState {
                protocol: STATE_PROTOCOL.to_owned(),
                node_id: new_node_id()?,
                generation: 0,
                created_at_unix_ms: observed_at_unix_ms,
                last_started_at_unix_ms: observed_at_unix_ms,
                revision: 0,
                receipts: Vec::new(),
                provider_invocations: Vec::new(),
            }
        };
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| DaemonError::State("generation overflowed".to_owned()))?;
        state.last_started_at_unix_ms = observed_at_unix_ms;
        validate_state(&state)?;
        write_state(&paths.state_file, &state)?;
        Ok(Self {
            paths,
            state,
            clients,
            identity,
            vault,
        })
    }

    pub fn handle_request(&mut self, request: LocalRequest) -> Result<LocalResponse, DaemonError> {
        self.handle_request_at(request, now_unix_ms()?)
    }

    fn handle_request_at(
        &mut self,
        request: LocalRequest,
        observed_at_unix_ms: u64,
    ) -> Result<LocalResponse, DaemonError> {
        self.handle_request_as_at(request, None, observed_at_unix_ms)
    }

    fn handle_request_as_at(
        &mut self,
        request: LocalRequest,
        actor: Option<RequestActor>,
        observed_at_unix_ms: u64,
    ) -> Result<LocalResponse, DaemonError> {
        greenways_protocol::validate_request(&request)?;
        if request.operation == "client.session.open" {
            return Ok(LocalResponse::error(
                request.request_id,
                "unsupported-operation",
                "Session establishment is a connection-level operation.",
            ));
        }
        if requires_authenticated_session(&request.operation) && actor.is_none() {
            return Ok(LocalResponse::error(
                request.request_id,
                "authentication-required",
                "This Greenways local operation requires an authenticated session.",
            ));
        }
        if request.operation == "authority.clients.list"
            && actor
                .as_ref()
                .is_some_and(|actor| !role_may_list_clients(actor.role))
        {
            return Ok(LocalResponse::error(
                request.request_id,
                "authority-denied",
                "This local client role cannot inspect Greenways authority state.",
            ));
        }
        if request.operation == "vault.status"
            && actor
                .as_ref()
                .is_some_and(|actor| !role_may_read_vault_status(actor.role))
        {
            return Ok(LocalResponse::error(
                request.request_id,
                "authority-denied",
                "This local client role cannot inspect Greenways vault status.",
            ));
        }
        if request.operation == "provider.invoke" {
            let actor = actor.ok_or_else(|| {
                DaemonError::State("authenticated provider request has no actor".to_owned())
            })?;
            if !role_may_invoke_provider(actor.role) {
                return Ok(LocalResponse::error(
                    request.request_id,
                    "authority-denied",
                    "This local client role cannot invoke daemon provider credentials.",
                ));
            }
            return self.handle_provider_invocation_at(request, actor, observed_at_unix_ms);
        }

        let digest = request_digest(&request)?;
        if let Some(receipt) = self
            .state
            .receipts
            .iter()
            .find(|receipt| receipt.request_id == request.request_id)
        {
            if receipt.digest != digest || receipt.actor != actor {
                return Ok(LocalResponse::error(
                    request.request_id,
                    "request-id-collision",
                    "Greenways local request ID was reused with different content.",
                ));
            }
            return Ok(receipt.response.clone());
        }

        let next_revision = self
            .state
            .revision
            .checked_add(1)
            .ok_or_else(|| DaemonError::State("revision overflowed".to_owned()))?;
        let response = match request.operation.as_str() {
            "status" => {
                let status = DaemonStatus {
                    protocol: greenways_protocol::DAEMON_STATUS_PROTOCOL.to_owned(),
                    node_id: self.state.node_id.clone(),
                    daemon_version: env!("CARGO_PKG_VERSION").to_owned(),
                    local_protocol: greenways_protocol::LOCAL_PROTOCOL.to_owned(),
                    generation: self.state.generation,
                    state_revision: next_revision,
                    process_id: process::id(),
                    started_at_unix_ms: self.state.last_started_at_unix_ms,
                    observed_at_unix_ms,
                    profile_mode: match (
                        self.identity.public_identity().is_some(),
                        self.vault.status().provider_profile_count > 0,
                        self.clients.active_client_count() > 0,
                    ) {
                        (false, false, false) => "unconfigured",
                        (false, true, false) => "provider-configured",
                        (false, false, true) => "local-clients-configured",
                        (false, true, true) => "configured",
                        (true, false, false) => "identity-configured",
                        (true, _, _) => "configured",
                    }
                    .to_owned(),
                    authority_mode: "daemon".to_owned(),
                };
                LocalResponse::ok(
                    request.request_id.clone(),
                    serde_json::to_value(status).map_err(|_| {
                        DaemonError::State("status projection could not be encoded".to_owned())
                    })?,
                )
            }
            "vault.status" => LocalResponse::ok(
                request.request_id.clone(),
                serde_json::to_value(self.vault.status()).map_err(|_| {
                    DaemonError::State("vault status projection could not be encoded".to_owned())
                })?,
            ),
            "identity.status" => LocalResponse::ok(
                request.request_id.clone(),
                serde_json::to_value(self.identity.status()).map_err(|_| {
                    DaemonError::State("identity status projection could not be encoded".to_owned())
                })?,
            ),
            "identity.public-card" => match self.identity.public_identity() {
                Some(identity) => LocalResponse::ok(
                    request.request_id.clone(),
                    serde_json::to_value(identity).map_err(|_| {
                        DaemonError::State("public identity card could not be encoded".to_owned())
                    })?,
                ),
                None => LocalResponse::error(
                    request.request_id.clone(),
                    "identity-unconfigured",
                    "Create a Greenways profile identity before requesting its public card.",
                ),
            },
            "client.whoami" => {
                let actor = actor.as_ref().ok_or_else(|| {
                    DaemonError::State("authenticated actor disappeared".to_owned())
                })?;
                let client = self.clients.get(&actor.client_id)?;
                LocalResponse::ok(
                    request.request_id.clone(),
                    serde_json::to_value(client).map_err(|_| {
                        DaemonError::State(
                            "local client projection could not be encoded".to_owned(),
                        )
                    })?,
                )
            }
            "authority.clients.list" => LocalResponse::ok(
                request.request_id.clone(),
                serde_json::to_value(self.clients.clients()).map_err(|_| {
                    DaemonError::State("local client list could not be encoded".to_owned())
                })?,
            ),
            "paths" => {
                let paths = DaemonPaths {
                    protocol: greenways_protocol::DAEMON_PATHS_PROTOCOL.to_owned(),
                    home: path_string(&self.paths.home)?,
                    state_file: path_string(&self.paths.state_file)?,
                    socket_file: path_string(&self.paths.socket_file)?,
                };
                LocalResponse::ok(
                    request.request_id.clone(),
                    serde_json::to_value(paths).map_err(|_| {
                        DaemonError::State("path projection could not be encoded".to_owned())
                    })?,
                )
            }
            _ => {
                return Ok(LocalResponse::error(
                    request.request_id,
                    "unsupported-operation",
                    "Greenways local operation is not available.",
                ));
            }
        };

        let canonical = canonical_request(&request)?;
        let request_text = String::from_utf8(canonical)
            .map_err(|_| DaemonError::State("canonical request was not UTF-8".to_owned()))?;
        let receipt = RequestReceipt {
            protocol: RECEIPT_PROTOCOL.to_owned(),
            request_id: request.request_id,
            digest,
            actor,
            request: request_text,
            response: response.clone(),
            committed_at_unix_ms: observed_at_unix_ms,
        };
        self.commit_receipt(receipt, next_revision)?;
        Ok(response)
    }

    fn commit_receipt(
        &mut self,
        receipt: RequestReceipt,
        next_revision: u64,
    ) -> Result<(), DaemonError> {
        let previous = self.state.clone();
        self.state.revision = next_revision;
        self.state.receipts.push(receipt);
        if let Err(error) = trim_receipts_to_fit(&mut self.state) {
            self.state = previous;
            return Err(error);
        }
        if let Err(error) = write_state(&self.paths.state_file, &self.state) {
            self.state = previous;
            return Err(error);
        }
        Ok(())
    }
}

pub fn serve(paths: GreenwaysPaths, once: bool) -> Result<(), DaemonError> {
    #[cfg(unix)]
    {
        serve_unix(paths, once)
    }
    #[cfg(not(unix))]
    {
        let _ = (paths, once);
        Err(DaemonError::UnsupportedPlatform)
    }
}

#[cfg(unix)]
fn serve_unix(paths: GreenwaysPaths, once: bool) -> Result<(), DaemonError> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};

    let run_dir = paths
        .socket_file
        .parent()
        .ok_or_else(|| DaemonError::State("socket path has no parent".to_owned()))?;
    ensure_private_dir(run_dir)?;
    if paths.socket_file.exists() {
        match UnixStream::connect(&paths.socket_file) {
            Ok(_) => return Err(DaemonError::AlreadyRunning(paths.socket_file)),
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                ) =>
            {
                fs::remove_file(&paths.socket_file)?;
            }
            Err(error) => return Err(DaemonError::Io(error)),
        }
    }

    let listener = UnixListener::bind(&paths.socket_file)?;
    fs::set_permissions(&paths.socket_file, fs::Permissions::from_mode(0o600))?;
    let _socket_guard = SocketGuard(paths.socket_file.clone());
    let daemon = Arc::new(Mutex::new(Daemon::open(paths)?));
    let active = Arc::new(AtomicUsize::new(0));

    for incoming in listener.incoming() {
        match incoming {
            Ok(mut stream) if once => {
                if let Err(error) = handle_connection(&mut stream, Arc::clone(&daemon)) {
                    eprintln!("greenwaysd: contained local connection failure: {error}");
                }
                break;
            }
            Ok(mut stream) => {
                let previous = active.fetch_add(1, Ordering::AcqRel);
                if previous >= MAX_CONCURRENT_CONNECTIONS {
                    active.fetch_sub(1, Ordering::AcqRel);
                    continue;
                }
                let daemon = Arc::clone(&daemon);
                let active = Arc::clone(&active);
                thread::spawn(move || {
                    let _connection_guard = ConnectionGuard(active);
                    if let Err(error) = handle_connection(&mut stream, daemon) {
                        eprintln!("greenwaysd: contained local connection failure: {error}");
                    }
                });
            }
            Err(error) => return Err(DaemonError::Io(error)),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn handle_connection(
    stream: &mut std::os::unix::net::UnixStream,
    daemon: Arc<Mutex<Daemon>>,
) -> Result<(), DaemonError> {
    use std::net::Shutdown;

    let mut reader = BufReader::new(stream.try_clone()?);
    let mut session: Option<ConnectionSession> = None;
    loop {
        let mut bytes = match read_request_line(&mut reader)? {
            ReadRequest::Eof => break,
            ReadRequest::TooLarge => {
                write_response(
                    stream,
                    &LocalResponse::error(
                        INVALID_REQUEST_ID,
                        "request-too-large",
                        "Greenways local requests are limited to 64 KiB.",
                    ),
                )?;
                break;
            }
            ReadRequest::Bytes(bytes) => bytes,
        };
        let decoded = decode_request(&bytes);
        bytes.fill(0);
        let request = match decoded {
            Ok(request) => request,
            Err(error) => {
                write_response(
                    stream,
                    &LocalResponse::error(INVALID_REQUEST_ID, error.code(), error.message()),
                )?;
                break;
            }
        };

        if request.operation == "client.session.open" {
            if session.is_some() {
                write_response(
                    stream,
                    &LocalResponse::error(
                        request.request_id,
                        "already-authenticated",
                        "This Greenways local connection already has a session.",
                    ),
                )?;
                break;
            }
            let observed_at = now_unix_ms()?;
            let request_id = request.request_id;
            match open_connection_session(&daemon, &request_id, request.arguments, observed_at) {
                Ok(opened) => {
                    let response = LocalResponse::ok(
                        request_id,
                        serde_json::to_value(&opened.session).map_err(|_| {
                            DaemonError::State("local session could not be encoded".to_owned())
                        })?,
                    );
                    write_response(stream, &response)?;
                    session = Some(opened);
                }
                Err(response) => {
                    write_response(stream, &response)?;
                    break;
                }
            }
            continue;
        }

        let observed_at = now_unix_ms()?;
        let actor = if let Some(opened) = session.as_mut() {
            match opened.authorize_at(observed_at) {
                Ok(actor) => Some(actor),
                Err(code) => {
                    write_response(
                        stream,
                        &LocalResponse::error(
                            request.request_id,
                            code,
                            "The Greenways local session is no longer usable.",
                        ),
                    )?;
                    break;
                }
            }
        } else if requires_authenticated_session(&request.operation) {
            write_response(
                stream,
                &LocalResponse::error(
                    request.request_id,
                    "authentication-required",
                    "This Greenways local operation requires an authenticated session.",
                ),
            )?;
            break;
        } else {
            None
        };

        let request_id = request.request_id.clone();
        let response = match daemon.lock() {
            Ok(mut daemon) => daemon.handle_request_as_at(request, actor, observed_at),
            Err(_) => Err(DaemonError::State(
                "daemon authority lock was poisoned".to_owned(),
            )),
        }
        .unwrap_or_else(|_| {
            LocalResponse::error(
                request_id,
                "daemon-unavailable",
                "Greenways daemon could not safely complete the request.",
            )
        });
        write_response(stream, &response)?;
    }
    stream.shutdown(Shutdown::Write)?;
    Ok(())
}

#[cfg(unix)]
fn write_response(
    stream: &mut std::os::unix::net::UnixStream,
    response: &LocalResponse,
) -> Result<(), DaemonError> {
    stream.write_all(&encode_response_line(response)?)?;
    stream.flush()?;
    Ok(())
}

#[cfg(unix)]
enum ReadRequest {
    Eof,
    TooLarge,
    Bytes(Vec<u8>),
}

#[cfg(unix)]
fn read_request_line(
    reader: &mut BufReader<std::os::unix::net::UnixStream>,
) -> Result<ReadRequest, DaemonError> {
    let mut bytes = Vec::new();
    let read = reader
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if read == 0 {
        return Ok(ReadRequest::Eof);
    }
    if bytes.len() > MAX_REQUEST_BYTES || !bytes.ends_with(b"\n") {
        return Ok(ReadRequest::TooLarge);
    }
    Ok(ReadRequest::Bytes(bytes))
}

struct ConnectionSession {
    session: LocalSession,
}

impl ConnectionSession {
    fn open(client: &LocalClient, observed_at_unix_ms: u64) -> Result<Self, AuthorityError> {
        Ok(Self {
            session: new_local_session(
                client,
                observed_at_unix_ms,
                SESSION_TTL_MS,
                SESSION_REQUEST_LIMIT,
            )?,
        })
    }

    fn authorize_at(&mut self, observed_at_unix_ms: u64) -> Result<RequestActor, &'static str> {
        if observed_at_unix_ms >= self.session.expires_at_unix_ms {
            return Err("session-expired");
        }
        if self.session.remaining_requests == 0 {
            return Err("session-exhausted");
        }
        self.session.remaining_requests -= 1;
        Ok(RequestActor {
            client_id: self.session.client_id.clone(),
            role: self.session.role,
        })
    }
}

fn open_connection_session(
    daemon: &Arc<Mutex<Daemon>>,
    request_id: &str,
    arguments: serde_json::Map<String, serde_json::Value>,
    observed_at_unix_ms: u64,
) -> Result<ConnectionSession, LocalResponse> {
    let credential = parse_local_client_credential_arguments(arguments).map_err(|_| {
        LocalResponse::error(
            request_id,
            "authentication-rejected",
            "The Greenways local client credential was rejected.",
        )
    })?;
    let client = daemon
        .lock()
        .map_err(|_| {
            LocalResponse::error(
                request_id,
                "daemon-unavailable",
                "Greenways daemon could not safely authenticate the client.",
            )
        })?
        .clients
        .verify_credential(&credential)
        .map_err(|_| {
            LocalResponse::error(
                request_id,
                "authentication-rejected",
                "The Greenways local client credential was rejected.",
            )
        })?;
    ConnectionSession::open(&client, observed_at_unix_ms).map_err(|_| {
        LocalResponse::error(
            request_id,
            "authentication-rejected",
            "The Greenways local client credential was rejected.",
        )
    })
}

fn requires_authenticated_session(operation: &str) -> bool {
    matches!(
        operation,
        "client.whoami"
            | "authority.clients.list"
            | "provider.invoke"
            | "identity.status"
            | "identity.public-card"
            | "vault.status"
    )
}

fn role_may_list_clients(role: LocalClientRole) -> bool {
    matches!(
        role,
        LocalClientRole::Desktop | LocalClientRole::Cli | LocalClientRole::Developer
    )
}

fn role_may_read_vault_status(role: LocalClientRole) -> bool {
    matches!(
        role,
        LocalClientRole::Desktop | LocalClientRole::Cli | LocalClientRole::Developer
    )
}

struct ConnectionGuard(Arc<AtomicUsize>);

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn load_state(path: &Path) -> Result<DaemonState, DaemonError> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err(DaemonError::State(
            "state file exceeds its durable size limit".to_owned(),
        ));
    }
    let state: DaemonState = serde_json::from_slice(&bytes)
        .map_err(|_| DaemonError::State("state file is not closed JSON".to_owned()))?;
    validate_state(&state)?;
    Ok(state)
}

fn validate_state(state: &DaemonState) -> Result<(), DaemonError> {
    if state.protocol != STATE_PROTOCOL {
        return Err(DaemonError::State(
            "state protocol is unsupported".to_owned(),
        ));
    }
    if !validate_node_id(&state.node_id) {
        return Err(DaemonError::State("node identity is invalid".to_owned()));
    }
    if state.generation == 0 {
        return Err(DaemonError::State("generation must be positive".to_owned()));
    }
    if state.created_at_unix_ms == 0 || state.last_started_at_unix_ms < state.created_at_unix_ms {
        return Err(DaemonError::State(
            "state timestamps are invalid".to_owned(),
        ));
    }
    if state.receipts.len() > MAX_RECEIPTS {
        return Err(DaemonError::State(
            "receipt history is unbounded".to_owned(),
        ));
    }
    if state.provider_invocations.len() > MAX_PROVIDER_INVOCATION_CLAIMS {
        return Err(DaemonError::State(
            "provider invocation claim history is unbounded".to_owned(),
        ));
    }

    let mut request_ids = HashSet::new();
    for receipt in &state.receipts {
        if receipt.protocol != RECEIPT_PROTOCOL {
            return Err(DaemonError::State(
                "receipt protocol is unsupported".to_owned(),
            ));
        }
        if !request_ids.insert(receipt.request_id.clone()) {
            return Err(DaemonError::State(
                "receipt request IDs are not unique".to_owned(),
            ));
        }
        if !validate_digest(&receipt.digest) {
            return Err(DaemonError::State("receipt digest is invalid".to_owned()));
        }
        let request = decode_request(receipt.request.as_bytes())?;
        if request.operation == "client.session.open" {
            return Err(DaemonError::State(
                "session credentials cannot appear in durable receipts".to_owned(),
            ));
        }
        if receipt
            .actor
            .as_ref()
            .is_some_and(|actor| !valid_client_id(&actor.client_id))
        {
            return Err(DaemonError::State("receipt actor is invalid".to_owned()));
        }
        if request.request_id != receipt.request_id
            || request_digest(&request)? != receipt.digest
            || receipt.response.request_id != receipt.request_id
        {
            return Err(DaemonError::State(
                "receipt identity does not match its exact request".to_owned(),
            ));
        }
        validate_response(&receipt.response)?;
        if receipt.committed_at_unix_ms < state.created_at_unix_ms {
            return Err(DaemonError::State(
                "receipt timestamp predates daemon state".to_owned(),
            ));
        }
    }
    for claim in &state.provider_invocations {
        if !request_ids.insert(claim.request_id.clone()) {
            return Err(DaemonError::State(
                "provider invocation request ID is not unique".to_owned(),
            ));
        }
        validate_provider_claim(claim, state.created_at_unix_ms)?;
    }
    Ok(())
}

fn write_state(path: &Path, state: &DaemonState) -> Result<(), DaemonError> {
    validate_state(state)?;
    let mut bytes = serde_json::to_vec_pretty(state)
        .map_err(|_| DaemonError::State("state could not be encoded".to_owned()))?;
    bytes.push(b'\n');
    if bytes.len() > MAX_STATE_BYTES {
        return Err(DaemonError::State(
            "state exceeds its durable size limit".to_owned(),
        ));
    }

    let parent = path
        .parent()
        .ok_or_else(|| DaemonError::State("state path has no parent".to_owned()))?;
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
    file.write_all(&bytes)?;
    file.sync_all()?;
    set_private_file(&temporary)?;
    fs::rename(&temporary, path)?;
    set_private_file(path)?;
    sync_parent(parent)?;
    Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<(), DaemonError> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file(path: &Path) -> Result<(), DaemonError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    let _ = path;
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), DaemonError> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    let _ = path;
    Ok(())
}

fn path_string(path: &Path) -> Result<String, DaemonError> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| DaemonError::State("Greenways path is not valid UTF-8".to_owned()))
}

fn now_unix_ms() -> Result<u64, DaemonError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| DaemonError::State("system clock predates Unix epoch".to_owned()))?;
    u64::try_from(duration.as_millis())
        .map_err(|_| DaemonError::State("system clock overflowed".to_owned()))
}

#[cfg(unix)]
struct SocketGuard(PathBuf);

#[cfg(unix)]
impl Drop for SocketGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use greenways_authority::{LocalClientRegistry, LocalClientRole};
    use greenways_local::{AuthenticatedLocalClient, LocalClient as PublicLocalClient};
    use greenways_protocol::{new_request_id, request_digest, Outcome, VaultStatus};
    use greenways_provider::{ModelMessage, ModelMessageRole, ProviderInvocation};
    use std::{thread, time::Duration};

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(label: &str) -> Self {
            let unique = new_request_id()
                .expect("test randomness should be available")
                .replace('/', "-");
            Self(
                std::env::temp_dir().join(format!("greenwaysd-{label}-{}-{unique}", process::id())),
            )
        }

        fn paths(&self) -> GreenwaysPaths {
            GreenwaysPaths::from_home(self.0.clone())
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn wait_for_socket(path: &Path) {
        for _ in 0..200 {
            if path.exists() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("Greenways daemon socket did not appear");
    }

    #[test]
    fn persists_identity_and_advances_generation_after_restart() {
        let home = TestHome::new("restart");
        let paths = home.paths();
        let first = Daemon::open_at(paths.clone(), 1_000).expect("first daemon should open");
        let node_id = first.state.node_id.clone();
        assert_eq!(first.state.generation, 1);
        drop(first);

        let second = Daemon::open_at(paths, 2_000).expect("second daemon should open");
        assert_eq!(second.state.node_id, node_id);
        assert_eq!(second.state.generation, 2);
        assert_eq!(second.state.last_started_at_unix_ms, 2_000);
    }

    #[test]
    fn replays_exact_requests_and_fences_request_id_collisions() {
        let home = TestHome::new("replay");
        let mut daemon =
            Daemon::open_at(home.paths(), 1_000).expect("daemon should open for replay");
        let request_id = "local/request/replay0001";
        let first = daemon
            .handle_request_at(LocalRequest::status(request_id), 2_000)
            .expect("status should complete");
        let revision = daemon.state.revision;
        let replay = daemon
            .handle_request_at(LocalRequest::status(request_id), 3_000)
            .expect("status replay should complete");
        assert_eq!(replay, first);
        assert_eq!(daemon.state.revision, revision);

        let collision = daemon
            .handle_request_at(LocalRequest::paths(request_id), 4_000)
            .expect("collision should return a closed error");
        assert_eq!(collision.outcome, Outcome::Error);
        assert_eq!(
            collision
                .error
                .expect("collision should have an error")
                .code,
            "request-id-collision"
        );
        assert_eq!(daemon.state.revision, revision);
    }

    #[test]
    fn rejects_corrupt_persisted_state() {
        let home = TestHome::new("corrupt");
        let paths = home.paths();
        ensure_private_dir(paths.state_file.parent().expect("state parent"))
            .expect("state directory should exist");
        fs::write(&paths.state_file, b"{}\n").expect("corrupt state should be written");
        assert!(matches!(
            Daemon::open_at(paths, 1_000),
            Err(DaemonError::State(_))
        ));
    }

    #[test]
    fn requires_authorized_actor_and_projects_only_redacted_provider_vault_status() {
        let home = TestHome::new("vault-status");
        let paths = home.paths();
        let registry_path = paths.home.join("state").join("providers.json");
        fs::create_dir_all(registry_path.parent().expect("provider registry parent"))
            .expect("provider registry directory");
        fs::write(
            &registry_path,
            serde_json::to_vec_pretty(&serde_json::json!({
                "protocol": "greenways-provider-registry/0-alpha",
                "revision": 1,
                "profiles": [{
                    "protocol": "greenways-provider-profile/0-alpha",
                    "id": "openai.personal",
                    "provider": "openai",
                    "label": "Personal OpenAI",
                    "createdAtUnixMs": 1_000,
                    "updatedAtUnixMs": 1_000
                }]
            }))
            .expect("provider registry JSON"),
        )
        .expect("provider registry should be written");

        let mut daemon = Daemon::open_at(paths, 1_500).expect("daemon should open");
        let public = daemon
            .handle_request_at(
                LocalRequest::vault_status("local/request/vaultstat1"),
                2_000,
            )
            .expect("public vault status should return a closed response");
        assert_eq!(public.outcome, Outcome::Error);
        assert_eq!(
            public.error.expect("authentication error").code,
            "authentication-required"
        );

        let browser_actor = RequestActor {
            client_id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
            role: LocalClientRole::BrowserBridge,
        };
        let denied = daemon
            .handle_request_as_at(
                LocalRequest::vault_status("local/request/vaultstat2"),
                Some(browser_actor),
                2_100,
            )
            .expect("browser vault status should return a closed response");
        assert_eq!(denied.outcome, Outcome::Error);
        assert_eq!(
            denied.error.expect("authority denial").code,
            "authority-denied"
        );
        assert!(daemon.state.receipts.is_empty());

        let cli_actor = RequestActor {
            client_id: "local/client/ffeeddccbbaa99887766554433221100".to_owned(),
            role: LocalClientRole::Cli,
        };
        let response = daemon
            .handle_request_as_at(
                LocalRequest::vault_status("local/request/vaultstat3"),
                Some(cli_actor),
                2_200,
            )
            .expect("vault status should complete");
        let status: VaultStatus =
            serde_json::from_value(response.value.expect("vault status should have a value"))
                .expect("vault status should be valid");
        assert_eq!(status.provider_profile_count, 1);
        assert_eq!(status.credential_store, "system-keyring");
        assert!(!status.secret_projection);
        let encoded = serde_json::to_string(&status).expect("status should encode");
        assert!(!encoded.contains("openai.personal"));
        assert!(!encoded.contains("Personal OpenAI"));
    }

    #[test]
    fn binds_durable_request_ownership_to_the_authenticated_actor() {
        let home = TestHome::new("actor-replay");
        let mut daemon = Daemon::open_at(home.paths(), 1_000).expect("daemon should open");
        let request_id = "local/request/actorreplay1";
        let first_actor = RequestActor {
            client_id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
            role: LocalClientRole::Cli,
        };
        let second_actor = RequestActor {
            client_id: "local/client/ffeeddccbbaa99887766554433221100".to_owned(),
            role: LocalClientRole::Cli,
        };
        let first = daemon
            .handle_request_as_at(LocalRequest::status(request_id), Some(first_actor), 2_000)
            .expect("first actor should complete");
        assert_eq!(first.outcome, Outcome::Ok);
        let collision = daemon
            .handle_request_as_at(LocalRequest::status(request_id), Some(second_actor), 3_000)
            .expect("second actor should receive a closed collision");
        assert_eq!(
            collision.error.expect("collision error").code,
            "request-id-collision"
        );
    }

    fn provider_request(request_id: &str, profile_id: &str) -> LocalRequest {
        LocalRequest::provider_invoke(
            request_id,
            ProviderInvocation::new(
                profile_id,
                "gpt-5",
                vec![ModelMessage {
                    role: ModelMessageRole::User,
                    content: "Hello".to_owned(),
                }],
                128,
                5_000,
            )
            .expect("provider invocation should be valid"),
        )
        .expect("provider request should encode")
    }

    fn request_actor(role: LocalClientRole, suffix: &str) -> RequestActor {
        RequestActor {
            client_id: format!("local/client/{suffix}"),
            role,
        }
    }

    #[test]
    fn provider_invocation_requires_an_authenticated_non_browser_role() {
        let home = TestHome::new("provider-role");
        let mut daemon = Daemon::open_at(home.paths(), 1_000).expect("daemon should open");
        let unauthenticated = daemon
            .handle_request_as_at(
                provider_request("local/request/providerauth1", "missing.profile"),
                None,
                2_000,
            )
            .expect("unauthenticated denial should complete");
        assert_eq!(
            unauthenticated.error.expect("authentication error").code,
            "authentication-required"
        );
        let browser = daemon
            .handle_request_as_at(
                provider_request("local/request/providerbrowser1", "missing.profile"),
                Some(request_actor(
                    LocalClientRole::BrowserBridge,
                    "00112233445566778899aabbccddeeff",
                )),
                3_000,
            )
            .expect("browser denial should complete");
        assert_eq!(
            browser.error.expect("browser error").code,
            "authority-denied"
        );
        assert!(daemon.state.provider_invocations.is_empty());
    }

    #[test]
    fn definitive_provider_errors_are_receipted_and_replayed() {
        let home = TestHome::new("provider-replay");
        let mut daemon = Daemon::open_at(home.paths(), 1_000).expect("daemon should open");
        let actor = request_actor(LocalClientRole::Cli, "00112233445566778899aabbccddeeff");
        let request = provider_request("local/request/providerreplay1", "missing.profile");
        let first = daemon
            .handle_request_as_at(request.clone(), Some(actor.clone()), 2_000)
            .expect("missing profile should complete");
        assert_eq!(
            first.error.as_ref().expect("missing profile error").code,
            "provider-profile-missing"
        );
        assert!(daemon.state.provider_invocations.is_empty());
        let revision = daemon.state.revision;
        let replay = daemon
            .handle_request_as_at(request, Some(actor), 3_000)
            .expect("provider error should replay");
        assert_eq!(replay, first);
        assert_eq!(daemon.state.revision, revision);
    }

    #[test]
    fn prepared_provider_claims_never_retry_automatically() {
        let home = TestHome::new("provider-uncertain");
        let mut daemon = Daemon::open_at(home.paths(), 1_000).expect("daemon should open");
        let actor = request_actor(
            LocalClientRole::Developer,
            "00112233445566778899aabbccddeeff",
        );
        let request = provider_request("local/request/provideruncertain1", "missing.profile");
        let digest = request_digest(&request).expect("request should hash");
        daemon
            .prepare_provider_invocation(ProviderInvocationClaim {
                protocol: provider::PROVIDER_INVOCATION_CLAIM_PROTOCOL.to_owned(),
                request_id: request.request_id.clone(),
                digest,
                actor: actor.clone(),
                prepared_at_unix_ms: 2_000,
            })
            .expect("claim should prepare");
        let revision = daemon.state.revision;
        let response = daemon
            .handle_request_as_at(request, Some(actor), 3_000)
            .expect("uncertain claim should complete");
        assert_eq!(
            response.error.expect("uncertain error").code,
            "provider-invocation-uncertain"
        );
        assert_eq!(daemon.state.revision, revision);
        assert_eq!(daemon.state.provider_invocations.len(), 1);
    }

    #[test]
    fn profile_identity_reads_require_an_authenticated_actor() {
        let home = TestHome::new("identity-auth");
        let mut daemon = Daemon::open_at(home.paths(), 1_000).expect("daemon should open");
        let public = daemon
            .handle_request_at(
                LocalRequest::identity_status("local/request/identityauth1"),
                2_000,
            )
            .expect("identity status should return a closed response");
        assert_eq!(public.outcome, Outcome::Error);
        assert_eq!(
            public.error.expect("authentication error").code,
            "authentication-required"
        );
        let actor = RequestActor {
            client_id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
            role: LocalClientRole::BrowserBridge,
        };
        let authenticated = daemon
            .handle_request_as_at(
                LocalRequest::identity_status("local/request/identityauth2"),
                Some(actor),
                3_000,
            )
            .expect("authenticated identity status should complete");
        assert_eq!(authenticated.outcome, Outcome::Ok);
        let status: greenways_identity::ProfileIdentityStatus =
            serde_json::from_value(authenticated.value.expect("identity status value"))
                .expect("identity status projection");
        assert_eq!(status.state, "unconfigured");
        assert!(!status.private_key_projection);
    }

    #[test]
    fn connection_sessions_expire_and_exhaust_without_bearer_tokens() {
        let client = LocalClient {
            protocol: greenways_authority::LOCAL_CLIENT_PROTOCOL.to_owned(),
            id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
            role: LocalClientRole::Developer,
            label: "Developer".to_owned(),
            created_at_unix_ms: 1,
            revoked_at_unix_ms: None,
        };
        let mut session = ConnectionSession {
            session: new_local_session(&client, 1_000, 100, 2).expect("session should open"),
        };
        assert!(session.authorize_at(1_001).is_ok());
        assert!(session.authorize_at(1_002).is_ok());
        assert_eq!(session.authorize_at(1_003), Err("session-exhausted"));
        let mut expired = ConnectionSession {
            session: new_local_session(&client, 1_000, 10, 2).expect("session should open"),
        };
        assert_eq!(expired.authorize_at(1_010), Err("session-expired"));
        let encoded = serde_json::to_string(&session.session).expect("session should encode");
        assert!(!encoded.contains("gwc_"));
    }

    #[cfg(unix)]
    #[test]
    fn authenticates_a_cli_session_and_returns_role_scoped_authority() {
        let home = TestHome::new("auth-socket");
        let paths = home.paths();
        let credential_path = paths.home.join("clients").join("cli.json");
        let mut registry =
            LocalClientRegistry::open(paths.home.join("state").join("local-clients.json"))
                .expect("client registry should open");
        let issued = registry
            .issue_to_file(
                LocalClientRole::Cli,
                "Greenways CLI",
                &credential_path,
                1_000,
            )
            .expect("CLI client should issue");
        drop(registry);

        let server_paths = paths.clone();
        let handle = thread::spawn(move || serve(server_paths, true));
        wait_for_socket(&paths.socket_file);
        let mut client = AuthenticatedLocalClient::from_paths(&paths, &credential_path)
            .expect("CLI should authenticate");
        assert_eq!(client.session().client_id, issued.id);
        let whoami = client.whoami().expect("whoami should complete");
        let projected: LocalClient =
            serde_json::from_value(whoami.value.expect("whoami value")).expect("whoami projection");
        assert_eq!(projected.id, issued.id);
        let clients = client.clients().expect("CLI should list clients");
        let listed: Vec<LocalClient> =
            serde_json::from_value(clients.value.expect("client list value"))
                .expect("client list projection");
        assert_eq!(listed.len(), 1);
        assert_eq!(
            client
                .vault_status()
                .expect("vault status should complete")
                .outcome,
            Outcome::Ok
        );
        drop(client);
        handle
            .join()
            .expect("server thread should join")
            .expect("server should exit cleanly");
    }

    #[cfg(unix)]
    #[test]
    fn browser_bridge_session_cannot_inspect_authority_or_vault_state() {
        let home = TestHome::new("browser-role");
        let paths = home.paths();
        let credential_path = paths.home.join("clients").join("browser.json");
        let mut registry =
            LocalClientRegistry::open(paths.home.join("state").join("local-clients.json"))
                .expect("client registry should open");
        registry
            .issue_to_file(
                LocalClientRole::BrowserBridge,
                "Chrome bridge",
                &credential_path,
                1_000,
            )
            .expect("browser client should issue");
        drop(registry);

        let server_paths = paths.clone();
        let handle = thread::spawn(move || serve(server_paths, true));
        wait_for_socket(&paths.socket_file);
        let mut client = AuthenticatedLocalClient::from_paths(&paths, &credential_path)
            .expect("browser should authenticate");
        assert_eq!(
            client.whoami().expect("whoami should complete").outcome,
            Outcome::Ok
        );
        let denied = client.clients().expect("denial should be a response");
        assert_eq!(denied.outcome, Outcome::Error);
        assert_eq!(denied.error.expect("denial error").code, "authority-denied");
        let denied = client
            .vault_status()
            .expect("vault denial should be a response");
        assert_eq!(denied.outcome, Outcome::Error);
        assert_eq!(
            denied.error.expect("vault denial error").code,
            "authority-denied"
        );
        drop(client);
        handle
            .join()
            .expect("server thread should join")
            .expect("server should exit cleanly");
    }

    #[cfg(unix)]
    #[test]
    fn serves_status_across_the_real_unix_socket_boundary() {
        let home = TestHome::new("socket");
        let paths = home.paths();
        let server_paths = paths.clone();
        let handle = thread::spawn(move || serve(server_paths, true));

        for _ in 0..100 {
            if paths.socket_file.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }

        let response = PublicLocalClient::from_paths(&paths)
            .status()
            .expect("client should read daemon status");
        assert_eq!(response.outcome, Outcome::Ok);
        handle
            .join()
            .expect("server thread should join")
            .expect("server should exit cleanly");
        assert!(!paths.socket_file.exists());
    }
}
