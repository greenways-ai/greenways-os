use greenways_protocol::{VaultStatus, VAULT_STATUS_PROTOCOL};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
    sync::Arc,
};
use zeroize::Zeroizing;

pub const PROVIDER_REGISTRY_PROTOCOL: &str = "greenways-provider-registry/0-alpha";
pub const PROVIDER_PROFILE_PROTOCOL: &str = "greenways-provider-profile/0-alpha";
pub const SYSTEM_CREDENTIAL_STORE: &str = "system-keyring";
const CREDENTIAL_SERVICE: &str = "ai.greenways.provider";
const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
const MAX_PROFILES: usize = 64;
pub const MAX_PROVIDER_SECRET_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Anthropic,
    OpenAi,
    OpenRouter,
}

impl ProviderKind {
    pub fn parse(value: &str) -> Result<Self, VaultError> {
        match value {
            "anthropic" => Ok(Self::Anthropic),
            "openai" => Ok(Self::OpenAi),
            "openrouter" => Ok(Self::OpenRouter),
            _ => Err(VaultError::Invalid(
                "provider must be anthropic, openai, or openrouter".to_owned(),
            )),
        }
    }

    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::OpenRouter => "openrouter",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderProfile {
    pub protocol: String,
    pub id: String,
    pub provider: ProviderKind,
    pub label: String,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    pub credential_custody: String,
}

#[derive(Debug)]
pub enum VaultError {
    Io(io::Error),
    Encoding(serde_json::Error),
    Invalid(String),
    Conflict(String),
    NotFound(String),
    CredentialUnavailable,
}

impl fmt::Display for VaultError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Greenways vault I/O failed: {error}"),
            Self::Encoding(_) => write!(formatter, "Greenways vault metadata is invalid"),
            Self::Invalid(message) => {
                write!(formatter, "Greenways vault input is invalid: {message}")
            }
            Self::Conflict(message) => write!(formatter, "Greenways vault conflict: {message}"),
            Self::NotFound(message) => {
                write!(formatter, "Greenways vault item was not found: {message}")
            }
            Self::CredentialUnavailable => write!(
                formatter,
                "The operating-system credential store could not complete the request"
            ),
        }
    }
}

impl Error for VaultError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Encoding(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for VaultError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for VaultError {
    fn from(value: serde_json::Error) -> Self {
        Self::Encoding(value)
    }
}

trait CredentialStore: Send + Sync {
    fn set(&self, profile_id: &str, secret: &[u8]) -> Result<(), VaultError>;
    fn get(&self, profile_id: &str) -> Result<Zeroizing<Vec<u8>>, VaultError>;
    fn delete(&self, profile_id: &str) -> Result<(), VaultError>;
}

#[derive(Debug, Default)]
struct SystemCredentialStore;

impl SystemCredentialStore {
    fn entry(profile_id: &str) -> Result<Entry, VaultError> {
        Entry::new(CREDENTIAL_SERVICE, profile_id).map_err(|_| VaultError::CredentialUnavailable)
    }
}

impl CredentialStore for SystemCredentialStore {
    fn set(&self, profile_id: &str, secret: &[u8]) -> Result<(), VaultError> {
        Self::entry(profile_id)?
            .set_secret(secret)
            .map_err(|_| VaultError::CredentialUnavailable)
    }

    fn get(&self, profile_id: &str) -> Result<Zeroizing<Vec<u8>>, VaultError> {
        Self::entry(profile_id)?
            .get_secret()
            .map(Zeroizing::new)
            .map_err(|_| VaultError::CredentialUnavailable)
    }

    fn delete(&self, profile_id: &str) -> Result<(), VaultError> {
        Self::entry(profile_id)?
            .delete_credential()
            .map_err(|_| VaultError::CredentialUnavailable)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProfile {
    protocol: String,
    id: String,
    provider: ProviderKind,
    label: String,
    created_at_unix_ms: u64,
    updated_at_unix_ms: u64,
}

impl StoredProfile {
    fn public(&self) -> ProviderProfile {
        ProviderProfile {
            protocol: PROVIDER_PROFILE_PROTOCOL.to_owned(),
            id: self.id.clone(),
            provider: self.provider,
            label: self.label.clone(),
            created_at_unix_ms: self.created_at_unix_ms,
            updated_at_unix_ms: self.updated_at_unix_ms,
            credential_custody: SYSTEM_CREDENTIAL_STORE.to_owned(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProviderRegistry {
    protocol: String,
    revision: u64,
    profiles: Vec<StoredProfile>,
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self {
            protocol: PROVIDER_REGISTRY_PROTOCOL.to_owned(),
            revision: 0,
            profiles: Vec::new(),
        }
    }
}

pub struct ProviderVault {
    metadata_path: PathBuf,
    registry: ProviderRegistry,
    credentials: Arc<dyn CredentialStore>,
}

impl fmt::Debug for ProviderVault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderVault")
            .field("metadata_path", &self.metadata_path)
            .field("profile_count", &self.registry.profiles.len())
            .field("credential_store", &SYSTEM_CREDENTIAL_STORE)
            .finish()
    }
}

impl ProviderVault {
    pub fn open_system(metadata_path: impl Into<PathBuf>) -> Result<Self, VaultError> {
        Self::open_with_store(metadata_path.into(), Arc::new(SystemCredentialStore))
    }

    fn open_with_store(
        metadata_path: PathBuf,
        credentials: Arc<dyn CredentialStore>,
    ) -> Result<Self, VaultError> {
        let registry = if metadata_path.exists() {
            load_registry(&metadata_path)?
        } else {
            ProviderRegistry::default()
        };
        validate_registry(&registry)?;
        Ok(Self {
            metadata_path,
            registry,
            credentials,
        })
    }

    pub fn status(&self) -> VaultStatus {
        VaultStatus {
            protocol: VAULT_STATUS_PROTOCOL.to_owned(),
            metadata_state: "ready".to_owned(),
            credential_store: SYSTEM_CREDENTIAL_STORE.to_owned(),
            provider_profile_count: self.registry.profiles.len() as u64,
            secret_projection: false,
        }
    }

    pub fn profiles(&self) -> Vec<ProviderProfile> {
        let mut profiles = self
            .registry
            .profiles
            .iter()
            .map(StoredProfile::public)
            .collect::<Vec<_>>();
        profiles.sort_by(|left, right| left.id.cmp(&right.id));
        profiles
    }

    pub fn add_profile(
        &mut self,
        id: &str,
        provider: ProviderKind,
        label: &str,
        secret: Vec<u8>,
        observed_at_unix_ms: u64,
    ) -> Result<ProviderProfile, VaultError> {
        let secret = Zeroizing::new(secret);
        validate_secret(secret.as_slice())?;
        let id = normalize_profile_id(id)?;
        let label = normalize_label(label)?;
        validate_timestamp(observed_at_unix_ms)?;
        if self
            .registry
            .profiles
            .iter()
            .any(|profile| profile.id == id)
        {
            return Err(VaultError::Conflict(format!(
                "provider profile {id} already exists"
            )));
        }
        if self.registry.profiles.len() >= MAX_PROFILES {
            return Err(VaultError::Conflict(
                "provider profile registry is full".to_owned(),
            ));
        }

        self.credentials.set(&id, secret.as_slice())?;
        let previous = self.registry.clone();
        self.registry.revision = self
            .registry
            .revision
            .checked_add(1)
            .ok_or_else(|| VaultError::Invalid("registry revision overflowed".to_owned()))?;
        self.registry.profiles.push(StoredProfile {
            protocol: PROVIDER_PROFILE_PROTOCOL.to_owned(),
            id: id.clone(),
            provider,
            label,
            created_at_unix_ms: observed_at_unix_ms,
            updated_at_unix_ms: observed_at_unix_ms,
        });
        if let Err(error) = persist_registry(&self.metadata_path, &self.registry) {
            self.registry = previous;
            let _ = self.credentials.delete(&id);
            return Err(error);
        }
        self.profile(&id)
    }

    pub fn rotate_profile(
        &mut self,
        id: &str,
        secret: Vec<u8>,
        observed_at_unix_ms: u64,
    ) -> Result<ProviderProfile, VaultError> {
        let secret = Zeroizing::new(secret);
        validate_secret(secret.as_slice())?;
        let id = normalize_profile_id(id)?;
        validate_timestamp(observed_at_unix_ms)?;
        let index = self
            .registry
            .profiles
            .iter()
            .position(|profile| profile.id == id)
            .ok_or_else(|| VaultError::NotFound(id.clone()))?;
        if observed_at_unix_ms < self.registry.profiles[index].updated_at_unix_ms {
            return Err(VaultError::Invalid(
                "credential rotation time predates the current profile".to_owned(),
            ));
        }

        let previous_secret = self.credentials.get(&id)?;
        self.credentials.set(&id, secret.as_slice())?;
        let previous = self.registry.clone();
        self.registry.revision = self
            .registry
            .revision
            .checked_add(1)
            .ok_or_else(|| VaultError::Invalid("registry revision overflowed".to_owned()))?;
        self.registry.profiles[index].updated_at_unix_ms = observed_at_unix_ms;
        if let Err(error) = persist_registry(&self.metadata_path, &self.registry) {
            self.registry = previous;
            let _ = self.credentials.set(&id, previous_secret.as_slice());
            return Err(error);
        }
        self.profile(&id)
    }

    pub fn remove_profile(&mut self, id: &str) -> Result<ProviderProfile, VaultError> {
        let id = normalize_profile_id(id)?;
        let index = self
            .registry
            .profiles
            .iter()
            .position(|profile| profile.id == id)
            .ok_or_else(|| VaultError::NotFound(id.clone()))?;
        let removed = self.registry.profiles[index].public();
        let previous_secret = self.credentials.get(&id)?;
        self.credentials.delete(&id)?;

        let previous = self.registry.clone();
        self.registry.revision = self
            .registry
            .revision
            .checked_add(1)
            .ok_or_else(|| VaultError::Invalid("registry revision overflowed".to_owned()))?;
        self.registry.profiles.remove(index);
        if let Err(error) = persist_registry(&self.metadata_path, &self.registry) {
            self.registry = previous;
            let _ = self.credentials.set(&id, previous_secret.as_slice());
            return Err(error);
        }
        Ok(removed)
    }

    fn profile(&self, id: &str) -> Result<ProviderProfile, VaultError> {
        self.registry
            .profiles
            .iter()
            .find(|profile| profile.id == id)
            .map(StoredProfile::public)
            .ok_or_else(|| VaultError::NotFound(id.to_owned()))
    }
}

fn normalize_profile_id(value: &str) -> Result<String, VaultError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 80
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        })
        || !value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        || !value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
    {
        return Err(VaultError::Invalid(
            "profile id must use 1-80 lowercase letters, numbers, dots, or dashes".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn normalize_label(value: &str) -> Result<String, VaultError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 80 || value.chars().any(char::is_control) {
        return Err(VaultError::Invalid(
            "profile label must be 1-80 visible characters".to_owned(),
        ));
    }
    Ok(value.to_owned())
}

fn validate_secret(secret: &[u8]) -> Result<(), VaultError> {
    if secret.len() < 8 || secret.len() > MAX_PROVIDER_SECRET_BYTES {
        return Err(VaultError::Invalid(format!(
            "provider credential must be 8-{MAX_PROVIDER_SECRET_BYTES} bytes"
        )));
    }
    if secret.iter().any(|byte| matches!(byte, 0 | b'\r' | b'\n')) {
        return Err(VaultError::Invalid(
            "provider credential cannot contain NUL or line breaks".to_owned(),
        ));
    }
    Ok(())
}

fn validate_timestamp(value: u64) -> Result<(), VaultError> {
    if value == 0 {
        return Err(VaultError::Invalid(
            "provider profile timestamp must be positive".to_owned(),
        ));
    }
    Ok(())
}

fn load_registry(path: &Path) -> Result<ProviderRegistry, VaultError> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err(VaultError::Invalid(
            "provider registry exceeds its byte limit".to_owned(),
        ));
    }
    let registry = serde_json::from_slice(&bytes)?;
    validate_registry(&registry)?;
    Ok(registry)
}

fn validate_registry(registry: &ProviderRegistry) -> Result<(), VaultError> {
    if registry.protocol != PROVIDER_REGISTRY_PROTOCOL {
        return Err(VaultError::Invalid(
            "provider registry protocol is unsupported".to_owned(),
        ));
    }
    if registry.profiles.len() > MAX_PROFILES {
        return Err(VaultError::Invalid(
            "provider registry contains too many profiles".to_owned(),
        ));
    }
    let mut ids = HashSet::new();
    for profile in &registry.profiles {
        if profile.protocol != PROVIDER_PROFILE_PROTOCOL
            || normalize_profile_id(&profile.id)? != profile.id
            || normalize_label(&profile.label)? != profile.label
            || profile.created_at_unix_ms == 0
            || profile.updated_at_unix_ms < profile.created_at_unix_ms
            || !ids.insert(profile.id.clone())
        {
            return Err(VaultError::Invalid(
                "provider registry contains an invalid profile".to_owned(),
            ));
        }
    }
    Ok(())
}

fn persist_registry(path: &Path, registry: &ProviderRegistry) -> Result<(), VaultError> {
    validate_registry(registry)?;
    let mut bytes = serde_json::to_vec_pretty(registry)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err(VaultError::Invalid(
            "provider registry exceeds its byte limit".to_owned(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| VaultError::Invalid("provider registry has no parent".to_owned()))?;
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

fn ensure_private_dir(path: &Path) -> Result<(), VaultError> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file(path: &Path) -> Result<(), VaultError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    let _ = path;
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), VaultError> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::HashMap, sync::Mutex};

    #[derive(Default)]
    struct MemoryCredentialStore {
        values: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn set(&self, profile_id: &str, secret: &[u8]) -> Result<(), VaultError> {
            self.values
                .lock()
                .expect("memory credential store lock")
                .insert(profile_id.to_owned(), secret.to_vec());
            Ok(())
        }

        fn get(&self, profile_id: &str) -> Result<Zeroizing<Vec<u8>>, VaultError> {
            self.values
                .lock()
                .expect("memory credential store lock")
                .get(profile_id)
                .cloned()
                .map(Zeroizing::new)
                .ok_or(VaultError::CredentialUnavailable)
        }

        fn delete(&self, profile_id: &str) -> Result<(), VaultError> {
            self.values
                .lock()
                .expect("memory credential store lock")
                .remove(profile_id)
                .map(|_| ())
                .ok_or(VaultError::CredentialUnavailable)
        }
    }

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(label: &str) -> Self {
            Self(std::env::temp_dir().join(format!("greenways-vault-{label}-{}", process::id())))
        }

        fn registry(&self) -> PathBuf {
            self.0.join("providers.json")
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn open_memory(home: &TestHome) -> (ProviderVault, Arc<MemoryCredentialStore>) {
        let store = Arc::new(MemoryCredentialStore::default());
        let vault = ProviderVault::open_with_store(home.registry(), store.clone())
            .expect("memory vault should open");
        (vault, store)
    }

    #[test]
    fn stores_provider_metadata_without_serialising_the_secret() {
        let home = TestHome::new("redaction");
        let (mut vault, store) = open_memory(&home);
        let secret = b"sk-provider-secret-123".to_vec();
        let profile = vault
            .add_profile(
                "openai.personal",
                ProviderKind::OpenAi,
                "Personal OpenAI",
                secret.clone(),
                1_000,
            )
            .expect("profile should be added");
        assert_eq!(profile.id, "openai.personal");
        assert_eq!(vault.status().provider_profile_count, 1);
        assert!(!vault.status().secret_projection);
        let bytes = fs::read(home.registry()).expect("registry should be written");
        assert!(!bytes
            .windows(secret.len())
            .any(|window| window == secret.as_slice()));
        assert!(!String::from_utf8_lossy(&bytes).contains("credentialHandle"));
        assert_eq!(
            store
                .values
                .lock()
                .expect("store lock")
                .get("openai.personal")
                .expect("secret should be stored"),
            &secret
        );
        assert!(!format!("{vault:?}").contains("sk-provider-secret"));
    }

    #[test]
    fn rotates_and_removes_credentials_without_changing_profile_identity() {
        let home = TestHome::new("rotation");
        let (mut vault, store) = open_memory(&home);
        vault
            .add_profile(
                "anthropic.work",
                ProviderKind::Anthropic,
                "Work Anthropic",
                b"initial-secret-123".to_vec(),
                1_000,
            )
            .expect("profile should be added");
        let rotated = vault
            .rotate_profile("anthropic.work", b"rotated-secret-456".to_vec(), 2_000)
            .expect("profile should rotate");
        assert_eq!(rotated.created_at_unix_ms, 1_000);
        assert_eq!(rotated.updated_at_unix_ms, 2_000);
        assert_eq!(vault.profiles().len(), 1);
        assert_eq!(
            store
                .values
                .lock()
                .expect("store lock")
                .get("anthropic.work")
                .expect("rotated credential"),
            b"rotated-secret-456"
        );
        let removed = vault
            .remove_profile("anthropic.work")
            .expect("profile should be removed");
        assert_eq!(removed.id, "anthropic.work");
        assert!(vault.profiles().is_empty());
        assert!(!store
            .values
            .lock()
            .expect("store lock")
            .contains_key("anthropic.work"));
    }

    #[test]
    fn rejects_duplicate_profiles_and_secret_shaped_metadata() {
        let home = TestHome::new("validation");
        let (mut vault, _) = open_memory(&home);
        vault
            .add_profile(
                "openrouter.personal",
                ProviderKind::OpenRouter,
                "OpenRouter",
                b"openrouter-secret".to_vec(),
                1_000,
            )
            .expect("profile should be added");
        assert!(matches!(
            vault.add_profile(
                "openrouter.personal",
                ProviderKind::OpenRouter,
                "Duplicate",
                b"different-secret".to_vec(),
                2_000,
            ),
            Err(VaultError::Conflict(_))
        ));
        assert!(ProviderKind::parse("caller-selected").is_err());
        assert!(vault
            .add_profile(
                "UPPERCASE",
                ProviderKind::OpenAi,
                "Invalid",
                b"valid-secret".to_vec(),
                2_000,
            )
            .is_err());
        assert!(vault
            .rotate_profile("openrouter.personal", b"short".to_vec(), 3_000)
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_registry_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let home = TestHome::new("permissions");
        let (mut vault, _) = open_memory(&home);
        vault
            .add_profile(
                "openai.private",
                ProviderKind::OpenAi,
                "Private",
                b"private-secret-123".to_vec(),
                1_000,
            )
            .expect("profile should be added");
        assert_eq!(
            fs::metadata(home.registry())
                .expect("registry metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(home.registry().parent().expect("registry parent"))
                .expect("parent metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
