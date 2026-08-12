use greenways_authority::{
    read_credential_file, validate_local_session, AuthorityError, LocalClient as AuthorityClient,
    LocalClientCredential, LocalSession,
};
use greenways_protocol::{
    decode_response, encode_request_line, new_request_id, LocalRequest, LocalResponse, Outcome,
    ProtocolError, MAX_RESPONSE_BYTES,
};
use greenways_provider::{ProviderInvocation, ProviderResult};
use serde_json::{Map, Value};
use std::{
    env,
    error::Error,
    fmt,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
use zeroize::Zeroize;

#[cfg(unix)]
use std::io::{BufRead, BufReader};
#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GreenwaysPaths {
    pub home: PathBuf,
    pub state_file: PathBuf,
    pub socket_file: PathBuf,
}

impl GreenwaysPaths {
    pub fn resolve(home_override: Option<PathBuf>) -> Result<Self, LocalError> {
        let home = home_override
            .or_else(|| env::var_os("GREENWAYS_HOME").map(PathBuf::from))
            .or_else(|| env::var_os("HOME").map(|value| PathBuf::from(value).join(".greenways")))
            .ok_or(LocalError::MissingHome)?;
        Ok(Self::from_home(home))
    }

    pub fn from_home(home: PathBuf) -> Self {
        Self {
            state_file: home.join("state").join("daemon.json"),
            socket_file: home.join("run").join("greenwaysd.sock"),
            home,
        }
    }
}

#[derive(Debug)]
pub enum LocalError {
    MissingHome,
    Io(io::Error),
    Protocol(ProtocolError),
    Authority(AuthorityError),
    Encoding(serde_json::Error),
    UnsupportedPlatform,
    ResponseMismatch,
    AuthenticationRejected,
    SessionMismatch,
}

impl fmt::Display for LocalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingHome => write!(
                formatter,
                "Greenways home is unavailable; set GREENWAYS_HOME or HOME"
            ),
            Self::Io(error) => write!(formatter, "Greenways local transport failed: {error}"),
            Self::Protocol(error) => write!(formatter, "Greenways local protocol failed: {error}"),
            Self::Authority(error) => {
                write!(formatter, "Greenways local authority failed: {error}")
            }
            Self::Encoding(_) => write!(formatter, "Greenways local value could not be encoded"),
            Self::UnsupportedPlatform => write!(
                formatter,
                "Greenways local transport is not implemented on this platform"
            ),
            Self::ResponseMismatch => write!(
                formatter,
                "Greenways local response did not match its request"
            ),
            Self::AuthenticationRejected => write!(
                formatter,
                "Greenways daemon rejected the local client credential"
            ),
            Self::SessionMismatch => write!(
                formatter,
                "Greenways daemon returned a session for another local client"
            ),
        }
    }
}

impl Error for LocalError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Protocol(error) => Some(error),
            Self::Authority(error) => Some(error),
            Self::Encoding(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for LocalError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<ProtocolError> for LocalError {
    fn from(value: ProtocolError) -> Self {
        Self::Protocol(value)
    }
}

impl From<AuthorityError> for LocalError {
    fn from(value: AuthorityError) -> Self {
        Self::Authority(value)
    }
}

impl From<serde_json::Error> for LocalError {
    fn from(value: serde_json::Error) -> Self {
        Self::Encoding(value)
    }
}

#[derive(Debug, Clone)]
pub struct LocalClient {
    socket_file: PathBuf,
}

impl LocalClient {
    pub fn new(socket_file: PathBuf) -> Self {
        Self { socket_file }
    }

    pub fn from_paths(paths: &GreenwaysPaths) -> Self {
        Self::new(paths.socket_file.clone())
    }

    pub fn status(&self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::status(new_request_id()?))
    }

    pub fn paths(&self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::paths(new_request_id()?))
    }

    pub fn send(&self, request: &LocalRequest) -> Result<LocalResponse, LocalError> {
        send_request(&self.socket_file, request)
    }
}

#[cfg(unix)]
pub struct AuthenticatedLocalClient {
    writer: UnixStream,
    reader: BufReader<UnixStream>,
    session: LocalSession,
}

#[cfg(unix)]
impl fmt::Debug for AuthenticatedLocalClient {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthenticatedLocalClient")
            .field("session", &self.session)
            .finish_non_exhaustive()
    }
}

#[cfg(unix)]
impl AuthenticatedLocalClient {
    pub fn from_paths(
        paths: &GreenwaysPaths,
        credential_path: impl AsRef<Path>,
    ) -> Result<Self, LocalError> {
        Self::connect(&paths.socket_file, credential_path)
    }

    pub fn connect(
        socket_file: impl AsRef<Path>,
        credential_path: impl AsRef<Path>,
    ) -> Result<Self, LocalError> {
        let credential = read_credential_file(credential_path)?;
        let expected_client_id = credential.client_id.clone();
        let expected_role = credential.role;
        let writer = UnixStream::connect(socket_file)?;
        let reader = BufReader::new(writer.try_clone()?);
        let mut client = Self {
            writer,
            reader,
            session: placeholder_session(&credential),
        };
        let mut request =
            LocalRequest::session_open(new_request_id()?, credential.into_session_arguments());
        let response = client.round_trip_secret(&mut request)?;
        if response.outcome != Outcome::Ok {
            return Err(LocalError::AuthenticationRejected);
        }
        let session: LocalSession =
            serde_json::from_value(response.value.ok_or(LocalError::AuthenticationRejected)?)?;
        validate_local_session(&session, &expected_client_id, expected_role)
            .map_err(|_| LocalError::SessionMismatch)?;
        client.session = session;
        Ok(client)
    }

    pub fn session(&self) -> &LocalSession {
        &self.session
    }

    pub fn vault_status(&mut self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::vault_status(new_request_id()?))
    }

    pub fn whoami(&mut self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::whoami(new_request_id()?))
    }

    pub fn clients(&mut self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::clients_list(new_request_id()?))
    }

    pub fn invoke(&mut self, invocation: ProviderInvocation) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::provider_invoke(
            new_request_id()?,
            invocation,
        )?)
    }

    pub fn identity_status(&mut self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::identity_status(new_request_id()?))
    }

    pub fn identity_public_card(&mut self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::identity_public_card(new_request_id()?))
    }

    pub fn send(&mut self, request: &LocalRequest) -> Result<LocalResponse, LocalError> {
        if request.operation == "client.session.open" {
            return Err(LocalError::AuthenticationRejected);
        }
        self.round_trip(request)
    }

    fn round_trip(&mut self, request: &LocalRequest) -> Result<LocalResponse, LocalError> {
        let mut encoded = encode_request_line(request)?;
        let write_result = self.writer.write_all(&encoded);
        encoded.zeroize();
        write_result?;
        self.finish_round_trip(&request.request_id)
    }

    fn round_trip_secret(
        &mut self,
        request: &mut LocalRequest,
    ) -> Result<LocalResponse, LocalError> {
        let mut encoded = encode_request_line(request)?;
        let write_result = self.writer.write_all(&encoded);
        encoded.zeroize();
        zeroize_argument_map(&mut request.arguments);
        write_result?;
        self.finish_round_trip(&request.request_id)
    }

    fn finish_round_trip(&mut self, request_id: &str) -> Result<LocalResponse, LocalError> {
        self.writer.flush()?;
        let response = read_response_line(&mut self.reader)?;
        if response.request_id != request_id {
            return Err(LocalError::ResponseMismatch);
        }
        Ok(response)
    }
}

#[cfg(not(unix))]
#[derive(Debug)]
pub struct AuthenticatedLocalClient;

#[cfg(not(unix))]
impl AuthenticatedLocalClient {
    pub fn from_paths(
        _paths: &GreenwaysPaths,
        _credential_path: impl AsRef<Path>,
    ) -> Result<Self, LocalError> {
        Err(LocalError::UnsupportedPlatform)
    }
}

fn zeroize_argument_map(arguments: &mut Map<String, Value>) {
    for value in arguments.values_mut() {
        zeroize_json_value(value);
    }
    arguments.clear();
}

fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => {
            for value in values {
                zeroize_json_value(value);
            }
        }
        Value::Object(values) => zeroize_argument_map(values),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn placeholder_session(credential: &LocalClientCredential) -> LocalSession {
    LocalSession {
        protocol: greenways_authority::LOCAL_SESSION_PROTOCOL.to_owned(),
        id: "local/session/00000000000000000000000000000000".to_owned(),
        client_id: credential.client_id.clone(),
        role: credential.role,
        label: String::new(),
        opened_at_unix_ms: 0,
        expires_at_unix_ms: 0,
        remaining_requests: 0,
    }
}

#[cfg(unix)]
fn read_response_line(reader: &mut BufReader<UnixStream>) -> Result<LocalResponse, LocalError> {
    let mut bytes = Vec::new();
    let read = reader
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if read == 0 {
        return Err(LocalError::Io(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "Greenways daemon closed the authenticated session",
        )));
    }
    if bytes.len() > MAX_RESPONSE_BYTES || !bytes.ends_with(b"\n") {
        return Err(LocalError::Protocol(ProtocolError::new(
            "response-too-large",
            "Greenways local response exceeded its size limit.",
        )));
    }
    decode_response(&bytes).map_err(LocalError::from)
}

#[cfg(unix)]
fn send_request(socket_file: &Path, request: &LocalRequest) -> Result<LocalResponse, LocalError> {
    use std::net::Shutdown;

    let mut stream = UnixStream::connect(socket_file)?;
    let mut encoded = encode_request_line(request)?;
    let write_result = stream.write_all(&encoded);
    encoded.zeroize();
    write_result?;
    stream.shutdown(Shutdown::Write)?;

    let mut bytes = Vec::new();
    (&mut stream)
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(LocalError::Protocol(ProtocolError::new(
            "response-too-large",
            "Greenways local response exceeded its size limit.",
        )));
    }
    let response = decode_response(&bytes)?;
    if response.request_id != request.request_id {
        return Err(LocalError::ResponseMismatch);
    }
    Ok(response)
}

#[cfg(not(unix))]
fn send_request(_socket_file: &Path, _request: &LocalRequest) -> Result<LocalResponse, LocalError> {
    Err(LocalError::UnsupportedPlatform)
}

pub fn decode_client(response: &LocalResponse) -> Result<AuthorityClient, LocalError> {
    if response.outcome != Outcome::Ok {
        return Err(LocalError::AuthenticationRejected);
    }
    serde_json::from_value(response.value.clone().ok_or(LocalError::ResponseMismatch)?)
        .map_err(LocalError::from)
}

pub fn decode_clients(response: &LocalResponse) -> Result<Vec<AuthorityClient>, LocalError> {
    if response.outcome != Outcome::Ok {
        return Err(LocalError::AuthenticationRejected);
    }
    serde_json::from_value(response.value.clone().ok_or(LocalError::ResponseMismatch)?)
        .map_err(LocalError::from)
}

pub fn decode_provider_result(response: &LocalResponse) -> Result<ProviderResult, LocalError> {
    if response.outcome != Outcome::Ok {
        return Err(LocalError::AuthenticationRejected);
    }
    let result: ProviderResult =
        serde_json::from_value(response.value.clone().ok_or(LocalError::ResponseMismatch)?)?;
    result
        .validate()
        .map_err(|_| LocalError::ResponseMismatch)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_one_shared_home_layout() {
        let paths = GreenwaysPaths::from_home(PathBuf::from("/tmp/greenways-test"));
        assert_eq!(
            paths.state_file,
            PathBuf::from("/tmp/greenways-test/state/daemon.json")
        );
        assert_eq!(
            paths.socket_file,
            PathBuf::from("/tmp/greenways-test/run/greenwaysd.sock")
        );
    }

    #[test]
    fn placeholder_session_contains_no_credential_token() {
        let credential = LocalClientCredential {
            protocol: greenways_authority::LOCAL_CLIENT_CREDENTIAL_PROTOCOL.to_owned(),
            client_id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
            role: greenways_authority::LocalClientRole::Cli,
            token: "gwc_0000000000000000000000000000000000000000000000000000000000000000"
                .to_owned(),
            issued_at_unix_ms: 1,
        };
        let session = placeholder_session(&credential);
        assert!(!serde_json::to_string(&session)
            .expect("session should encode")
            .contains(&credential.token));
    }
}
