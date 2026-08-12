use greenways_local::GreenwaysPaths;
use greenways_protocol::{
    canonical_request, decode_request, encode_response_line, new_node_id, request_digest,
    validate_digest, validate_node_id, validate_response, DaemonPaths, DaemonStatus, LocalRequest,
    LocalResponse, ProtocolError, MAX_REQUEST_BYTES,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

const STATE_PROTOCOL: &str = "greenways-daemon-state/0-alpha";
const RECEIPT_PROTOCOL: &str = "greenways-local-receipt/0-alpha";
const MAX_STATE_BYTES: usize = 2 * 1024 * 1024;
const MAX_RECEIPTS: usize = 64;
const INVALID_REQUEST_ID: &str = "local/request/invalid0";

#[derive(Debug)]
pub enum DaemonError {
    Io(io::Error),
    Protocol(ProtocolError),
    State(String),
    AlreadyRunning(PathBuf),
    UnsupportedPlatform,
}

impl fmt::Display for DaemonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Greenways daemon I/O failed: {error}"),
            Self::Protocol(error) => write!(formatter, "Greenways daemon protocol failed: {error}"),
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestReceipt {
    protocol: String,
    request_id: String,
    digest: String,
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
}

#[derive(Debug)]
pub struct Daemon {
    paths: GreenwaysPaths,
    state: DaemonState,
}

impl Daemon {
    pub fn open(paths: GreenwaysPaths) -> Result<Self, DaemonError> {
        Self::open_at(paths, now_unix_ms()?)
    }

    fn open_at(paths: GreenwaysPaths, observed_at_unix_ms: u64) -> Result<Self, DaemonError> {
        ensure_private_dir(&paths.home)?;
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
            }
        };
        state.generation = state
            .generation
            .checked_add(1)
            .ok_or_else(|| DaemonError::State("generation overflowed".to_owned()))?;
        state.last_started_at_unix_ms = observed_at_unix_ms;
        validate_state(&state)?;
        write_state(&paths.state_file, &state)?;
        Ok(Self { paths, state })
    }

    pub fn handle_request(&mut self, request: LocalRequest) -> Result<LocalResponse, DaemonError> {
        self.handle_request_at(request, now_unix_ms()?)
    }

    fn handle_request_at(
        &mut self,
        request: LocalRequest,
        observed_at_unix_ms: u64,
    ) -> Result<LocalResponse, DaemonError> {
        greenways_protocol::validate_request(&request)?;
        let digest = request_digest(&request)?;
        if let Some(receipt) = self
            .state
            .receipts
            .iter()
            .find(|receipt| receipt.request_id == request.request_id)
        {
            if receipt.digest != digest {
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
                    profile_mode: "unconfigured".to_owned(),
                    authority_mode: "daemon".to_owned(),
                };
                LocalResponse::ok(
                    request.request_id.clone(),
                    serde_json::to_value(status).map_err(|_| {
                        DaemonError::State("status projection could not be encoded".to_owned())
                    })?,
                )
            }
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
        if self.state.receipts.len() > MAX_RECEIPTS {
            self.state.receipts.remove(0);
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
    let mut daemon = Daemon::open(paths)?;

    for incoming in listener.incoming() {
        match incoming {
            Ok(mut stream) => {
                if let Err(error) = handle_connection(&mut stream, &mut daemon) {
                    eprintln!("greenwaysd: contained local connection failure: {error}");
                }
                if once {
                    break;
                }
            }
            Err(error) => return Err(DaemonError::Io(error)),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn handle_connection(
    stream: &mut std::os::unix::net::UnixStream,
    daemon: &mut Daemon,
) -> Result<(), DaemonError> {
    use std::net::Shutdown;

    let mut bytes = Vec::new();
    (&mut *stream)
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;

    let response = if bytes.len() > MAX_REQUEST_BYTES {
        LocalResponse::error(
            INVALID_REQUEST_ID,
            "request-too-large",
            "Greenways local requests are limited to 64 KiB.",
        )
    } else {
        match decode_request(&bytes) {
            Ok(request) => {
                let request_id = request.request_id.clone();
                match daemon.handle_request(request) {
                    Ok(response) => response,
                    Err(_) => LocalResponse::error(
                        request_id,
                        "daemon-unavailable",
                        "Greenways daemon could not safely complete the request.",
                    ),
                }
            }
            Err(error) => LocalResponse::error(INVALID_REQUEST_ID, error.code(), error.message()),
        }
    };
    stream.write_all(&encode_response_line(&response)?)?;
    stream.shutdown(Shutdown::Write)?;
    Ok(())
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
    use greenways_local::LocalClient;
    use greenways_protocol::{new_request_id, Outcome};
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

        let response = LocalClient::from_paths(&paths)
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
