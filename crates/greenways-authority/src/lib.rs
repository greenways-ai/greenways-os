use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
};
use zeroize::Zeroize;

pub const LOCAL_CLIENT_REGISTRY_PROTOCOL: &str = "greenways-local-client-registry/0-alpha";
pub const LOCAL_CLIENT_PROTOCOL: &str = "greenways-local-client/0-alpha";
pub const LOCAL_CLIENT_CREDENTIAL_PROTOCOL: &str = "greenways-local-client-credential/0-alpha";
pub const LOCAL_SESSION_PROTOCOL: &str = "greenways-local-session/0-alpha";
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
const MAX_CREDENTIAL_BYTES: usize = 16 * 1024;
const MAX_CLIENTS: usize = 256;
const CLIENT_ID_PREFIX: &str = "local/client/";
const SESSION_ID_PREFIX: &str = "local/session/";
const TOKEN_PREFIX: &str = "gwc_";
const DIGEST_PREFIX: &str = "sha256:";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LocalClientRole {
    Desktop,
    Cli,
    BrowserBridge,
    Developer,
}

impl LocalClientRole {
    pub fn parse(value: &str) -> Result<Self, AuthorityError> {
        match value {
            "desktop" => Ok(Self::Desktop),
            "cli" => Ok(Self::Cli),
            "browser-bridge" => Ok(Self::BrowserBridge),
            "developer" => Ok(Self::Developer),
            _ => Err(AuthorityError::Invalid(
                "client role must be desktop, cli, browser-bridge, or developer".to_owned(),
            )),
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Cli => "cli",
            Self::BrowserBridge => "browser-bridge",
            Self::Developer => "developer",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalClient {
    pub protocol: String,
    pub id: String,
    pub role: LocalClientRole,
    pub label: String,
    pub created_at_unix_ms: u64,
    pub revoked_at_unix_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalClientCredential {
    pub protocol: String,
    pub client_id: String,
    pub role: LocalClientRole,
    pub token: String,
    pub issued_at_unix_ms: u64,
}

impl fmt::Debug for LocalClientCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalClientCredential")
            .field("protocol", &self.protocol)
            .field("client_id", &self.client_id)
            .field("role", &self.role)
            .field("token", &"[redacted]")
            .field("issued_at_unix_ms", &self.issued_at_unix_ms)
            .finish()
    }
}

impl Drop for LocalClientCredential {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

impl LocalClientCredential {
    pub fn into_session_arguments(mut self) -> Map<String, Value> {
        let mut arguments = Map::new();
        arguments.insert(
            "protocol".to_owned(),
            Value::String(std::mem::take(&mut self.protocol)),
        );
        arguments.insert(
            "clientId".to_owned(),
            Value::String(std::mem::take(&mut self.client_id)),
        );
        arguments.insert(
            "role".to_owned(),
            Value::String(self.role.as_str().to_owned()),
        );
        arguments.insert(
            "token".to_owned(),
            Value::String(std::mem::take(&mut self.token)),
        );
        arguments.insert(
            "issuedAtUnixMs".to_owned(),
            Value::from(self.issued_at_unix_ms),
        );
        arguments
    }
}

pub fn parse_local_client_credential_arguments(
    mut arguments: Map<String, Value>,
) -> Result<LocalClientCredential, AuthorityError> {
    const KEYS: [&str; 5] = ["protocol", "clientId", "role", "token", "issuedAtUnixMs"];
    if arguments.len() != KEYS.len() || KEYS.iter().any(|key| !arguments.contains_key(*key)) {
        zeroize_json_map(&mut arguments);
        return Err(AuthorityError::CredentialRejected);
    }

    let parsed = (|| {
        let protocol = take_string(&mut arguments, "protocol")?;
        let client_id = take_string(&mut arguments, "clientId")?;
        let role = LocalClientRole::parse(&take_string(&mut arguments, "role")?)
            .map_err(|_| AuthorityError::CredentialRejected)?;
        let issued_at_unix_ms = take_u64(&mut arguments, "issuedAtUnixMs")?;
        let token = take_string(&mut arguments, "token")?;
        let credential = LocalClientCredential {
            protocol,
            client_id,
            role,
            token,
            issued_at_unix_ms,
        };
        validate_credential(&credential).map_err(|_| AuthorityError::CredentialRejected)?;
        Ok(credential)
    })();
    if parsed.is_err() {
        zeroize_json_map(&mut arguments);
    }
    parsed
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalSession {
    pub protocol: String,
    pub id: String,
    pub client_id: String,
    pub role: LocalClientRole,
    pub label: String,
    pub opened_at_unix_ms: u64,
    pub expires_at_unix_ms: u64,
    pub remaining_requests: u32,
}

pub fn validate_local_session(
    session: &LocalSession,
    expected_client_id: &str,
    expected_role: LocalClientRole,
) -> Result<(), AuthorityError> {
    let valid = session.protocol == LOCAL_SESSION_PROTOCOL
        && valid_session_id(&session.id)
        && session.client_id == expected_client_id
        && valid_client_id(&session.client_id)
        && session.role == expected_role
        && normalize_label(&session.label).is_ok()
        && session.opened_at_unix_ms > 0
        && session.expires_at_unix_ms > session.opened_at_unix_ms
        && session.expires_at_unix_ms - session.opened_at_unix_ms <= 24 * 60 * 60 * 1000
        && (1..=1024).contains(&session.remaining_requests);
    if valid {
        Ok(())
    } else {
        Err(AuthorityError::CredentialRejected)
    }
}

pub fn new_local_session(
    client: &LocalClient,
    opened_at_unix_ms: u64,
    ttl_ms: u64,
    maximum_requests: u32,
) -> Result<LocalSession, AuthorityError> {
    if client.revoked_at_unix_ms.is_some() || !valid_client_id(&client.id) {
        return Err(AuthorityError::CredentialRejected);
    }
    validate_timestamp(opened_at_unix_ms)?;
    if ttl_ms == 0 || ttl_ms > 24 * 60 * 60 * 1000 {
        return Err(AuthorityError::Invalid(
            "local session lifetime is outside its bound".to_owned(),
        ));
    }
    if maximum_requests == 0 || maximum_requests > 1024 {
        return Err(AuthorityError::Invalid(
            "local session request budget is outside its bound".to_owned(),
        ));
    }
    let expires_at_unix_ms = opened_at_unix_ms
        .checked_add(ttl_ms)
        .ok_or_else(|| AuthorityError::Invalid("local session expiry overflowed".to_owned()))?;
    let session = LocalSession {
        protocol: LOCAL_SESSION_PROTOCOL.to_owned(),
        id: new_session_id()?,
        client_id: client.id.clone(),
        role: client.role,
        label: client.label.clone(),
        opened_at_unix_ms,
        expires_at_unix_ms,
        remaining_requests: maximum_requests,
    };
    validate_local_session(&session, &client.id, client.role)?;
    Ok(session)
}

#[derive(Debug)]
pub enum AuthorityError {
    Io(io::Error),
    Encoding(serde_json::Error),
    Invalid(String),
    Conflict(String),
    NotFound(String),
    CredentialRejected,
}

impl fmt::Display for AuthorityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Greenways authority I/O failed: {error}"),
            Self::Encoding(_) => write!(formatter, "Greenways authority record is invalid"),
            Self::Invalid(message) => {
                write!(formatter, "Greenways authority input is invalid: {message}")
            }
            Self::Conflict(message) => {
                write!(formatter, "Greenways authority conflict: {message}")
            }
            Self::NotFound(message) => {
                write!(
                    formatter,
                    "Greenways authority record was not found: {message}"
                )
            }
            Self::CredentialRejected => {
                write!(
                    formatter,
                    "The Greenways local client credential was rejected"
                )
            }
        }
    }
}

impl Error for AuthorityError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Encoding(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for AuthorityError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for AuthorityError {
    fn from(value: serde_json::Error) -> Self {
        Self::Encoding(value)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredClient {
    protocol: String,
    id: String,
    role: LocalClientRole,
    label: String,
    token_digest: String,
    created_at_unix_ms: u64,
    revoked_at_unix_ms: Option<u64>,
}

impl StoredClient {
    fn public(&self) -> LocalClient {
        LocalClient {
            protocol: LOCAL_CLIENT_PROTOCOL.to_owned(),
            id: self.id.clone(),
            role: self.role,
            label: self.label.clone(),
            created_at_unix_ms: self.created_at_unix_ms,
            revoked_at_unix_ms: self.revoked_at_unix_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClientRegistryState {
    protocol: String,
    revision: u64,
    clients: Vec<StoredClient>,
}

impl Default for ClientRegistryState {
    fn default() -> Self {
        Self {
            protocol: LOCAL_CLIENT_REGISTRY_PROTOCOL.to_owned(),
            revision: 0,
            clients: Vec::new(),
        }
    }
}

pub struct LocalClientRegistry {
    path: PathBuf,
    state: ClientRegistryState,
}

impl fmt::Debug for LocalClientRegistry {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalClientRegistry")
            .field("path", &self.path)
            .field("revision", &self.state.revision)
            .field("client_count", &self.state.clients.len())
            .field("active_client_count", &self.active_client_count())
            .finish()
    }
}

impl LocalClientRegistry {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, AuthorityError> {
        let path = path.into();
        let state = if path.exists() {
            load_registry(&path)?
        } else {
            ClientRegistryState::default()
        };
        validate_registry(&state)?;
        Ok(Self { path, state })
    }

    pub fn clients(&self) -> Vec<LocalClient> {
        let mut clients = self
            .state
            .clients
            .iter()
            .map(StoredClient::public)
            .collect::<Vec<_>>();
        clients.sort_by(|left, right| left.id.cmp(&right.id));
        clients
    }

    pub fn active_client_count(&self) -> usize {
        self.state
            .clients
            .iter()
            .filter(|client| client.revoked_at_unix_ms.is_none())
            .count()
    }

    pub fn issue_to_file(
        &mut self,
        role: LocalClientRole,
        label: &str,
        credential_path: impl AsRef<Path>,
        observed_at_unix_ms: u64,
    ) -> Result<LocalClient, AuthorityError> {
        validate_timestamp(observed_at_unix_ms)?;
        let label = normalize_label(label)?;
        if self.state.clients.len() >= MAX_CLIENTS {
            return Err(AuthorityError::Conflict(
                "local client registry is full".to_owned(),
            ));
        }

        let id = new_client_id()?;
        if self.state.clients.iter().any(|client| client.id == id) {
            return Err(AuthorityError::Conflict(
                "generated local client id already exists".to_owned(),
            ));
        }
        let token = new_client_token()?;
        let token_digest = digest_token(&token);
        let credential = LocalClientCredential {
            protocol: LOCAL_CLIENT_CREDENTIAL_PROTOCOL.to_owned(),
            client_id: id.clone(),
            role,
            token,
            issued_at_unix_ms: observed_at_unix_ms,
        };
        validate_credential(&credential)?;

        let credential_path = credential_path.as_ref();
        if credential_path == self.path.as_path() {
            return Err(AuthorityError::Invalid(
                "client credential output cannot replace the authority registry".to_owned(),
            ));
        }
        write_credential_file(credential_path, &credential)?;

        let mut next = self.state.clone();
        next.revision = next
            .revision
            .checked_add(1)
            .ok_or_else(|| AuthorityError::Invalid("registry revision overflowed".to_owned()))?;
        next.clients.push(StoredClient {
            protocol: LOCAL_CLIENT_PROTOCOL.to_owned(),
            id: id.clone(),
            role,
            label,
            token_digest,
            created_at_unix_ms: observed_at_unix_ms,
            revoked_at_unix_ms: None,
        });
        if let Err(error) = persist_registry(&self.path, &next) {
            let _ = fs::remove_file(credential_path);
            return Err(error);
        }
        self.state = next;
        self.get(&id)
    }

    pub fn revoke(
        &mut self,
        id: &str,
        observed_at_unix_ms: u64,
    ) -> Result<LocalClient, AuthorityError> {
        validate_timestamp(observed_at_unix_ms)?;
        let id = normalize_client_id(id)?;
        let index = self
            .state
            .clients
            .iter()
            .position(|client| client.id == id)
            .ok_or_else(|| AuthorityError::NotFound(id.clone()))?;
        let current = &self.state.clients[index];
        if current.revoked_at_unix_ms.is_some() {
            return Err(AuthorityError::Conflict(format!(
                "local client {id} is already revoked"
            )));
        }
        if observed_at_unix_ms < current.created_at_unix_ms {
            return Err(AuthorityError::Invalid(
                "client revocation time predates enrolment".to_owned(),
            ));
        }

        let mut next = self.state.clone();
        next.revision = next
            .revision
            .checked_add(1)
            .ok_or_else(|| AuthorityError::Invalid("registry revision overflowed".to_owned()))?;
        next.clients[index].revoked_at_unix_ms = Some(observed_at_unix_ms);
        persist_registry(&self.path, &next)?;
        self.state = next;
        self.get(&id)
    }

    pub fn verify_credential(
        &self,
        credential: &LocalClientCredential,
    ) -> Result<LocalClient, AuthorityError> {
        validate_credential(credential).map_err(|_| AuthorityError::CredentialRejected)?;
        let client = self
            .state
            .clients
            .iter()
            .find(|client| client.id == credential.client_id)
            .ok_or(AuthorityError::CredentialRejected)?;
        if client.revoked_at_unix_ms.is_some()
            || client.role != credential.role
            || client.created_at_unix_ms != credential.issued_at_unix_ms
            || !constant_time_equal(&client.token_digest, &digest_token(&credential.token))
        {
            return Err(AuthorityError::CredentialRejected);
        }
        Ok(client.public())
    }

    pub fn get(&self, id: &str) -> Result<LocalClient, AuthorityError> {
        let id = normalize_client_id(id)?;
        self.state
            .clients
            .iter()
            .find(|client| client.id == id)
            .map(StoredClient::public)
            .ok_or_else(|| AuthorityError::NotFound(id.to_owned()))
    }
}

pub fn read_credential_file(
    path: impl AsRef<Path>,
) -> Result<LocalClientCredential, AuthorityError> {
    let path = path.as_ref();
    validate_private_credential_file(path)?;
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_CREDENTIAL_BYTES {
        return Err(AuthorityError::Invalid(
            "local client credential exceeds its byte limit".to_owned(),
        ));
    }
    let credential: LocalClientCredential = serde_json::from_slice(&bytes)?;
    validate_credential(&credential)?;
    Ok(credential)
}

fn write_credential_file(
    path: &Path,
    credential: &LocalClientCredential,
) -> Result<(), AuthorityError> {
    validate_credential(credential)?;
    let parent = path.parent().ok_or_else(|| {
        AuthorityError::Invalid("client credential path has no parent".to_owned())
    })?;
    ensure_private_dir(parent)?;
    let mut bytes = serde_json::to_vec_pretty(credential)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_CREDENTIAL_BYTES {
        return Err(AuthorityError::Invalid(
            "local client credential exceeds its byte limit".to_owned(),
        ));
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            AuthorityError::Conflict("client credential output already exists".to_owned())
        } else {
            AuthorityError::Io(error)
        }
    })?;
    if let Err(error) = (|| -> Result<(), io::Error> {
        file.write_all(&bytes)?;
        file.sync_all()?;
        set_private_file(path)?;
        sync_parent(parent)?;
        Ok(())
    })() {
        let _ = fs::remove_file(path);
        return Err(AuthorityError::Io(error));
    }
    Ok(())
}

fn validate_private_credential_file(path: &Path) -> Result<(), AuthorityError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(AuthorityError::Invalid(
            "local client credential must be a regular file".to_owned(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(AuthorityError::Invalid(
                "local client credential must not be group- or world-accessible".to_owned(),
            ));
        }
    }
    Ok(())
}

fn load_registry(path: &Path) -> Result<ClientRegistryState, AuthorityError> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err(AuthorityError::Invalid(
            "local client registry exceeds its byte limit".to_owned(),
        ));
    }
    let registry = serde_json::from_slice(&bytes)?;
    validate_registry(&registry)?;
    Ok(registry)
}

fn validate_registry(registry: &ClientRegistryState) -> Result<(), AuthorityError> {
    if registry.protocol != LOCAL_CLIENT_REGISTRY_PROTOCOL {
        return Err(AuthorityError::Invalid(
            "local client registry protocol is unsupported".to_owned(),
        ));
    }
    if registry.clients.len() > MAX_CLIENTS {
        return Err(AuthorityError::Invalid(
            "local client registry contains too many clients".to_owned(),
        ));
    }
    if registry.clients.is_empty() && registry.revision != 0 {
        return Err(AuthorityError::Invalid(
            "empty local client registry has a non-zero revision".to_owned(),
        ));
    }
    let mut ids = HashSet::new();
    for client in &registry.clients {
        if client.protocol != LOCAL_CLIENT_PROTOCOL
            || normalize_client_id(&client.id)? != client.id
            || normalize_label(&client.label)? != client.label
            || !validate_digest(&client.token_digest)
            || client.created_at_unix_ms == 0
            || client
                .revoked_at_unix_ms
                .is_some_and(|revoked| revoked < client.created_at_unix_ms)
            || !ids.insert(client.id.clone())
        {
            return Err(AuthorityError::Invalid(
                "local client registry contains an invalid client".to_owned(),
            ));
        }
    }
    Ok(())
}

fn persist_registry(path: &Path, registry: &ClientRegistryState) -> Result<(), AuthorityError> {
    validate_registry(registry)?;
    let mut bytes = serde_json::to_vec_pretty(registry)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err(AuthorityError::Invalid(
            "local client registry exceeds its byte limit".to_owned(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AuthorityError::Invalid("local client registry has no parent".to_owned()))?;
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
        return Err(AuthorityError::Io(error));
    }
    Ok(())
}

fn take_string(arguments: &mut Map<String, Value>, key: &str) -> Result<String, AuthorityError> {
    match arguments.remove(key) {
        Some(Value::String(value)) => Ok(value),
        Some(mut value) => {
            zeroize_json_value(&mut value);
            Err(AuthorityError::CredentialRejected)
        }
        None => Err(AuthorityError::CredentialRejected),
    }
}

fn take_u64(arguments: &mut Map<String, Value>, key: &str) -> Result<u64, AuthorityError> {
    match arguments.remove(key) {
        Some(Value::Number(value)) => value.as_u64().ok_or(AuthorityError::CredentialRejected),
        Some(mut value) => {
            zeroize_json_value(&mut value);
            Err(AuthorityError::CredentialRejected)
        }
        None => Err(AuthorityError::CredentialRejected),
    }
}

fn zeroize_json_map(arguments: &mut Map<String, Value>) {
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
        Value::Object(values) => zeroize_json_map(values),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

fn validate_credential(credential: &LocalClientCredential) -> Result<(), AuthorityError> {
    if credential.protocol != LOCAL_CLIENT_CREDENTIAL_PROTOCOL
        || normalize_client_id(&credential.client_id)? != credential.client_id
        || !validate_token(&credential.token)
        || credential.issued_at_unix_ms == 0
    {
        return Err(AuthorityError::Invalid(
            "local client credential is invalid".to_owned(),
        ));
    }
    Ok(())
}

pub fn valid_client_id(value: &str) -> bool {
    value
        .strip_prefix(CLIENT_ID_PREFIX)
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(is_lower_hex))
}

pub fn valid_session_id(value: &str) -> bool {
    value
        .strip_prefix(SESSION_ID_PREFIX)
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(is_lower_hex))
}

fn normalize_client_id(value: &str) -> Result<String, AuthorityError> {
    if !valid_client_id(value) {
        return Err(AuthorityError::Invalid(
            "local client id is invalid".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn normalize_label(value: &str) -> Result<String, AuthorityError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 80 || value.chars().any(char::is_control) {
        return Err(AuthorityError::Invalid(
            "client label must be 1-80 visible characters".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn validate_timestamp(value: u64) -> Result<(), AuthorityError> {
    if value == 0 {
        return Err(AuthorityError::Invalid(
            "client timestamp must be positive".to_owned(),
        ));
    }
    Ok(())
}

fn validate_token(value: &str) -> bool {
    value
        .strip_prefix(TOKEN_PREFIX)
        .is_some_and(|suffix| suffix.len() == 64 && suffix.bytes().all(is_lower_hex))
}

fn validate_digest(value: &str) -> bool {
    value
        .strip_prefix(DIGEST_PREFIX)
        .is_some_and(|suffix| suffix.len() == 64 && suffix.bytes().all(is_lower_hex))
}

fn new_client_id() -> Result<String, AuthorityError> {
    let mut bytes = [0_u8; 16];
    getrandom(&mut bytes).map_err(|_| {
        AuthorityError::Invalid("secure client-id randomness is unavailable".to_owned())
    })?;
    Ok(format!("{CLIENT_ID_PREFIX}{}", lower_hex(&bytes)))
}

fn new_session_id() -> Result<String, AuthorityError> {
    let mut bytes = [0_u8; 16];
    getrandom(&mut bytes).map_err(|_| {
        AuthorityError::Invalid("secure session-id randomness is unavailable".to_owned())
    })?;
    Ok(format!("{SESSION_ID_PREFIX}{}", lower_hex(&bytes)))
}

fn new_client_token() -> Result<String, AuthorityError> {
    let mut bytes = [0_u8; 32];
    getrandom(&mut bytes).map_err(|_| {
        AuthorityError::Invalid("secure client-token randomness is unavailable".to_owned())
    })?;
    Ok(format!("{TOKEN_PREFIX}{}", lower_hex(&bytes)))
}

fn digest_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    format!("{DIGEST_PREFIX}{}", lower_hex(&digest))
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.bytes().zip(right.bytes()) {
        difference |= left ^ right;
    }
    difference == 0
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

fn ensure_private_dir(path: &Path) -> Result<(), AuthorityError> {
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_HOME: AtomicUsize = AtomicUsize::new(1);

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(label: &str) -> Self {
            let sequence = NEXT_HOME.fetch_add(1, Ordering::Relaxed);
            Self(std::env::temp_dir().join(format!(
                "greenways-authority-{label}-{}-{sequence}",
                process::id()
            )))
        }

        fn registry(&self) -> PathBuf {
            self.0.join("state").join("local-clients.json")
        }

        fn credential(&self) -> PathBuf {
            self.0.join("clients").join("client.json")
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn issues_a_private_credential_but_persists_only_its_digest() {
        let home = TestHome::new("issue");
        let mut registry =
            LocalClientRegistry::open(home.registry()).expect("registry should open");
        let client = registry
            .issue_to_file(
                LocalClientRole::Desktop,
                "Greenways Desktop",
                home.credential(),
                1_000,
            )
            .expect("client should be issued");
        let credential = read_credential_file(home.credential()).expect("credential should read");
        assert_eq!(credential.client_id, client.id);
        assert_eq!(credential.role, LocalClientRole::Desktop);
        assert_eq!(
            registry
                .verify_credential(&credential)
                .expect("credential should verify"),
            client
        );

        let registry_bytes = fs::read(home.registry()).expect("registry bytes");
        let registry_text = String::from_utf8_lossy(&registry_bytes);
        assert!(!registry_text.contains(&credential.token));
        assert!(!registry_text.contains(TOKEN_PREFIX));
        assert!(registry_text.contains(DIGEST_PREFIX));
        assert!(!format!("{credential:?}").contains(&credential.token));
        assert!(!format!("{registry:?}").contains(DIGEST_PREFIX));
    }

    #[test]
    fn rejects_changed_credentials_and_final_revocation_survives_restart() {
        let home = TestHome::new("revoke");
        let mut registry =
            LocalClientRegistry::open(home.registry()).expect("registry should open");
        let client = registry
            .issue_to_file(
                LocalClientRole::BrowserBridge,
                "Chrome bridge",
                home.credential(),
                1_000,
            )
            .expect("client should issue");
        let mut credential =
            read_credential_file(home.credential()).expect("credential should read");
        let original = credential.token.clone();
        credential
            .token
            .replace_range(4..5, if &original[4..5] == "0" { "1" } else { "0" });
        assert!(matches!(
            registry.verify_credential(&credential),
            Err(AuthorityError::CredentialRejected)
        ));
        credential.token.zeroize();
        credential = read_credential_file(home.credential()).expect("credential should reread");

        let revoked = registry
            .revoke(&client.id, 2_000)
            .expect("client should revoke");
        assert_eq!(revoked.revoked_at_unix_ms, Some(2_000));
        assert!(matches!(
            registry.verify_credential(&credential),
            Err(AuthorityError::CredentialRejected)
        ));
        drop(registry);

        let reopened = LocalClientRegistry::open(home.registry()).expect("registry should reopen");
        assert_eq!(reopened.active_client_count(), 0);
        assert_eq!(reopened.clients()[0].revoked_at_unix_ms, Some(2_000));
        assert!(matches!(
            reopened.verify_credential(&credential),
            Err(AuthorityError::CredentialRejected)
        ));
    }

    #[test]
    fn refuses_to_overwrite_a_credential_output_or_accept_malformed_state() {
        let home = TestHome::new("closed");
        let mut registry =
            LocalClientRegistry::open(home.registry()).expect("registry should open");
        registry
            .issue_to_file(LocalClientRole::Cli, "CLI", home.credential(), 1_000)
            .expect("first client should issue");
        assert!(matches!(
            registry.issue_to_file(
                LocalClientRole::Developer,
                "Developer",
                home.credential(),
                2_000,
            ),
            Err(AuthorityError::Conflict(_))
        ));
        assert_eq!(registry.clients().len(), 1);

        let mut state: serde_json::Value =
            serde_json::from_slice(&fs::read(home.registry()).expect("registry bytes"))
                .expect("registry JSON");
        state["clients"][0]["tokenDigest"] = serde_json::json!("not-a-digest");
        fs::write(
            home.registry(),
            serde_json::to_vec_pretty(&state).expect("tampered JSON"),
        )
        .expect("tampered registry should write");
        assert!(LocalClientRegistry::open(home.registry()).is_err());
    }

    #[test]
    fn creates_a_bounded_session_without_copying_the_credential() {
        let client = LocalClient {
            protocol: LOCAL_CLIENT_PROTOCOL.to_owned(),
            id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
            role: LocalClientRole::BrowserBridge,
            label: "Chrome bridge".to_owned(),
            created_at_unix_ms: 1_000,
            revoked_at_unix_ms: None,
        };
        let session =
            new_local_session(&client, 2_000, 300_000, 128).expect("session should be created");
        assert!(valid_session_id(&session.id));
        assert_eq!(session.client_id, client.id);
        assert_eq!(session.role, LocalClientRole::BrowserBridge);
        assert_eq!(session.expires_at_unix_ms, 302_000);
        assert_eq!(session.remaining_requests, 128);
        let encoded = serde_json::to_string(&session).expect("session should encode");
        assert!(!encoded.contains(TOKEN_PREFIX));
        validate_local_session(&session, &client.id, client.role).expect("session should validate");
        let mut changed = session.clone();
        changed.protocol = "greenways-local-session/changed".to_owned();
        assert!(validate_local_session(&changed, &client.id, client.role).is_err());
        assert!(new_local_session(&client, 2_000, 0, 128).is_err());
        assert!(new_local_session(&client, 2_000, 300_000, 0).is_err());
    }

    #[test]
    fn moves_a_session_credential_through_one_closed_argument_map() {
        let credential = LocalClientCredential {
            protocol: LOCAL_CLIENT_CREDENTIAL_PROTOCOL.to_owned(),
            client_id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
            role: LocalClientRole::Cli,
            token: "gwc_0000000000000000000000000000000000000000000000000000000000000000"
                .to_owned(),
            issued_at_unix_ms: 1_000,
        };
        let arguments = credential.into_session_arguments();
        let parsed = parse_local_client_credential_arguments(arguments)
            .expect("credential arguments should parse");
        assert_eq!(parsed.role, LocalClientRole::Cli);
        assert!(validate_token(&parsed.token));

        let mut extra = parsed.into_session_arguments();
        extra.insert("authority".to_owned(), Value::String("root".to_owned()));
        assert!(matches!(
            parse_local_client_credential_arguments(extra),
            Err(AuthorityError::CredentialRejected)
        ));
    }

    #[test]
    fn rejects_a_credential_path_that_would_replace_the_registry() {
        let home = TestHome::new("path-collision");
        let mut registry =
            LocalClientRegistry::open(home.registry()).expect("registry should open");
        assert!(matches!(
            registry.issue_to_file(LocalClientRole::Cli, "CLI", home.registry(), 1_000,),
            Err(AuthorityError::Invalid(_))
        ));
        assert!(!home.registry().exists());
        assert!(registry.clients().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_credential_file_with_broad_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let home = TestHome::new("broad-permissions");
        let mut registry =
            LocalClientRegistry::open(home.registry()).expect("registry should open");
        registry
            .issue_to_file(
                LocalClientRole::BrowserBridge,
                "Browser bridge",
                home.credential(),
                1_000,
            )
            .expect("client should issue");
        fs::set_permissions(home.credential(), fs::Permissions::from_mode(0o644))
            .expect("credential permissions should change");
        assert!(matches!(
            read_credential_file(home.credential()),
            Err(AuthorityError::Invalid(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_registry_and_credential_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let home = TestHome::new("permissions");
        let mut registry =
            LocalClientRegistry::open(home.registry()).expect("registry should open");
        registry
            .issue_to_file(LocalClientRole::Cli, "CLI", home.credential(), 1_000)
            .expect("client should issue");
        for path in [home.registry(), home.credential()] {
            assert_eq!(
                fs::metadata(path)
                    .expect("private file metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        for path in [
            home.registry()
                .parent()
                .expect("registry parent")
                .to_path_buf(),
            home.credential()
                .parent()
                .expect("credential parent")
                .to_path_buf(),
        ] {
            assert_eq!(
                fs::metadata(path)
                    .expect("private directory metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
        }
    }
}
