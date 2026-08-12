use base64ct::{Base64UrlUnpadded, Encoding};
use getrandom::getrandom;
use keyring::Entry;
use p256::{
    ecdsa::{
        signature::{Signer, Verifier},
        Signature, SigningKey, VerifyingKey,
    },
    pkcs8::{DecodePrivateKey, EncodePrivateKey},
    SecretKey,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
    sync::Arc,
};
use zeroize::{Zeroize, Zeroizing};

#[cfg(feature = "test-support")]
use std::sync::Mutex;

pub const PROFILE_IDENTITY_STATE_PROTOCOL: &str = "greenways-profile-identity-state/0-alpha";
pub const PROFILE_IDENTITY_PROTOCOL: &str = "greenways-profile-identity/0-alpha";
pub const SIGNED_PROFILE_IDENTITY_PROTOCOL: &str = "greenways-signed-profile-identity/0-alpha";
pub const PROFILE_IDENTITY_SUBJECT_PROTOCOL: &str = "greenways-profile-identity-subject/0-alpha";
pub const PROFILE_IDENTITY_STATUS_PROTOCOL: &str = "greenways-profile-identity-status/0-alpha";
pub const CAPABILITY_GRANT_PROTOCOL: &str = "greenways-capability-grant/0-alpha";
pub const SIGNED_CAPABILITY_GRANT_PROTOCOL: &str = "greenways-signed-capability-grant/0-alpha";
pub const CAPABILITY_GRANT_SUBJECT_PROTOCOL: &str = "greenways-capability-grant-subject/0-alpha";
pub const CAPABILITY_REVOCATION_PROTOCOL: &str = "greenways-capability-revocation/0-alpha";
pub const SIGNED_CAPABILITY_REVOCATION_PROTOCOL: &str =
    "greenways-signed-capability-revocation/0-alpha";
pub const CAPABILITY_REVOCATION_SUBJECT_PROTOCOL: &str =
    "greenways-capability-revocation-subject/0-alpha";
pub const APPLICATION_APPROVAL_PROTOCOL: &str = "greenways-application-approval/0-alpha";
pub const SIGNED_APPLICATION_APPROVAL_PROTOCOL: &str =
    "greenways-signed-application-approval/0-alpha";
pub const APPLICATION_APPROVAL_SUBJECT_PROTOCOL: &str =
    "greenways-application-approval-subject/0-alpha";
pub const APPLICATION_REVOCATION_PROTOCOL: &str = "greenways-application-revocation/0-alpha";
pub const SIGNED_APPLICATION_REVOCATION_PROTOCOL: &str =
    "greenways-signed-application-revocation/0-alpha";
pub const APPLICATION_REVOCATION_SUBJECT_PROTOCOL: &str =
    "greenways-application-revocation-subject/0-alpha";
pub const PROFILE_IDENTITY_ALGORITHM: &str = "p256-sha256-fixed";

#[cfg(feature = "test-support")]
pub const DIGEST_TEST_VALUE: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
pub const SYSTEM_IDENTITY_KEY_STORE: &str = "system-keyring";

const KEY_SERVICE: &str = "ai.greenways.profile-identity";
const IDENTITY_PREFIX: &str = "identity/";
const CAPABILITY_GRANT_PREFIX: &str = "grant/";
const CAPABILITY_REVOCATION_PREFIX: &str = "revocation/";
const APPLICATION_REVOCATION_PREFIX: &str = "application-revocation/";
const KEY_HANDLE_PREFIX: &str = "profile-key-";
const DIGEST_PREFIX: &str = "sha256:";
const MAX_STATE_BYTES: usize = 512 * 1024;
const MAX_HANDLE_BYTES: usize = 48;
const MAX_CONSTRAINTS: usize = 32;
const MAX_CONSTRAINT_TEXT_BYTES: usize = 240;
const MAX_DECLARED_CAPABILITIES: usize = 64;
const MAX_REVOCATION_REASON_BYTES: usize = 160;
const PRIVATE_KEY_BYTES_LIMIT: usize = 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileIdentityPublicKey {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileIdentityCard {
    pub protocol: String,
    pub id: String,
    pub handle: String,
    pub key_id: String,
    pub algorithm: String,
    pub public_key: ProfileIdentityPublicKey,
    pub created_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedProfileIdentity {
    pub protocol: String,
    pub subject: ProfileIdentityCard,
    pub subject_root: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileIdentityStatus {
    pub protocol: String,
    pub state: String,
    pub key_custody: String,
    pub identity_id: Option<String>,
    pub key_id: Option<String>,
    pub algorithm: String,
    pub private_key_projection: bool,
    pub typed_subjects: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationDescriptor {
    pub app_id: String,
    pub version: String,
    pub publisher_id: String,
    pub manifest_digest: String,
    pub lock_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationApprovalRequest {
    pub application: ApplicationDescriptor,
    pub declared_capabilities: Vec<String>,
    pub approved_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationApprovalBody {
    pub protocol: String,
    pub application: ApplicationDescriptor,
    pub declared_capabilities: Vec<String>,
    pub approved_at_unix_ms: u64,
    pub issuer_identity_id: String,
    pub issuer_key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedApplicationApproval {
    pub protocol: String,
    pub approval: ApplicationApprovalBody,
    pub issuer: SignedProfileIdentity,
    pub subject_root: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationRevocationRequest {
    pub id: String,
    pub approval_subject_root: String,
    pub application: ApplicationDescriptor,
    pub reason: String,
    pub revoked_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationRevocationBody {
    pub protocol: String,
    pub id: String,
    pub approval_subject_root: String,
    pub application: ApplicationDescriptor,
    pub reason: String,
    pub revoked_at_unix_ms: u64,
    pub issuer_identity_id: String,
    pub issuer_key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedApplicationRevocation {
    pub protocol: String,
    pub revocation: ApplicationRevocationBody,
    pub issuer: SignedProfileIdentity,
    pub subject_root: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationApprovalSubject {
    pub kind: String,
    pub app_id: String,
    pub version: String,
    pub publisher_id: String,
    pub lock_digest: Option<String>,
    pub approval_digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum CapabilityConstraintValue {
    Bool(bool),
    Integer(u64),
    Text(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityGrantRequest {
    pub id: String,
    pub capability: String,
    pub subject: ApplicationApprovalSubject,
    #[serde(default)]
    pub constraints: BTreeMap<String, CapabilityConstraintValue>,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityGrantBody {
    pub protocol: String,
    pub id: String,
    pub capability: String,
    pub subject: ApplicationApprovalSubject,
    pub constraints: BTreeMap<String, CapabilityConstraintValue>,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: Option<u64>,
    pub issuer_identity_id: String,
    pub issuer_key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedCapabilityGrant {
    pub protocol: String,
    pub grant: CapabilityGrantBody,
    pub issuer: SignedProfileIdentity,
    pub subject_root: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityRevocationRequest {
    pub id: String,
    pub grant_id: String,
    pub grant_subject_root: String,
    pub reason: String,
    pub revoked_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityRevocationBody {
    pub protocol: String,
    pub id: String,
    pub grant_id: String,
    pub grant_subject_root: String,
    pub reason: String,
    pub revoked_at_unix_ms: u64,
    pub issuer_identity_id: String,
    pub issuer_key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignedCapabilityRevocation {
    pub protocol: String,
    pub revocation: CapabilityRevocationBody,
    pub issuer: SignedProfileIdentity,
    pub subject_root: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredProfileIdentity {
    protocol: String,
    revision: u64,
    key_handle: String,
    signed_identity: SignedProfileIdentity,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileIdentitySubject<'a> {
    protocol: &'static str,
    identity: &'a ProfileIdentityCard,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationApprovalTypedSubject<'a> {
    protocol: &'static str,
    approval: &'a ApplicationApprovalBody,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplicationRevocationTypedSubject<'a> {
    protocol: &'static str,
    revocation: &'a ApplicationRevocationBody,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityGrantSubject<'a> {
    protocol: &'static str,
    grant: &'a CapabilityGrantBody,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityRevocationSubject<'a> {
    protocol: &'static str,
    revocation: &'a CapabilityRevocationBody,
}

#[derive(Debug)]
pub enum IdentityError {
    Io(io::Error),
    Encoding(serde_json::Error),
    Invalid(String),
    Conflict(String),
    KeyStoreUnavailable,
    CryptographyUnavailable,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Greenways identity I/O failed: {error}"),
            Self::Encoding(_) => formatter.write_str("Greenways identity metadata is invalid"),
            Self::Invalid(message) => write!(formatter, "Greenways identity is invalid: {message}"),
            Self::Conflict(message) => write!(formatter, "Greenways identity conflict: {message}"),
            Self::KeyStoreUnavailable => formatter.write_str(
                "The operating-system identity key store could not complete the request",
            ),
            Self::CryptographyUnavailable => {
                formatter.write_str("Greenways profile identity cryptography is unavailable")
            }
        }
    }
}

impl Error for IdentityError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Encoding(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for IdentityError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for IdentityError {
    fn from(value: serde_json::Error) -> Self {
        Self::Encoding(value)
    }
}

trait ProfileKeyStore: Send + Sync {
    fn set(&self, handle: &str, private_key: &[u8]) -> Result<(), IdentityError>;
    fn get(&self, handle: &str) -> Result<Zeroizing<Vec<u8>>, IdentityError>;
    fn delete(&self, handle: &str) -> Result<(), IdentityError>;
}

#[derive(Debug, Default)]
struct SystemProfileKeyStore;

#[cfg(feature = "test-support")]
#[derive(Debug, Default)]
struct TestProfileKeyStore {
    values: Mutex<BTreeMap<String, Vec<u8>>>,
}

#[cfg(feature = "test-support")]
impl ProfileKeyStore for TestProfileKeyStore {
    fn set(&self, handle: &str, private_key: &[u8]) -> Result<(), IdentityError> {
        self.values
            .lock()
            .map_err(|_| IdentityError::KeyStoreUnavailable)?
            .insert(handle.to_owned(), private_key.to_vec());
        Ok(())
    }

    fn get(&self, handle: &str) -> Result<Zeroizing<Vec<u8>>, IdentityError> {
        self.values
            .lock()
            .map_err(|_| IdentityError::KeyStoreUnavailable)?
            .get(handle)
            .cloned()
            .map(Zeroizing::new)
            .ok_or(IdentityError::KeyStoreUnavailable)
    }

    fn delete(&self, handle: &str) -> Result<(), IdentityError> {
        self.values
            .lock()
            .map_err(|_| IdentityError::KeyStoreUnavailable)?
            .remove(handle)
            .map(|_| ())
            .ok_or(IdentityError::KeyStoreUnavailable)
    }
}

impl SystemProfileKeyStore {
    fn entry(handle: &str) -> Result<Entry, IdentityError> {
        Entry::new(KEY_SERVICE, handle).map_err(|_| IdentityError::KeyStoreUnavailable)
    }
}

impl ProfileKeyStore for SystemProfileKeyStore {
    fn set(&self, handle: &str, private_key: &[u8]) -> Result<(), IdentityError> {
        Self::entry(handle)?
            .set_secret(private_key)
            .map_err(|_| IdentityError::KeyStoreUnavailable)
    }

    fn get(&self, handle: &str) -> Result<Zeroizing<Vec<u8>>, IdentityError> {
        Self::entry(handle)?
            .get_secret()
            .map(Zeroizing::new)
            .map_err(|_| IdentityError::KeyStoreUnavailable)
    }

    fn delete(&self, handle: &str) -> Result<(), IdentityError> {
        Self::entry(handle)?
            .delete_credential()
            .map_err(|_| IdentityError::KeyStoreUnavailable)
    }
}

pub struct ProfileIdentityVault {
    metadata_path: PathBuf,
    state: Option<StoredProfileIdentity>,
    keys: Arc<dyn ProfileKeyStore>,
}

impl fmt::Debug for ProfileIdentityVault {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProfileIdentityVault")
            .field("metadata_path", &self.metadata_path)
            .field("configured", &self.state.is_some())
            .field("key_custody", &SYSTEM_IDENTITY_KEY_STORE)
            .finish()
    }
}

impl ProfileIdentityVault {
    pub fn open_system(metadata_path: impl Into<PathBuf>) -> Result<Self, IdentityError> {
        Self::open_with_store(metadata_path.into(), Arc::new(SystemProfileKeyStore))
    }

    #[cfg(feature = "test-support")]
    pub fn open_test(metadata_path: impl Into<PathBuf>) -> Result<Self, IdentityError> {
        Self::open_with_store(
            metadata_path.into(),
            Arc::new(TestProfileKeyStore::default()),
        )
    }

    fn open_with_store(
        metadata_path: PathBuf,
        keys: Arc<dyn ProfileKeyStore>,
    ) -> Result<Self, IdentityError> {
        let state = if metadata_path.exists() {
            Some(load_state(&metadata_path)?)
        } else {
            None
        };
        if let Some(state) = &state {
            validate_state(state)?;
        }
        Ok(Self {
            metadata_path,
            state,
            keys,
        })
    }

    pub fn status(&self) -> ProfileIdentityStatus {
        ProfileIdentityStatus {
            protocol: PROFILE_IDENTITY_STATUS_PROTOCOL.to_owned(),
            state: if self.state.is_some() {
                "configured"
            } else {
                "unconfigured"
            }
            .to_owned(),
            key_custody: SYSTEM_IDENTITY_KEY_STORE.to_owned(),
            identity_id: self
                .state
                .as_ref()
                .map(|state| state.signed_identity.subject.id.clone()),
            key_id: self
                .state
                .as_ref()
                .map(|state| state.signed_identity.subject.key_id.clone()),
            algorithm: PROFILE_IDENTITY_ALGORITHM.to_owned(),
            private_key_projection: false,
            typed_subjects: vec![
                PROFILE_IDENTITY_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_GRANT_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_REVOCATION_SUBJECT_PROTOCOL.to_owned(),
                APPLICATION_APPROVAL_SUBJECT_PROTOCOL.to_owned(),
                APPLICATION_REVOCATION_SUBJECT_PROTOCOL.to_owned(),
            ],
        }
    }

    pub fn public_identity(&self) -> Option<SignedProfileIdentity> {
        self.state
            .as_ref()
            .map(|state| state.signed_identity.clone())
    }

    pub fn create(
        &mut self,
        handle: &str,
        observed_at_unix_ms: u64,
    ) -> Result<SignedProfileIdentity, IdentityError> {
        if self.state.is_some() || self.metadata_path.exists() {
            return Err(IdentityError::Conflict(
                "a Greenways profile identity already exists".to_owned(),
            ));
        }
        let handle = normalize_handle(handle)?;
        validate_timestamp(observed_at_unix_ms)?;

        let mut scalar = [0_u8; 32];
        let secret_key = generate_secret_key(&mut scalar)?;
        scalar.zeroize();
        let signing_key = SigningKey::from_bytes(&secret_key.to_bytes())
            .map_err(|_| IdentityError::CryptographyUnavailable)?;
        let verifying_key = VerifyingKey::from(&signing_key);
        let public_key = public_jwk(&verifying_key)?;
        let key_id = digest_json(&public_key)?;
        let card = ProfileIdentityCard {
            protocol: PROFILE_IDENTITY_PROTOCOL.to_owned(),
            id: random_identifier(IDENTITY_PREFIX)?,
            handle,
            key_id,
            algorithm: PROFILE_IDENTITY_ALGORITHM.to_owned(),
            public_key,
            created_at_unix_ms: observed_at_unix_ms,
        };
        let signed_identity = sign_profile_identity(&card, &signing_key)?;
        verify_signed_profile_identity(&signed_identity)?;

        let key_handle = random_identifier(KEY_HANDLE_PREFIX)?;
        let private_document = secret_key
            .to_pkcs8_der()
            .map_err(|_| IdentityError::CryptographyUnavailable)?;
        if private_document.as_bytes().len() > PRIVATE_KEY_BYTES_LIMIT {
            return Err(IdentityError::CryptographyUnavailable);
        }
        self.keys.set(&key_handle, private_document.as_bytes())?;

        let state = StoredProfileIdentity {
            protocol: PROFILE_IDENTITY_STATE_PROTOCOL.to_owned(),
            revision: 1,
            key_handle: key_handle.clone(),
            signed_identity: signed_identity.clone(),
        };
        if let Err(error) = persist_state(&self.metadata_path, &state) {
            let _ = self.keys.delete(&key_handle);
            return Err(error);
        }
        self.state = Some(state);
        Ok(signed_identity)
    }

    fn load_signing_key(&self) -> Result<SigningKey, IdentityError> {
        let state = self.state.as_ref().ok_or_else(|| {
            IdentityError::Invalid("profile identity is not configured".to_owned())
        })?;
        let private_bytes = self.keys.get(&state.key_handle)?;
        if private_bytes.len() > PRIVATE_KEY_BYTES_LIMIT {
            return Err(IdentityError::CryptographyUnavailable);
        }
        let secret_key = SecretKey::from_pkcs8_der(private_bytes.as_slice())
            .map_err(|_| IdentityError::CryptographyUnavailable)?;
        let signing_key = SigningKey::from_bytes(&secret_key.to_bytes())
            .map_err(|_| IdentityError::CryptographyUnavailable)?;
        let public_key = public_jwk(&VerifyingKey::from(&signing_key))?;
        if public_key != state.signed_identity.subject.public_key
            || digest_json(&public_key)? != state.signed_identity.subject.key_id
        {
            return Err(IdentityError::Invalid(
                "profile identity private key does not match its public card".to_owned(),
            ));
        }
        Ok(signing_key)
    }

    #[allow(dead_code)]
    fn verify_private_key_binding(&self) -> Result<(), IdentityError> {
        self.load_signing_key().map(|_| ())
    }

    pub fn sign_application_approval(
        &self,
        request: ApplicationApprovalRequest,
    ) -> Result<SignedApplicationApproval, IdentityError> {
        let issuer = self.public_identity().ok_or_else(|| {
            IdentityError::Invalid("profile identity is not configured".to_owned())
        })?;
        let approval = ApplicationApprovalBody {
            protocol: APPLICATION_APPROVAL_PROTOCOL.to_owned(),
            application: request.application,
            declared_capabilities: normalize_declared_capabilities(&request.declared_capabilities)?,
            approved_at_unix_ms: request.approved_at_unix_ms,
            issuer_identity_id: issuer.subject.id.clone(),
            issuer_key_id: issuer.subject.key_id.clone(),
        };
        validate_application_approval_body(&approval)?;
        let bytes = application_approval_subject_bytes(&approval)?;
        let signing_key = self.load_signing_key()?;
        let signature: Signature = signing_key.sign(&bytes);
        let signed = SignedApplicationApproval {
            protocol: SIGNED_APPLICATION_APPROVAL_PROTOCOL.to_owned(),
            approval,
            issuer,
            subject_root: digest_bytes(&bytes),
            signature: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
        };
        verify_signed_application_approval(&signed)?;
        Ok(signed)
    }

    pub fn sign_application_revocation(
        &self,
        request: ApplicationRevocationRequest,
    ) -> Result<SignedApplicationRevocation, IdentityError> {
        let issuer = self.public_identity().ok_or_else(|| {
            IdentityError::Invalid("profile identity is not configured".to_owned())
        })?;
        let revocation = ApplicationRevocationBody {
            protocol: APPLICATION_REVOCATION_PROTOCOL.to_owned(),
            id: request.id,
            approval_subject_root: request.approval_subject_root,
            application: request.application,
            reason: request.reason,
            revoked_at_unix_ms: request.revoked_at_unix_ms,
            issuer_identity_id: issuer.subject.id.clone(),
            issuer_key_id: issuer.subject.key_id.clone(),
        };
        validate_application_revocation_body(&revocation)?;
        let bytes = application_revocation_subject_bytes(&revocation)?;
        let signing_key = self.load_signing_key()?;
        let signature: Signature = signing_key.sign(&bytes);
        let signed = SignedApplicationRevocation {
            protocol: SIGNED_APPLICATION_REVOCATION_PROTOCOL.to_owned(),
            revocation,
            issuer,
            subject_root: digest_bytes(&bytes),
            signature: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
        };
        verify_signed_application_revocation(&signed)?;
        Ok(signed)
    }

    pub fn sign_capability_grant(
        &self,
        request: CapabilityGrantRequest,
    ) -> Result<SignedCapabilityGrant, IdentityError> {
        let issuer = self.public_identity().ok_or_else(|| {
            IdentityError::Invalid("profile identity is not configured".to_owned())
        })?;
        let grant = CapabilityGrantBody {
            protocol: CAPABILITY_GRANT_PROTOCOL.to_owned(),
            id: request.id,
            capability: request.capability,
            subject: request.subject,
            constraints: request.constraints,
            issued_at_unix_ms: request.issued_at_unix_ms,
            expires_at_unix_ms: request.expires_at_unix_ms,
            issuer_identity_id: issuer.subject.id.clone(),
            issuer_key_id: issuer.subject.key_id.clone(),
        };
        validate_capability_grant_body(&grant)?;
        let bytes = capability_grant_subject_bytes(&grant)?;
        let signing_key = self.load_signing_key()?;
        let signature: Signature = signing_key.sign(&bytes);
        let signed = SignedCapabilityGrant {
            protocol: SIGNED_CAPABILITY_GRANT_PROTOCOL.to_owned(),
            grant,
            issuer,
            subject_root: digest_bytes(&bytes),
            signature: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
        };
        verify_signed_capability_grant(&signed)?;
        Ok(signed)
    }

    pub fn sign_capability_revocation(
        &self,
        request: CapabilityRevocationRequest,
    ) -> Result<SignedCapabilityRevocation, IdentityError> {
        let issuer = self.public_identity().ok_or_else(|| {
            IdentityError::Invalid("profile identity is not configured".to_owned())
        })?;
        let revocation = CapabilityRevocationBody {
            protocol: CAPABILITY_REVOCATION_PROTOCOL.to_owned(),
            id: request.id,
            grant_id: request.grant_id,
            grant_subject_root: request.grant_subject_root,
            reason: request.reason,
            revoked_at_unix_ms: request.revoked_at_unix_ms,
            issuer_identity_id: issuer.subject.id.clone(),
            issuer_key_id: issuer.subject.key_id.clone(),
        };
        validate_capability_revocation_body(&revocation)?;
        let bytes = capability_revocation_subject_bytes(&revocation)?;
        let signing_key = self.load_signing_key()?;
        let signature: Signature = signing_key.sign(&bytes);
        let signed = SignedCapabilityRevocation {
            protocol: SIGNED_CAPABILITY_REVOCATION_PROTOCOL.to_owned(),
            revocation,
            issuer,
            subject_root: digest_bytes(&bytes),
            signature: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
        };
        verify_signed_capability_revocation(&signed)?;
        Ok(signed)
    }
}

pub fn new_capability_grant_id() -> Result<String, IdentityError> {
    random_identifier(CAPABILITY_GRANT_PREFIX)
}

pub fn new_capability_revocation_id() -> Result<String, IdentityError> {
    random_identifier(CAPABILITY_REVOCATION_PREFIX)
}

pub fn new_application_revocation_id() -> Result<String, IdentityError> {
    random_identifier(APPLICATION_REVOCATION_PREFIX)
}

pub fn normalize_operation_capability(value: &str) -> Result<String, IdentityError> {
    let value = value.trim().to_ascii_lowercase();
    let mut parts = value.split('/');
    let valid = matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some(left), Some(right), None)
            if valid_identifier(left) && valid_identifier(right)
    );
    if !valid {
        return Err(IdentityError::Invalid(
            "operation capability is invalid".to_owned(),
        ));
    }
    Ok(value)
}

pub fn normalize_declared_capabilities(values: &[String]) -> Result<Vec<String>, IdentityError> {
    if values.len() > MAX_DECLARED_CAPABILITIES {
        return Err(IdentityError::Invalid(
            "application declares too many capabilities".to_owned(),
        ));
    }
    let mut normalized = values
        .iter()
        .map(|value| normalize_operation_capability(value))
        .collect::<Result<Vec<_>, _>>()?;
    normalized.sort();
    if normalized.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(IdentityError::Invalid(
            "application capability declarations must be unique".to_owned(),
        ));
    }
    Ok(normalized)
}

pub fn validate_application_descriptor(
    application: &ApplicationDescriptor,
) -> Result<(), IdentityError> {
    if !valid_identifier(&application.app_id)
        || !valid_semver(&application.version)
        || !valid_identifier(&application.publisher_id)
        || !valid_digest(&application.manifest_digest)
        || application
            .lock_digest
            .as_ref()
            .is_some_and(|digest| !valid_digest(digest))
    {
        return Err(IdentityError::Invalid(
            "application descriptor is invalid".to_owned(),
        ));
    }
    Ok(())
}

pub fn application_approval_subject(
    signed: &SignedApplicationApproval,
) -> Result<ApplicationApprovalSubject, IdentityError> {
    verify_signed_application_approval(signed)?;
    Ok(ApplicationApprovalSubject {
        kind: "app".to_owned(),
        app_id: signed.approval.application.app_id.clone(),
        version: signed.approval.application.version.clone(),
        publisher_id: signed.approval.application.publisher_id.clone(),
        lock_digest: signed.approval.application.lock_digest.clone(),
        approval_digest: signed.subject_root.clone(),
    })
}

pub fn validate_application_approval_subject(
    subject: &ApplicationApprovalSubject,
) -> Result<(), IdentityError> {
    if subject.kind != "app"
        || !valid_identifier(&subject.app_id)
        || !valid_semver(&subject.version)
        || !valid_identifier(&subject.publisher_id)
        || !valid_digest(&subject.approval_digest)
        || subject
            .lock_digest
            .as_ref()
            .is_some_and(|digest| !valid_digest(digest))
    {
        return Err(IdentityError::Invalid(
            "application approval subject is invalid".to_owned(),
        ));
    }
    Ok(())
}

pub fn verify_signed_application_approval(
    signed: &SignedApplicationApproval,
) -> Result<(), IdentityError> {
    if signed.protocol != SIGNED_APPLICATION_APPROVAL_PROTOCOL {
        return Err(IdentityError::Invalid(
            "signed application approval protocol is unsupported".to_owned(),
        ));
    }
    verify_signed_profile_identity(&signed.issuer)?;
    validate_application_approval_body(&signed.approval)?;
    if signed.approval.issuer_identity_id != signed.issuer.subject.id
        || signed.approval.issuer_key_id != signed.issuer.subject.key_id
    {
        return Err(IdentityError::Invalid(
            "application approval issuer does not match its signing identity".to_owned(),
        ));
    }
    let bytes = application_approval_subject_bytes(&signed.approval)?;
    verify_typed_signature(
        &signed.issuer.subject.public_key,
        &bytes,
        &signed.subject_root,
        &signed.signature,
    )
}

pub fn verify_signed_application_revocation(
    signed: &SignedApplicationRevocation,
) -> Result<(), IdentityError> {
    if signed.protocol != SIGNED_APPLICATION_REVOCATION_PROTOCOL {
        return Err(IdentityError::Invalid(
            "signed application revocation protocol is unsupported".to_owned(),
        ));
    }
    verify_signed_profile_identity(&signed.issuer)?;
    validate_application_revocation_body(&signed.revocation)?;
    if signed.revocation.issuer_identity_id != signed.issuer.subject.id
        || signed.revocation.issuer_key_id != signed.issuer.subject.key_id
    {
        return Err(IdentityError::Invalid(
            "application revocation issuer does not match its signing identity".to_owned(),
        ));
    }
    let bytes = application_revocation_subject_bytes(&signed.revocation)?;
    verify_typed_signature(
        &signed.issuer.subject.public_key,
        &bytes,
        &signed.subject_root,
        &signed.signature,
    )
}

pub fn verify_signed_capability_grant(signed: &SignedCapabilityGrant) -> Result<(), IdentityError> {
    if signed.protocol != SIGNED_CAPABILITY_GRANT_PROTOCOL {
        return Err(IdentityError::Invalid(
            "signed capability grant protocol is unsupported".to_owned(),
        ));
    }
    verify_signed_profile_identity(&signed.issuer)?;
    validate_capability_grant_body(&signed.grant)?;
    if signed.grant.issuer_identity_id != signed.issuer.subject.id
        || signed.grant.issuer_key_id != signed.issuer.subject.key_id
    {
        return Err(IdentityError::Invalid(
            "capability grant issuer does not match its signing identity".to_owned(),
        ));
    }
    let bytes = capability_grant_subject_bytes(&signed.grant)?;
    verify_typed_signature(
        &signed.issuer.subject.public_key,
        &bytes,
        &signed.subject_root,
        &signed.signature,
    )
}

pub fn verify_signed_capability_revocation(
    signed: &SignedCapabilityRevocation,
) -> Result<(), IdentityError> {
    if signed.protocol != SIGNED_CAPABILITY_REVOCATION_PROTOCOL {
        return Err(IdentityError::Invalid(
            "signed capability revocation protocol is unsupported".to_owned(),
        ));
    }
    verify_signed_profile_identity(&signed.issuer)?;
    validate_capability_revocation_body(&signed.revocation)?;
    if signed.revocation.issuer_identity_id != signed.issuer.subject.id
        || signed.revocation.issuer_key_id != signed.issuer.subject.key_id
    {
        return Err(IdentityError::Invalid(
            "capability revocation issuer does not match its signing identity".to_owned(),
        ));
    }
    let bytes = capability_revocation_subject_bytes(&signed.revocation)?;
    verify_typed_signature(
        &signed.issuer.subject.public_key,
        &bytes,
        &signed.subject_root,
        &signed.signature,
    )
}

fn validate_application_approval_body(
    approval: &ApplicationApprovalBody,
) -> Result<(), IdentityError> {
    validate_application_descriptor(&approval.application)?;
    if approval.protocol != APPLICATION_APPROVAL_PROTOCOL
        || approval.approved_at_unix_ms == 0
        || !validate_identity_id(&approval.issuer_identity_id)
        || !valid_digest(&approval.issuer_key_id)
        || normalize_declared_capabilities(&approval.declared_capabilities)?
            != approval.declared_capabilities
    {
        return Err(IdentityError::Invalid(
            "application approval body is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_application_revocation_body(
    revocation: &ApplicationRevocationBody,
) -> Result<(), IdentityError> {
    validate_application_descriptor(&revocation.application)?;
    if revocation.protocol != APPLICATION_REVOCATION_PROTOCOL
        || !valid_record_id(&revocation.id, APPLICATION_REVOCATION_PREFIX)
        || !valid_digest(&revocation.approval_subject_root)
        || revocation.reason.is_empty()
        || revocation.reason.len() > MAX_REVOCATION_REASON_BYTES
        || revocation.reason.chars().any(char::is_control)
        || revocation.revoked_at_unix_ms == 0
        || !validate_identity_id(&revocation.issuer_identity_id)
        || !valid_digest(&revocation.issuer_key_id)
    {
        return Err(IdentityError::Invalid(
            "application revocation body is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn validate_capability_grant_body(grant: &CapabilityGrantBody) -> Result<(), IdentityError> {
    if grant.protocol != CAPABILITY_GRANT_PROTOCOL
        || !valid_record_id(&grant.id, CAPABILITY_GRANT_PREFIX)
        || !valid_capability(&grant.capability)
        || grant.issued_at_unix_ms == 0
        || grant
            .expires_at_unix_ms
            .is_some_and(|expires| expires <= grant.issued_at_unix_ms)
        || !validate_identity_id(&grant.issuer_identity_id)
        || !valid_digest(&grant.issuer_key_id)
        || grant.constraints.len() > MAX_CONSTRAINTS
    {
        return Err(IdentityError::Invalid(
            "capability grant body is invalid".to_owned(),
        ));
    }
    validate_application_approval_subject(&grant.subject)?;
    for (key, value) in &grant.constraints {
        if !valid_constraint_key(key) || forbidden_constraint_key(key) {
            return Err(IdentityError::Invalid(
                "capability grant constraint key is invalid".to_owned(),
            ));
        }
        if let CapabilityConstraintValue::Text(value) = value {
            if value.is_empty()
                || value.len() > MAX_CONSTRAINT_TEXT_BYTES
                || value.chars().any(char::is_control)
            {
                return Err(IdentityError::Invalid(
                    "capability grant constraint text is invalid".to_owned(),
                ));
            }
        }
    }
    Ok(())
}

fn validate_capability_revocation_body(
    revocation: &CapabilityRevocationBody,
) -> Result<(), IdentityError> {
    if revocation.protocol != CAPABILITY_REVOCATION_PROTOCOL
        || !valid_record_id(&revocation.id, CAPABILITY_REVOCATION_PREFIX)
        || !valid_record_id(&revocation.grant_id, CAPABILITY_GRANT_PREFIX)
        || !valid_digest(&revocation.grant_subject_root)
        || revocation.reason.is_empty()
        || revocation.reason.len() > 160
        || revocation.reason.chars().any(char::is_control)
        || revocation.revoked_at_unix_ms == 0
        || !validate_identity_id(&revocation.issuer_identity_id)
        || !valid_digest(&revocation.issuer_key_id)
    {
        return Err(IdentityError::Invalid(
            "capability revocation body is invalid".to_owned(),
        ));
    }
    Ok(())
}

fn application_approval_subject_bytes(
    approval: &ApplicationApprovalBody,
) -> Result<Vec<u8>, IdentityError> {
    serde_json::to_vec(&ApplicationApprovalTypedSubject {
        protocol: APPLICATION_APPROVAL_SUBJECT_PROTOCOL,
        approval,
    })
    .map_err(IdentityError::from)
}

fn application_revocation_subject_bytes(
    revocation: &ApplicationRevocationBody,
) -> Result<Vec<u8>, IdentityError> {
    serde_json::to_vec(&ApplicationRevocationTypedSubject {
        protocol: APPLICATION_REVOCATION_SUBJECT_PROTOCOL,
        revocation,
    })
    .map_err(IdentityError::from)
}

fn capability_grant_subject_bytes(grant: &CapabilityGrantBody) -> Result<Vec<u8>, IdentityError> {
    serde_json::to_vec(&CapabilityGrantSubject {
        protocol: CAPABILITY_GRANT_SUBJECT_PROTOCOL,
        grant,
    })
    .map_err(IdentityError::from)
}

fn capability_revocation_subject_bytes(
    revocation: &CapabilityRevocationBody,
) -> Result<Vec<u8>, IdentityError> {
    serde_json::to_vec(&CapabilityRevocationSubject {
        protocol: CAPABILITY_REVOCATION_SUBJECT_PROTOCOL,
        revocation,
    })
    .map_err(IdentityError::from)
}

fn verify_typed_signature(
    public_key: &ProfileIdentityPublicKey,
    bytes: &[u8],
    subject_root: &str,
    signature: &str,
) -> Result<(), IdentityError> {
    if subject_root != digest_bytes(bytes) {
        return Err(IdentityError::Invalid(
            "typed subject root does not match".to_owned(),
        ));
    }
    let signature_bytes = Base64UrlUnpadded::decode_vec(signature)
        .map_err(|_| IdentityError::Invalid("typed signature is invalid".to_owned()))?;
    if signature_bytes.len() != 64 {
        return Err(IdentityError::Invalid(
            "typed signature has an invalid length".to_owned(),
        ));
    }
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| IdentityError::Invalid("typed signature is invalid".to_owned()))?;
    verifying_key(public_key)?
        .verify(bytes, &signature)
        .map_err(|_| IdentityError::Invalid("typed signature is invalid".to_owned()))
}

fn valid_record_id(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(is_lower_hex))
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
}

fn valid_capability(value: &str) -> bool {
    normalize_operation_capability(value).is_ok_and(|normalized| normalized == value)
}

fn valid_constraint_key(value: &str) -> bool {
    valid_identifier(value) && value.len() <= 64
}

fn forbidden_constraint_key(value: &str) -> bool {
    [
        "secret",
        "token",
        "password",
        "credential",
        "private",
        "key",
    ]
    .iter()
    .any(|needle| value.contains(needle))
}

fn valid_semver(value: &str) -> bool {
    if value.is_empty() || value.len() > 80 || value.chars().any(char::is_whitespace) {
        return false;
    }
    let (without_build, build) = value
        .split_once('+')
        .map_or((value, None), |(left, right)| (left, Some(right)));
    if build.is_some_and(|value| !valid_semver_suffix(value)) {
        return false;
    }
    let (core, prerelease) = without_build
        .split_once('-')
        .map_or((without_build, None), |(left, right)| (left, Some(right)));
    if prerelease.is_some_and(|value| !valid_semver_suffix(value)) {
        return false;
    }
    let parts = core.split('.').collect::<Vec<_>>();
    parts.len() == 3 && parts.into_iter().all(valid_semver_number)
}

fn valid_semver_number(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn valid_semver_suffix(value: &str) -> bool {
    !value.is_empty()
        && value.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn valid_digest(value: &str) -> bool {
    value
        .strip_prefix(DIGEST_PREFIX)
        .is_some_and(|suffix| suffix.len() == 64 && suffix.bytes().all(is_lower_hex))
}

pub fn verify_signed_profile_identity(signed: &SignedProfileIdentity) -> Result<(), IdentityError> {
    if signed.protocol != SIGNED_PROFILE_IDENTITY_PROTOCOL {
        return Err(IdentityError::Invalid(
            "signed profile identity protocol is unsupported".to_owned(),
        ));
    }
    validate_card(&signed.subject)?;
    let subject_bytes = subject_bytes(&signed.subject)?;
    let subject_root = digest_bytes(&subject_bytes);
    if signed.subject_root != subject_root {
        return Err(IdentityError::Invalid(
            "profile identity subject root does not match".to_owned(),
        ));
    }
    let verifying_key = verifying_key(&signed.subject.public_key)?;
    let signature_bytes = Base64UrlUnpadded::decode_vec(&signed.signature)
        .map_err(|_| IdentityError::Invalid("profile identity signature is invalid".to_owned()))?;
    if signature_bytes.len() != 64 {
        return Err(IdentityError::Invalid(
            "profile identity signature has an invalid length".to_owned(),
        ));
    }
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| IdentityError::Invalid("profile identity signature is invalid".to_owned()))?;
    verifying_key
        .verify(&subject_bytes, &signature)
        .map_err(|_| IdentityError::Invalid("profile identity signature is invalid".to_owned()))
}

fn sign_profile_identity(
    card: &ProfileIdentityCard,
    signing_key: &SigningKey,
) -> Result<SignedProfileIdentity, IdentityError> {
    validate_card(card)?;
    let subject_bytes = subject_bytes(card)?;
    let signature: Signature = signing_key.sign(&subject_bytes);
    Ok(SignedProfileIdentity {
        protocol: SIGNED_PROFILE_IDENTITY_PROTOCOL.to_owned(),
        subject: card.clone(),
        subject_root: digest_bytes(&subject_bytes),
        signature: Base64UrlUnpadded::encode_string(&signature.to_bytes()),
    })
}

fn subject_bytes(card: &ProfileIdentityCard) -> Result<Vec<u8>, IdentityError> {
    serde_json::to_vec(&ProfileIdentitySubject {
        protocol: PROFILE_IDENTITY_SUBJECT_PROTOCOL,
        identity: card,
    })
    .map_err(IdentityError::from)
}

fn validate_state(state: &StoredProfileIdentity) -> Result<(), IdentityError> {
    if state.protocol != PROFILE_IDENTITY_STATE_PROTOCOL || state.revision != 1 {
        return Err(IdentityError::Invalid(
            "profile identity state protocol or revision is unsupported".to_owned(),
        ));
    }
    validate_key_handle(&state.key_handle)?;
    verify_signed_profile_identity(&state.signed_identity)
}

fn validate_card(card: &ProfileIdentityCard) -> Result<(), IdentityError> {
    if card.protocol != PROFILE_IDENTITY_PROTOCOL
        || !validate_identity_id(&card.id)
        || normalize_handle(&card.handle)? != card.handle
        || card.algorithm != PROFILE_IDENTITY_ALGORITHM
        || card.created_at_unix_ms == 0
    {
        return Err(IdentityError::Invalid(
            "profile identity card contains invalid fields".to_owned(),
        ));
    }
    validate_public_key(&card.public_key)?;
    if card.key_id != digest_json(&card.public_key)? {
        return Err(IdentityError::Invalid(
            "profile identity key ID does not match its public key".to_owned(),
        ));
    }
    Ok(())
}

fn public_jwk(verifying_key: &VerifyingKey) -> Result<ProfileIdentityPublicKey, IdentityError> {
    let point = verifying_key.to_encoded_point(false);
    let x = point.x().ok_or(IdentityError::CryptographyUnavailable)?;
    let y = point.y().ok_or(IdentityError::CryptographyUnavailable)?;
    Ok(ProfileIdentityPublicKey {
        kty: "EC".to_owned(),
        crv: "P-256".to_owned(),
        x: Base64UrlUnpadded::encode_string(x),
        y: Base64UrlUnpadded::encode_string(y),
    })
}

fn validate_public_key(public_key: &ProfileIdentityPublicKey) -> Result<(), IdentityError> {
    if public_key.kty != "EC" || public_key.crv != "P-256" {
        return Err(IdentityError::Invalid(
            "profile identity public key type is unsupported".to_owned(),
        ));
    }
    let x = Base64UrlUnpadded::decode_vec(&public_key.x)
        .map_err(|_| IdentityError::Invalid("profile identity public key is invalid".to_owned()))?;
    let y = Base64UrlUnpadded::decode_vec(&public_key.y)
        .map_err(|_| IdentityError::Invalid("profile identity public key is invalid".to_owned()))?;
    if x.len() != 32 || y.len() != 32 {
        return Err(IdentityError::Invalid(
            "profile identity public key coordinates have invalid lengths".to_owned(),
        ));
    }
    verifying_key(public_key).map(|_| ())
}

fn verifying_key(public_key: &ProfileIdentityPublicKey) -> Result<VerifyingKey, IdentityError> {
    let x = Base64UrlUnpadded::decode_vec(&public_key.x)
        .map_err(|_| IdentityError::Invalid("profile identity public key is invalid".to_owned()))?;
    let y = Base64UrlUnpadded::decode_vec(&public_key.y)
        .map_err(|_| IdentityError::Invalid("profile identity public key is invalid".to_owned()))?;
    if x.len() != 32 || y.len() != 32 {
        return Err(IdentityError::Invalid(
            "profile identity public key coordinates have invalid lengths".to_owned(),
        ));
    }
    let mut sec1 = Vec::with_capacity(65);
    sec1.push(4);
    sec1.extend_from_slice(&x);
    sec1.extend_from_slice(&y);
    VerifyingKey::from_sec1_bytes(&sec1)
        .map_err(|_| IdentityError::Invalid("profile identity public key is invalid".to_owned()))
}

fn generate_secret_key(scalar: &mut [u8; 32]) -> Result<SecretKey, IdentityError> {
    for _ in 0..128 {
        getrandom(scalar).map_err(|_| IdentityError::CryptographyUnavailable)?;
        if let Ok(key) = SecretKey::from_slice(scalar) {
            return Ok(key);
        }
    }
    Err(IdentityError::CryptographyUnavailable)
}

fn random_identifier(prefix: &str) -> Result<String, IdentityError> {
    let mut bytes = [0_u8; 16];
    getrandom(&mut bytes).map_err(|_| IdentityError::CryptographyUnavailable)?;
    let output = format!("{prefix}{}", lower_hex(&bytes));
    bytes.zeroize();
    Ok(output)
}

fn normalize_handle(value: &str) -> Result<String, IdentityError> {
    let value = value.trim().trim_start_matches('@').to_ascii_lowercase();
    let valid = !value.is_empty()
        && value.len() <= MAX_HANDLE_BYTES
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric);
    if !valid {
        return Err(IdentityError::Invalid(
            "profile handle must use 1-48 lowercase letters, numbers, dots, dashes, or underscores"
                .to_owned(),
        ));
    }
    Ok(value)
}

fn validate_timestamp(value: u64) -> Result<(), IdentityError> {
    if value == 0 {
        return Err(IdentityError::Invalid(
            "profile identity timestamp must be positive".to_owned(),
        ));
    }
    Ok(())
}

fn validate_identity_id(value: &str) -> bool {
    value
        .strip_prefix(IDENTITY_PREFIX)
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(is_lower_hex))
}

fn validate_key_handle(value: &str) -> Result<(), IdentityError> {
    if value
        .strip_prefix(KEY_HANDLE_PREFIX)
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(is_lower_hex))
    {
        Ok(())
    } else {
        Err(IdentityError::Invalid(
            "profile identity key handle is invalid".to_owned(),
        ))
    }
}

fn digest_json<T: Serialize>(value: &T) -> Result<String, IdentityError> {
    let bytes = serde_json::to_vec(value)?;
    Ok(digest_bytes(&bytes))
}

fn digest_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    format!("{DIGEST_PREFIX}{}", lower_hex(&digest))
}

fn load_state(path: &Path) -> Result<StoredProfileIdentity, IdentityError> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err(IdentityError::Invalid(
            "profile identity state exceeds its byte limit".to_owned(),
        ));
    }
    let state = serde_json::from_slice(&bytes)?;
    validate_state(&state)?;
    Ok(state)
}

fn persist_state(path: &Path, state: &StoredProfileIdentity) -> Result<(), IdentityError> {
    validate_state(state)?;
    let mut bytes = serde_json::to_vec_pretty(state)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_STATE_BYTES {
        return Err(IdentityError::Invalid(
            "profile identity state exceeds its byte limit".to_owned(),
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| IdentityError::Invalid("profile identity state has no parent".to_owned()))?;
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
        return Err(IdentityError::Io(error));
    }
    Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<(), IdentityError> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::{collections::HashMap, sync::Mutex};

    static NEXT_HOME: AtomicUsize = AtomicUsize::new(1);

    #[derive(Default)]
    struct MemoryProfileKeyStore {
        values: Mutex<HashMap<String, Vec<u8>>>,
    }

    impl ProfileKeyStore for MemoryProfileKeyStore {
        fn set(&self, handle: &str, private_key: &[u8]) -> Result<(), IdentityError> {
            self.values
                .lock()
                .expect("memory key store lock")
                .insert(handle.to_owned(), private_key.to_vec());
            Ok(())
        }

        fn get(&self, handle: &str) -> Result<Zeroizing<Vec<u8>>, IdentityError> {
            self.values
                .lock()
                .expect("memory key store lock")
                .get(handle)
                .cloned()
                .map(Zeroizing::new)
                .ok_or(IdentityError::KeyStoreUnavailable)
        }

        fn delete(&self, handle: &str) -> Result<(), IdentityError> {
            self.values
                .lock()
                .expect("memory key store lock")
                .remove(handle)
                .map(|_| ())
                .ok_or(IdentityError::KeyStoreUnavailable)
        }
    }

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(label: &str) -> Self {
            let sequence = NEXT_HOME.fetch_add(1, Ordering::Relaxed);
            Self(std::env::temp_dir().join(format!(
                "greenways-identity-{label}-{}-{sequence}",
                process::id()
            )))
        }

        fn state(&self) -> PathBuf {
            self.0.join("profile-identity.json")
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn open_memory(home: &TestHome, store: Arc<MemoryProfileKeyStore>) -> ProfileIdentityVault {
        ProfileIdentityVault::open_with_store(home.state(), store)
            .expect("profile identity vault should open")
    }

    #[test]
    fn creates_one_self_signed_public_identity_without_projecting_the_private_key() {
        let home = TestHome::new("create");
        let store = Arc::new(MemoryProfileKeyStore::default());
        let mut vault = open_memory(&home, store.clone());
        let signed = vault
            .create("@River.Studio", 1_000)
            .expect("profile identity should be created");
        verify_signed_profile_identity(&signed).expect("signed identity should verify");
        assert_eq!(signed.subject.handle, "river.studio");
        assert!(signed.subject.id.starts_with(IDENTITY_PREFIX));
        assert!(signed.subject.key_id.starts_with(DIGEST_PREFIX));
        assert_eq!(vault.status().state, "configured");
        assert!(!vault.status().private_key_projection);
        assert_eq!(
            vault.status().typed_subjects,
            vec![
                PROFILE_IDENTITY_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_GRANT_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_REVOCATION_SUBJECT_PROTOCOL.to_owned(),
                APPLICATION_APPROVAL_SUBJECT_PROTOCOL.to_owned(),
                APPLICATION_REVOCATION_SUBJECT_PROTOCOL.to_owned(),
            ]
        );

        let private = store
            .values
            .lock()
            .expect("memory key store lock")
            .values()
            .next()
            .expect("private key should be stored")
            .clone();
        let metadata = fs::read(home.state()).expect("identity state should exist");
        assert!(!metadata
            .windows(private.len())
            .any(|window| window == private.as_slice()));
        let public = serde_json::to_string(&signed).expect("public identity should encode");
        assert!(!public.contains("keyHandle"));
        assert!(!public.contains("privateKey"));
        assert!(!format!("{vault:?}").contains("profile-key-"));
        vault
            .verify_private_key_binding()
            .expect("private key should match the public identity");
    }

    #[test]
    fn reopens_the_exact_identity_and_rejects_duplicate_creation() {
        let home = TestHome::new("restart");
        let store = Arc::new(MemoryProfileKeyStore::default());
        let signed = {
            let mut vault = open_memory(&home, store.clone());
            vault
                .create("maker", 2_000)
                .expect("identity should be created")
        };
        let mut reopened = open_memory(&home, store);
        assert_eq!(reopened.public_identity(), Some(signed));
        assert!(matches!(
            reopened.create("another", 3_000),
            Err(IdentityError::Conflict(_))
        ));
    }

    #[test]
    fn rejects_tampered_identity_roots_signatures_and_public_keys() {
        let home = TestHome::new("tamper");
        let store = Arc::new(MemoryProfileKeyStore::default());
        let mut vault = open_memory(&home, store);
        let signed = vault
            .create("artist", 4_000)
            .expect("identity should be created");

        let mut changed_root = signed.clone();
        changed_root.subject_root = format!("sha256:{}", "0".repeat(64));
        assert!(verify_signed_profile_identity(&changed_root).is_err());

        let mut changed_signature = signed.clone();
        changed_signature.signature.replace_range(0..1, "A");
        assert!(verify_signed_profile_identity(&changed_signature).is_err());

        let mut changed_key = signed;
        changed_key.subject.public_key.x = Base64UrlUnpadded::encode_string(&[0_u8; 32]);
        assert!(verify_signed_profile_identity(&changed_key).is_err());
    }

    #[test]
    fn rejects_invalid_handles_and_unconfigured_public_card_reads() {
        let home = TestHome::new("validation");
        let store = Arc::new(MemoryProfileKeyStore::default());
        let mut vault = open_memory(&home, store);
        assert_eq!(vault.status().state, "unconfigured");
        assert!(vault.public_identity().is_none());
        assert!(vault.create("not/allowed", 1_000).is_err());
        assert!(vault.create("valid", 0).is_err());
    }

    #[test]
    fn signs_only_closed_capability_grants_and_revocations() {
        let home = TestHome::new("capability-signing");
        let store = Arc::new(MemoryProfileKeyStore::default());
        let mut vault = open_memory(&home, store);
        vault
            .create("authority", 1_000)
            .expect("identity should be created");
        let subject = ApplicationApprovalSubject {
            kind: "app".to_owned(),
            app_id: "hara-playground".to_owned(),
            version: "1.2.3".to_owned(),
            publisher_id: "hara-lang".to_owned(),
            lock_digest: None,
            approval_digest:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000".to_owned(),
        };
        let grant = vault
            .sign_capability_grant(CapabilityGrantRequest {
                id: new_capability_grant_id().expect("grant id"),
                capability: "model/generate".to_owned(),
                subject,
                constraints: BTreeMap::new(),
                issued_at_unix_ms: 2_000,
                expires_at_unix_ms: Some(10_000),
            })
            .expect("grant should sign");
        verify_signed_capability_grant(&grant).expect("grant should verify");
        let revocation = vault
            .sign_capability_revocation(CapabilityRevocationRequest {
                id: new_capability_revocation_id().expect("revocation id"),
                grant_id: grant.grant.id.clone(),
                grant_subject_root: grant.subject_root.clone(),
                reason: "user-revoked".to_owned(),
                revoked_at_unix_ms: 3_000,
            })
            .expect("revocation should sign");
        verify_signed_capability_revocation(&revocation).expect("revocation should verify");

        let mut changed = grant.clone();
        changed.grant.capability = "tahto/write".to_owned();
        assert!(verify_signed_capability_grant(&changed).is_err());
        assert_eq!(
            vault.status().typed_subjects,
            vec![
                PROFILE_IDENTITY_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_GRANT_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_REVOCATION_SUBJECT_PROTOCOL.to_owned(),
                APPLICATION_APPROVAL_SUBJECT_PROTOCOL.to_owned(),
                APPLICATION_REVOCATION_SUBJECT_PROTOCOL.to_owned(),
            ]
        );
    }

    #[test]
    fn signs_only_closed_application_approvals_and_revocations() {
        let home = TestHome::new("application-signing");
        let store = Arc::new(MemoryProfileKeyStore::default());
        let mut vault = open_memory(&home, store);
        vault
            .create("authority", 1_000)
            .expect("identity should be created");
        let application = ApplicationDescriptor {
            app_id: "hara-playground".to_owned(),
            version: "1.2.3".to_owned(),
            publisher_id: "hara-lang".to_owned(),
            manifest_digest:
                "sha256:1111111111111111111111111111111111111111111111111111111111111111".to_owned(),
            lock_digest: Some(
                "sha256:2222222222222222222222222222222222222222222222222222222222222222"
                    .to_owned(),
            ),
        };
        let approval = vault
            .sign_application_approval(ApplicationApprovalRequest {
                application: application.clone(),
                declared_capabilities: vec!["tahto/read".to_owned(), "Model/Generate".to_owned()],
                approved_at_unix_ms: 2_000,
            })
            .expect("application approval should sign");
        verify_signed_application_approval(&approval).expect("approval should verify");
        assert_eq!(
            approval.approval.declared_capabilities,
            vec!["model/generate".to_owned(), "tahto/read".to_owned()]
        );
        let subject = application_approval_subject(&approval).expect("subject should derive");
        assert_eq!(subject.approval_digest, approval.subject_root);

        let revocation = vault
            .sign_application_revocation(ApplicationRevocationRequest {
                id: new_application_revocation_id().expect("revocation id"),
                approval_subject_root: approval.subject_root.clone(),
                application,
                reason: "user-revoked".to_owned(),
                revoked_at_unix_ms: 3_000,
            })
            .expect("application revocation should sign");
        verify_signed_application_revocation(&revocation).expect("revocation should verify");

        let mut changed = approval.clone();
        changed.approval.application.manifest_digest = format!("sha256:{}", "3".repeat(64));
        assert!(verify_signed_application_approval(&changed).is_err());
        assert!(vault
            .sign_application_approval(ApplicationApprovalRequest {
                application: approval.approval.application,
                declared_capabilities: vec![
                    "model/generate".to_owned(),
                    "MODEL/GENERATE".to_owned(),
                ],
                approved_at_unix_ms: 4_000,
            })
            .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_identity_metadata_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let home = TestHome::new("permissions");
        let store = Arc::new(MemoryProfileKeyStore::default());
        let mut vault = open_memory(&home, store);
        vault
            .create("private", 5_000)
            .expect("identity should be created");
        assert_eq!(
            fs::metadata(home.state())
                .expect("identity metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(home.state().parent().expect("identity parent"))
                .expect("identity parent metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
