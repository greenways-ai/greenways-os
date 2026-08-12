from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PATH = ROOT / "crates/greenways-identity/src/lib.rs"
content = PATH.read_text()


def replace(old: str, new: str) -> None:
    global content
    if content.count(old) != 1:
        raise SystemExit(f"identity capability anchor was not unique: {old[:180]!r}")
    content = content.replace(old, new)


replace(
    "use std::{\n    error::Error,",
    "use std::{\n    collections::BTreeMap,\n    error::Error,",
)

replace(
    "use zeroize::{Zeroize, Zeroizing};\n",
    "use zeroize::{Zeroize, Zeroizing};\n\n#[cfg(feature = \"test-support\")]\nuse std::sync::Mutex;\n",
)

replace(
    '''pub const PROFILE_IDENTITY_STATUS_PROTOCOL: &str = "greenways-profile-identity-status/0-alpha";
pub const PROFILE_IDENTITY_ALGORITHM: &str = "p256-sha256-fixed";
''',
    '''pub const PROFILE_IDENTITY_STATUS_PROTOCOL: &str = "greenways-profile-identity-status/0-alpha";
pub const CAPABILITY_GRANT_PROTOCOL: &str = "greenways-capability-grant/0-alpha";
pub const SIGNED_CAPABILITY_GRANT_PROTOCOL: &str = "greenways-signed-capability-grant/0-alpha";
pub const CAPABILITY_GRANT_SUBJECT_PROTOCOL: &str = "greenways-capability-grant-subject/0-alpha";
pub const CAPABILITY_REVOCATION_PROTOCOL: &str = "greenways-capability-revocation/0-alpha";
pub const SIGNED_CAPABILITY_REVOCATION_PROTOCOL: &str = "greenways-signed-capability-revocation/0-alpha";
pub const CAPABILITY_REVOCATION_SUBJECT_PROTOCOL: &str = "greenways-capability-revocation-subject/0-alpha";
pub const PROFILE_IDENTITY_ALGORITHM: &str = "p256-sha256-fixed";

#[cfg(feature = "test-support")]
pub const DIGEST_TEST_VALUE: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
''',
)

replace(
    '''const IDENTITY_PREFIX: &str = "identity/";
const KEY_HANDLE_PREFIX: &str = "profile-key-";
''',
    '''const IDENTITY_PREFIX: &str = "identity/";
const CAPABILITY_GRANT_PREFIX: &str = "grant/";
const CAPABILITY_REVOCATION_PREFIX: &str = "revocation/";
const KEY_HANDLE_PREFIX: &str = "profile-key-";
''',
)

replace(
    '''const MAX_HANDLE_BYTES: usize = 48;
const PRIVATE_KEY_BYTES_LIMIT: usize = 1024;
''',
    '''const MAX_HANDLE_BYTES: usize = 48;
const MAX_CONSTRAINTS: usize = 32;
const MAX_CONSTRAINT_TEXT_BYTES: usize = 240;
const PRIVATE_KEY_BYTES_LIMIT: usize = 1024;
''',
)

replace(
    '''pub struct ProfileIdentityStatus {
    pub protocol: String,
    pub state: String,
    pub key_custody: String,
    pub identity_id: Option<String>,
    pub key_id: Option<String>,
    pub algorithm: String,
    pub private_key_projection: bool,
    pub typed_subjects: Vec<String>,
}
''',
    '''pub struct ProfileIdentityStatus {
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
    pub reason: String,
    pub revoked_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityRevocationBody {
    pub protocol: String,
    pub id: String,
    pub grant_id: String,
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
''',
)

replace(
    '''struct ProfileIdentitySubject<'a> {
    protocol: &'static str,
    identity: &'a ProfileIdentityCard,
}
''',
    '''struct ProfileIdentitySubject<'a> {
    protocol: &'static str,
    identity: &'a ProfileIdentityCard,
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
''',
)

replace(
    '''#[derive(Debug, Default)]
struct SystemProfileKeyStore;
''',
    '''#[derive(Debug, Default)]
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
''',
)

replace(
    '''    pub fn open_system(metadata_path: impl Into<PathBuf>) -> Result<Self, IdentityError> {
        Self::open_with_store(metadata_path.into(), Arc::new(SystemProfileKeyStore))
    }
''',
    '''    pub fn open_system(metadata_path: impl Into<PathBuf>) -> Result<Self, IdentityError> {
        Self::open_with_store(metadata_path.into(), Arc::new(SystemProfileKeyStore))
    }

    #[cfg(feature = "test-support")]
    pub fn open_test(metadata_path: impl Into<PathBuf>) -> Result<Self, IdentityError> {
        Self::open_with_store(metadata_path.into(), Arc::new(TestProfileKeyStore::default()))
    }
''',
)

replace(
    '''            typed_subjects: vec![PROFILE_IDENTITY_SUBJECT_PROTOCOL.to_owned()],
''',
    '''            typed_subjects: vec![
                PROFILE_IDENTITY_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_GRANT_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_REVOCATION_SUBJECT_PROTOCOL.to_owned(),
            ],
''',
)

replace(
    '''    #[allow(dead_code)]
    fn verify_private_key_binding(&self) -> Result<(), IdentityError> {
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
        Ok(())
    }
''',
    '''    fn load_signing_key(&self) -> Result<SigningKey, IdentityError> {
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
''',
)

# Add the portable typed-record validators before the existing profile verifier.
replace(
    '''pub fn verify_signed_profile_identity(
    signed: &SignedProfileIdentity,
) -> Result<(), IdentityError> {
''',
    '''pub fn new_capability_grant_id() -> Result<String, IdentityError> {
    random_identifier(CAPABILITY_GRANT_PREFIX)
}

pub fn new_capability_revocation_id() -> Result<String, IdentityError> {
    random_identifier(CAPABILITY_REVOCATION_PREFIX)
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

pub fn verify_signed_capability_grant(
    signed: &SignedCapabilityGrant,
) -> Result<(), IdentityError> {
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

fn capability_grant_subject_bytes(
    grant: &CapabilityGrantBody,
) -> Result<Vec<u8>, IdentityError> {
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
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-')
        })
        && value.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        && value.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric)
}

fn valid_capability(value: &str) -> bool {
    let mut parts = value.split('/');
    matches!((parts.next(), parts.next(), parts.next()), (Some(left), Some(right), None) if valid_identifier(left) && valid_identifier(right))
}

fn valid_constraint_key(value: &str) -> bool {
    valid_identifier(value) && value.len() <= 64
}

fn forbidden_constraint_key(value: &str) -> bool {
    ["secret", "token", "password", "credential", "private", "key"]
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
                && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

fn valid_digest(value: &str) -> bool {
    value
        .strip_prefix(DIGEST_PREFIX)
        .is_some_and(|suffix| suffix.len() == 64 && suffix.bytes().all(is_lower_hex))
}

pub fn verify_signed_profile_identity(
    signed: &SignedProfileIdentity,
) -> Result<(), IdentityError> {
''',
)

# Add capability signing tests before the permissions test.
replace(
    '''    #[cfg(unix)]
    #[test]
    fn writes_private_identity_metadata_permissions() {
''',
    '''    #[test]
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
                "sha256:0000000000000000000000000000000000000000000000000000000000000000"
                    .to_owned(),
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
                reason: "user-revoked".to_owned(),
                revoked_at_unix_ms: 3_000,
            })
            .expect("revocation should sign");
        verify_signed_capability_revocation(&revocation)
            .expect("revocation should verify");

        let mut changed = grant.clone();
        changed.grant.capability = "tahto/write".to_owned();
        assert!(verify_signed_capability_grant(&changed).is_err());
        assert_eq!(
            vault.status().typed_subjects,
            vec![
                PROFILE_IDENTITY_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_GRANT_SUBJECT_PROTOCOL.to_owned(),
                CAPABILITY_REVOCATION_SUBJECT_PROTOCOL.to_owned(),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_identity_metadata_permissions() {
''',
)

PATH.write_text(content)
print("Applied signed capability authority integration")
