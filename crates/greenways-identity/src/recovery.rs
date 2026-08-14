use super::{
    digest_bytes, persist_state, public_jwk, random_identifier, sync_parent, validate_state,
    verify_signed_profile_identity, IdentityError, ProfileIdentityVault, SignedProfileIdentity,
    StoredProfileIdentity, KEY_HANDLE_PREFIX, MAX_STATE_BYTES, PRIVATE_KEY_BYTES_LIMIT,
    PROFILE_IDENTITY_STATE_PROTOCOL,
};
use base64ct::{Base64UrlUnpadded, Encoding};
use getrandom::getrandom;
use p256::{
    ecdsa::{SigningKey, VerifyingKey},
    pkcs8::DecodePrivateKey,
    SecretKey,
};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::Path,
};
use zeroize::{Zeroize, Zeroizing};

pub const PROFILE_IDENTITY_RECOVERY_PROTOCOL: &str = "greenways-profile-identity-recovery/0-alpha";
pub const PROFILE_IDENTITY_RECOVERY_KEY_PROTOCOL: &str =
    "greenways-profile-identity-recovery-key/0-alpha";
pub const PROFILE_IDENTITY_RECOVERY_RECEIPT_PROTOCOL: &str =
    "greenways-profile-identity-recovery-receipt/0-alpha";
pub const PROFILE_IDENTITY_RECOVERY_ALGORITHM: &str = "aes-256-gcm";

const RECOVERY_REVISION: u64 = 1;
const RECOVERY_KEY_BYTES: usize = 32;
const RECOVERY_NONCE_BYTES: usize = 12;
const MAX_RECOVERY_PACKAGE_BYTES: usize = 64 * 1024;
const MAX_RECOVERY_KEY_FILE_BYTES: usize = 8 * 1024;
const MAX_RECOVERY_CIPHERTEXT_BYTES: usize = PRIVATE_KEY_BYTES_LIMIT + 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileIdentityRecoveryReceipt {
    pub protocol: String,
    pub identity_id: String,
    pub key_id: String,
    pub package_digest: String,
    pub created_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileIdentityRecoveryPackage {
    protocol: String,
    revision: u64,
    algorithm: String,
    created_at_unix_ms: u64,
    identity: SignedProfileIdentity,
    nonce: String,
    ciphertext: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileIdentityRecoveryAssociatedData<'a> {
    protocol: &'a str,
    revision: u64,
    algorithm: &'a str,
    created_at_unix_ms: u64,
    identity: &'a SignedProfileIdentity,
    nonce: &'a str,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileIdentityRecoveryKeyEnvelope {
    protocol: String,
    revision: u64,
    package_digest: String,
    recovery_key: String,
}

/// A fully validated recovery package whose private key remains process-local.
///
/// This type deliberately implements neither `Debug`, `Clone`, `Serialize`, nor
/// `Deserialize`. It can only be created by the closed recovery verifier and
/// consumed by `ProfileIdentityVault::recover_prepared`.
pub struct PreparedProfileIdentityRecovery {
    identity: SignedProfileIdentity,
    private_document: Zeroizing<Vec<u8>>,
    package_digest: String,
    created_at_unix_ms: u64,
}

impl PreparedProfileIdentityRecovery {
    pub fn public_identity(&self) -> &SignedProfileIdentity {
        &self.identity
    }

    pub fn package_digest(&self) -> &str {
        &self.package_digest
    }
}

impl ProfileIdentityVault {
    pub fn export_recovery_to_files(
        &self,
        package_path: impl AsRef<Path>,
        recovery_key_path: impl AsRef<Path>,
        observed_at_unix_ms: u64,
    ) -> Result<ProfileIdentityRecoveryReceipt, IdentityError> {
        if observed_at_unix_ms == 0 {
            return Err(IdentityError::Invalid(
                "profile identity recovery timestamp must be positive".to_owned(),
            ));
        }
        let package_path = package_path.as_ref();
        let recovery_key_path = recovery_key_path.as_ref();
        validate_distinct_destinations(package_path, recovery_key_path)?;
        validate_new_private_destination(package_path)?;
        validate_new_private_destination(recovery_key_path)?;

        self.verify_private_key_binding()?;
        let state = self.state.as_ref().ok_or_else(|| {
            IdentityError::Invalid("profile identity is not configured".to_owned())
        })?;
        validate_state(state)?;
        let private_document = self.keys.get(&state.key_handle)?;
        if private_document.len() > PRIVATE_KEY_BYTES_LIMIT {
            return Err(IdentityError::CryptographyUnavailable);
        }

        let mut recovery_key = Zeroizing::new([0_u8; RECOVERY_KEY_BYTES]);
        let mut nonce = [0_u8; RECOVERY_NONCE_BYTES];
        getrandom(recovery_key.as_mut()).map_err(|_| IdentityError::CryptographyUnavailable)?;
        getrandom(&mut nonce).map_err(|_| IdentityError::CryptographyUnavailable)?;
        let nonce_text = Base64UrlUnpadded::encode_string(&nonce);
        let associated_data =
            recovery_associated_data(observed_at_unix_ms, &state.signed_identity, &nonce_text)?;
        let sealing_key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, recovery_key.as_ref())
                .map_err(|_| IdentityError::CryptographyUnavailable)?,
        );
        let mut ciphertext = Zeroizing::new(private_document.to_vec());
        sealing_key
            .seal_in_place_append_tag(
                Nonce::assume_unique_for_key(nonce),
                Aad::from(associated_data.as_slice()),
                &mut *ciphertext,
            )
            .map_err(|_| IdentityError::CryptographyUnavailable)?;
        nonce.zeroize();
        if ciphertext.len() > MAX_RECOVERY_CIPHERTEXT_BYTES {
            return Err(IdentityError::CryptographyUnavailable);
        }

        let package = ProfileIdentityRecoveryPackage {
            protocol: PROFILE_IDENTITY_RECOVERY_PROTOCOL.to_owned(),
            revision: RECOVERY_REVISION,
            algorithm: PROFILE_IDENTITY_RECOVERY_ALGORITHM.to_owned(),
            created_at_unix_ms: observed_at_unix_ms,
            identity: state.signed_identity.clone(),
            nonce: nonce_text,
            ciphertext: Base64UrlUnpadded::encode_string(ciphertext.as_slice()),
        };
        let package_bytes = encode_bounded_json(&package, MAX_RECOVERY_PACKAGE_BYTES)?;
        let package_digest = digest_bytes(&package_bytes);
        let mut envelope = ProfileIdentityRecoveryKeyEnvelope {
            protocol: PROFILE_IDENTITY_RECOVERY_KEY_PROTOCOL.to_owned(),
            revision: RECOVERY_REVISION,
            package_digest: package_digest.clone(),
            recovery_key: Base64UrlUnpadded::encode_string(recovery_key.as_ref()),
        };
        let key_bytes =
            Zeroizing::new(encode_bounded_json(&envelope, MAX_RECOVERY_KEY_FILE_BYTES)?);
        envelope.recovery_key.zeroize();

        write_private_new(package_path, &package_bytes)?;
        if let Err(error) = write_private_new(recovery_key_path, key_bytes.as_slice()) {
            remove_exact_file(package_path, &package_bytes);
            return Err(error);
        }

        Ok(ProfileIdentityRecoveryReceipt {
            protocol: PROFILE_IDENTITY_RECOVERY_RECEIPT_PROTOCOL.to_owned(),
            identity_id: state.signed_identity.subject.id.clone(),
            key_id: state.signed_identity.subject.key_id.clone(),
            package_digest,
            created_at_unix_ms: observed_at_unix_ms,
        })
    }

    pub fn prepare_recovery_from_files(
        package_path: impl AsRef<Path>,
        recovery_key_path: impl AsRef<Path>,
    ) -> Result<PreparedProfileIdentityRecovery, IdentityError> {
        let package_path = package_path.as_ref();
        let recovery_key_path = recovery_key_path.as_ref();
        validate_distinct_existing_files(package_path, recovery_key_path)?;
        let package_bytes = read_private_regular_file(package_path, MAX_RECOVERY_PACKAGE_BYTES)?;
        let key_bytes = Zeroizing::new(read_private_regular_file(
            recovery_key_path,
            MAX_RECOVERY_KEY_FILE_BYTES,
        )?);
        let package: ProfileIdentityRecoveryPackage = serde_json::from_slice(&package_bytes)?;
        let mut envelope: ProfileIdentityRecoveryKeyEnvelope =
            serde_json::from_slice(key_bytes.as_slice())?;

        validate_recovery_package(&package)?;
        if envelope.protocol != PROFILE_IDENTITY_RECOVERY_KEY_PROTOCOL
            || envelope.revision != RECOVERY_REVISION
        {
            envelope.recovery_key.zeroize();
            return Err(IdentityError::Invalid(
                "profile identity recovery key protocol or revision is unsupported".to_owned(),
            ));
        }
        let package_digest = digest_bytes(&package_bytes);
        if envelope.package_digest != package_digest {
            envelope.recovery_key.zeroize();
            return Err(IdentityError::Invalid(
                "profile identity recovery key does not match the selected package".to_owned(),
            ));
        }

        let recovery_key = Zeroizing::new(
            Base64UrlUnpadded::decode_vec(&envelope.recovery_key).map_err(|_| {
                IdentityError::Invalid("profile identity recovery key is invalid".to_owned())
            })?,
        );
        envelope.recovery_key.zeroize();
        let mut nonce = Base64UrlUnpadded::decode_vec(&package.nonce).map_err(|_| {
            IdentityError::Invalid("profile identity recovery nonce is invalid".to_owned())
        })?;
        let ciphertext = Base64UrlUnpadded::decode_vec(&package.ciphertext).map_err(|_| {
            IdentityError::Invalid("profile identity recovery ciphertext is invalid".to_owned())
        })?;
        if recovery_key.len() != RECOVERY_KEY_BYTES
            || nonce.len() != RECOVERY_NONCE_BYTES
            || ciphertext.is_empty()
            || ciphertext.len() > MAX_RECOVERY_CIPHERTEXT_BYTES
        {
            nonce.zeroize();
            return Err(IdentityError::Invalid(
                "profile identity recovery cryptographic fields are invalid".to_owned(),
            ));
        }
        let associated_data = recovery_associated_data(
            package.created_at_unix_ms,
            &package.identity,
            &package.nonce,
        )?;
        let opening_key = LessSafeKey::new(
            UnboundKey::new(&AES_256_GCM, recovery_key.as_slice())
                .map_err(|_| IdentityError::CryptographyUnavailable)?,
        );
        let mut private_document = Zeroizing::new(ciphertext);
        let plaintext_len = opening_key
            .open_in_place(
                Nonce::assume_unique_for_key(
                    nonce
                        .as_slice()
                        .try_into()
                        .map_err(|_| IdentityError::CryptographyUnavailable)?,
                ),
                Aad::from(associated_data.as_slice()),
                private_document.as_mut(),
            )
            .map_err(|_| {
                IdentityError::Invalid(
                    "profile identity recovery material failed authentication".to_owned(),
                )
            })?
            .len();
        private_document.truncate(plaintext_len);
        nonce.zeroize();
        if private_document.len() > PRIVATE_KEY_BYTES_LIMIT {
            return Err(IdentityError::Invalid(
                "profile identity recovery private key exceeds its byte limit".to_owned(),
            ));
        }
        verify_recovered_private_key(&package.identity, &private_document)?;

        Ok(PreparedProfileIdentityRecovery {
            identity: package.identity,
            private_document,
            package_digest,
            created_at_unix_ms: package.created_at_unix_ms,
        })
    }

    pub fn recover_prepared(
        &mut self,
        prepared: PreparedProfileIdentityRecovery,
    ) -> Result<SignedProfileIdentity, IdentityError> {
        if self.state.is_some() || self.metadata_path.exists() {
            return Err(IdentityError::Conflict(
                "a Greenways profile identity already exists".to_owned(),
            ));
        }
        verify_signed_profile_identity(&prepared.identity)?;
        verify_recovered_private_key(&prepared.identity, prepared.private_document.as_slice())?;
        if prepared.created_at_unix_ms == 0 || !prepared.package_digest.starts_with("sha256:") {
            return Err(IdentityError::Invalid(
                "profile identity recovery evidence is invalid".to_owned(),
            ));
        }

        let key_handle = random_identifier(KEY_HANDLE_PREFIX)?;
        self.keys
            .set(&key_handle, prepared.private_document.as_slice())?;
        let state = StoredProfileIdentity {
            protocol: PROFILE_IDENTITY_STATE_PROTOCOL.to_owned(),
            revision: 1,
            key_handle: key_handle.clone(),
            signed_identity: prepared.identity.clone(),
        };
        if let Err(error) = persist_state(&self.metadata_path, &state) {
            let _ = self.keys.delete(&key_handle);
            return Err(error);
        }
        self.state = Some(state);
        if let Err(error) = self.verify_private_key_binding() {
            self.state = None;
            let _ = fs::remove_file(&self.metadata_path);
            let _ = self.keys.delete(&key_handle);
            return Err(error);
        }
        Ok(prepared.identity)
    }
}

fn recovery_associated_data(
    created_at_unix_ms: u64,
    identity: &SignedProfileIdentity,
    nonce: &str,
) -> Result<Vec<u8>, IdentityError> {
    serde_json::to_vec(&ProfileIdentityRecoveryAssociatedData {
        protocol: PROFILE_IDENTITY_RECOVERY_PROTOCOL,
        revision: RECOVERY_REVISION,
        algorithm: PROFILE_IDENTITY_RECOVERY_ALGORITHM,
        created_at_unix_ms,
        identity,
        nonce,
    })
    .map_err(IdentityError::from)
}

fn validate_recovery_package(
    package: &ProfileIdentityRecoveryPackage,
) -> Result<(), IdentityError> {
    if package.protocol != PROFILE_IDENTITY_RECOVERY_PROTOCOL
        || package.revision != RECOVERY_REVISION
        || package.algorithm != PROFILE_IDENTITY_RECOVERY_ALGORITHM
        || package.created_at_unix_ms == 0
    {
        return Err(IdentityError::Invalid(
            "profile identity recovery package protocol or fields are unsupported".to_owned(),
        ));
    }
    verify_signed_profile_identity(&package.identity)
}

fn verify_recovered_private_key(
    identity: &SignedProfileIdentity,
    private_document: &[u8],
) -> Result<(), IdentityError> {
    let secret_key = SecretKey::from_pkcs8_der(private_document).map_err(|_| {
        IdentityError::Invalid("profile identity recovery private key is invalid".to_owned())
    })?;
    let signing_key = SigningKey::from_bytes(&secret_key.to_bytes()).map_err(|_| {
        IdentityError::Invalid("profile identity recovery private key is invalid".to_owned())
    })?;
    let public_key = public_jwk(&VerifyingKey::from(&signing_key))?;
    if public_key != identity.subject.public_key
        || super::digest_json(&public_key)? != identity.subject.key_id
    {
        return Err(IdentityError::Invalid(
            "profile identity recovery private key does not match its public identity".to_owned(),
        ));
    }
    verify_signed_profile_identity(identity)
}

fn encode_bounded_json<T: Serialize>(value: &T, maximum: usize) -> Result<Vec<u8>, IdentityError> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    if bytes.len() > maximum || bytes.len() > MAX_STATE_BYTES {
        return Err(IdentityError::Invalid(
            "profile identity recovery document exceeds its byte limit".to_owned(),
        ));
    }
    Ok(bytes)
}

fn validate_distinct_destinations(left: &Path, right: &Path) -> Result<(), IdentityError> {
    if left == right {
        return Err(IdentityError::Invalid(
            "profile identity recovery package and key paths must be distinct".to_owned(),
        ));
    }
    Ok(())
}

fn validate_distinct_existing_files(left: &Path, right: &Path) -> Result<(), IdentityError> {
    validate_distinct_destinations(left, right)?;
    let left = fs::canonicalize(left)?;
    let right = fs::canonicalize(right)?;
    if left == right {
        return Err(IdentityError::Invalid(
            "profile identity recovery package and key files must be distinct".to_owned(),
        ));
    }
    Ok(())
}

fn validate_new_private_destination(path: &Path) -> Result<(), IdentityError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(IdentityError::Conflict(
            "a profile identity recovery destination already exists".to_owned(),
        )),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or_else(|| {
                IdentityError::Invalid(
                    "profile identity recovery destination has no parent".to_owned(),
                )
            })?;
            let metadata = fs::symlink_metadata(parent)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(IdentityError::Invalid(
                    "profile identity recovery destination parent is unsafe".to_owned(),
                ));
            }
            Ok(())
        }
        Err(error) => Err(IdentityError::Io(error)),
    }
}

fn write_private_new(path: &Path, bytes: &[u8]) -> Result<(), IdentityError> {
    validate_new_private_destination(path)?;
    let parent = path.parent().ok_or_else(|| {
        IdentityError::Invalid("profile identity recovery destination has no parent".to_owned())
    })?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            IdentityError::Conflict(
                "a profile identity recovery destination already exists".to_owned(),
            )
        } else {
            IdentityError::Io(error)
        }
    })?;
    if let Err(error) = (|| -> Result<(), io::Error> {
        file.write_all(bytes)?;
        file.sync_all()?;
        super::set_private_file(path)?;
        sync_parent(parent)?;
        Ok(())
    })() {
        remove_exact_file(path, bytes);
        return Err(IdentityError::Io(error));
    }
    Ok(())
}

fn read_private_regular_file(path: &Path, maximum: usize) -> Result<Vec<u8>, IdentityError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(IdentityError::Invalid(
            "profile identity recovery input is not a private regular file".to_owned(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err(IdentityError::Invalid(
                "profile identity recovery input permissions are unsafe".to_owned(),
            ));
        }
    }
    if usize::try_from(metadata.len()).map_or(true, |length| length > maximum) {
        return Err(IdentityError::Invalid(
            "profile identity recovery input exceeds its byte limit".to_owned(),
        ));
    }
    let bytes = fs::read(path)?;
    if bytes.len() > maximum {
        return Err(IdentityError::Invalid(
            "profile identity recovery input exceeds its byte limit".to_owned(),
        ));
    }
    Ok(bytes)
}

fn remove_exact_file(path: &Path, expected: &[u8]) {
    let removable = fs::symlink_metadata(path)
        .ok()
        .is_some_and(|metadata| !metadata.file_type().is_symlink() && metadata.is_file())
        && fs::read(path).ok().as_deref() == Some(expected);
    if removable {
        let _ = fs::remove_file(path);
        if let Some(parent) = path.parent() {
            let _ = File::open(parent).and_then(|directory| directory.sync_all());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ProfileKeyStore;
    use std::{
        collections::BTreeMap,
        path::PathBuf,
        process,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    static NEXT_HOME: AtomicUsize = AtomicUsize::new(1);

    #[derive(Default)]
    struct MemoryProfileKeyStore {
        values: Mutex<BTreeMap<String, Vec<u8>>>,
    }

    impl ProfileKeyStore for MemoryProfileKeyStore {
        fn set(&self, handle: &str, private_key: &[u8]) -> Result<(), IdentityError> {
            self.values
                .lock()
                .expect("memory key store")
                .insert(handle.to_owned(), private_key.to_vec());
            Ok(())
        }

        fn get(&self, handle: &str) -> Result<Zeroizing<Vec<u8>>, IdentityError> {
            self.values
                .lock()
                .expect("memory key store")
                .get(handle)
                .cloned()
                .map(Zeroizing::new)
                .ok_or(IdentityError::KeyStoreUnavailable)
        }

        fn delete(&self, handle: &str) -> Result<(), IdentityError> {
            self.values
                .lock()
                .expect("memory key store")
                .remove(handle)
                .map(|_| ())
                .ok_or(IdentityError::KeyStoreUnavailable)
        }
    }

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(label: &str) -> Self {
            let sequence = NEXT_HOME.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "greenways-identity-recovery-{label}-{}-{sequence}",
                process::id()
            ));
            fs::create_dir_all(&path).expect("test home");
            #[cfg(unix)]
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("test home mode");
            Self(path)
        }

        fn metadata(&self) -> PathBuf {
            self.0.join("profile-identity.json")
        }

        fn package(&self) -> PathBuf {
            self.0.join("profile.recovery.json")
        }

        fn recovery_key(&self) -> PathBuf {
            self.0.join("profile.recovery-key.json")
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn open_memory(home: &TestHome, store: Arc<MemoryProfileKeyStore>) -> ProfileIdentityVault {
        ProfileIdentityVault::open_with_store(home.metadata(), store).expect("identity vault")
    }

    #[test]
    fn exports_and_recovers_the_exact_identity_without_plaintext_private_key_projection() {
        let source = TestHome::new("roundtrip-source");
        let source_store = Arc::new(MemoryProfileKeyStore::default());
        let mut source_vault = open_memory(&source, source_store.clone());
        let original = source_vault
            .create("river.studio", 1_000)
            .expect("source identity");
        let private = source_store
            .values
            .lock()
            .expect("source keys")
            .values()
            .next()
            .expect("source key")
            .clone();
        let receipt = source_vault
            .export_recovery_to_files(source.package(), source.recovery_key(), 2_000)
            .expect("recovery export");
        assert_eq!(receipt.identity_id, original.subject.id);
        assert_eq!(receipt.key_id, original.subject.key_id);
        assert!(receipt.package_digest.starts_with("sha256:"));
        #[cfg(unix)]
        for path in [source.package(), source.recovery_key()] {
            assert_eq!(
                fs::metadata(path)
                    .expect("private recovery file")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert!(matches!(
            source_vault.export_recovery_to_files(source.package(), source.recovery_key(), 2_001),
            Err(IdentityError::Conflict(_))
        ));
        assert!(!fs::read(source.package())
            .expect("package")
            .windows(private.len())
            .any(|window| window == private.as_slice()));
        assert!(!fs::read(source.recovery_key())
            .expect("key envelope")
            .windows(private.len())
            .any(|window| window == private.as_slice()));

        let target = TestHome::new("roundtrip-target");
        let target_store = Arc::new(MemoryProfileKeyStore::default());
        let prepared = ProfileIdentityVault::prepare_recovery_from_files(
            source.package(),
            source.recovery_key(),
        )
        .expect("prepare recovery");
        assert_eq!(prepared.public_identity(), &original);
        assert_eq!(prepared.package_digest(), receipt.package_digest);
        let mut target_vault = open_memory(&target, target_store);
        let recovered = target_vault
            .recover_prepared(prepared)
            .expect("recover exact identity");
        assert_eq!(recovered, original);
        target_vault
            .verify_private_key_binding()
            .expect("recovered binding");
    }

    #[test]
    fn rejects_tampered_substituted_expanded_and_unsafe_recovery_inputs() {
        let first = TestHome::new("tamper-first");
        let first_store = Arc::new(MemoryProfileKeyStore::default());
        let mut first_vault = open_memory(&first, first_store);
        first_vault.create("first", 1_000).expect("first identity");
        first_vault
            .export_recovery_to_files(first.package(), first.recovery_key(), 2_000)
            .expect("first export");

        let second = TestHome::new("tamper-second");
        let second_store = Arc::new(MemoryProfileKeyStore::default());
        let mut second_vault = open_memory(&second, second_store);
        second_vault
            .create("second", 3_000)
            .expect("second identity");
        second_vault
            .export_recovery_to_files(second.package(), second.recovery_key(), 4_000)
            .expect("second export");

        assert!(ProfileIdentityVault::prepare_recovery_from_files(
            first.package(),
            second.recovery_key()
        )
        .is_err());

        let mut package: serde_json::Value =
            serde_json::from_slice(&fs::read(first.package()).expect("package"))
                .expect("package json");
        package["extra"] = serde_json::json!(true);
        let mut expanded = serde_json::to_vec_pretty(&package).expect("expanded package");
        expanded.push(b'\n');
        fs::write(first.package(), expanded).expect("expanded package write");
        #[cfg(unix)]
        fs::set_permissions(first.package(), fs::Permissions::from_mode(0o600))
            .expect("package mode");
        assert!(ProfileIdentityVault::prepare_recovery_from_files(
            first.package(),
            first.recovery_key()
        )
        .is_err());

        #[cfg(unix)]
        {
            fs::set_permissions(second.recovery_key(), fs::Permissions::from_mode(0o644))
                .expect("unsafe mode");
            assert!(ProfileIdentityVault::prepare_recovery_from_files(
                second.package(),
                second.recovery_key()
            )
            .is_err());
        }
    }

    #[test]
    fn recovery_never_overwrites_an_identity_or_leaves_a_key_after_commit_failure() {
        let source = TestHome::new("conflict-source");
        let source_store = Arc::new(MemoryProfileKeyStore::default());
        let mut source_vault = open_memory(&source, source_store);
        source_vault
            .create("source", 1_000)
            .expect("source identity");
        source_vault
            .export_recovery_to_files(source.package(), source.recovery_key(), 2_000)
            .expect("source export");

        let target = TestHome::new("conflict-target");
        let target_store = Arc::new(MemoryProfileKeyStore::default());
        let mut target_vault = open_memory(&target, target_store.clone());
        target_vault
            .create("target", 3_000)
            .expect("target identity");
        let prepared = ProfileIdentityVault::prepare_recovery_from_files(
            source.package(),
            source.recovery_key(),
        )
        .expect("prepare conflict");
        assert!(matches!(
            target_vault.recover_prepared(prepared),
            Err(IdentityError::Conflict(_))
        ));
        assert_eq!(target_store.values.lock().expect("target keys").len(), 1);

        let failed = TestHome::new("commit-failure");
        let blocker = failed.0.join("blocked-parent");
        fs::create_dir_all(&blocker).expect("initial target parent");
        let failed_store = Arc::new(MemoryProfileKeyStore::default());
        let mut failed_vault = ProfileIdentityVault::open_with_store(
            blocker.join("profile-identity.json"),
            failed_store.clone(),
        )
        .expect("unconfigured failed vault");
        fs::remove_dir(&blocker).expect("remove initial target parent");
        fs::write(&blocker, b"not a directory").expect("blocker");
        let prepared = ProfileIdentityVault::prepare_recovery_from_files(
            source.package(),
            source.recovery_key(),
        )
        .expect("prepare failed commit");
        assert!(failed_vault.recover_prepared(prepared).is_err());
        assert!(failed_store.values.lock().expect("failed keys").is_empty());
    }
}
