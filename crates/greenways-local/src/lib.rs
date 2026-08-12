use greenways_protocol::{
    decode_response, encode_request_line, new_request_id, LocalRequest, LocalResponse,
    ProtocolError, MAX_RESPONSE_BYTES,
};
use std::{
    env,
    error::Error,
    fmt,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

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
    UnsupportedPlatform,
    ResponseMismatch,
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
            Self::UnsupportedPlatform => {
                write!(
                    formatter,
                    "Greenways local transport is not implemented on this platform"
                )
            }
            Self::ResponseMismatch => {
                write!(
                    formatter,
                    "Greenways local response did not match its request"
                )
            }
        }
    }
}

impl Error for LocalError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Protocol(error) => Some(error),
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

    pub fn vault_status(&self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::vault_status(new_request_id()?))
    }

    pub fn send(&self, request: &LocalRequest) -> Result<LocalResponse, LocalError> {
        send_request(&self.socket_file, request)
    }
}

#[cfg(unix)]
fn send_request(socket_file: &Path, request: &LocalRequest) -> Result<LocalResponse, LocalError> {
    use std::net::Shutdown;
    use std::os::unix::net::UnixStream;

    let mut stream = UnixStream::connect(socket_file)?;
    stream.write_all(&encode_request_line(request)?)?;
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
}
