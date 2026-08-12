use greenways_identity::{
    new_capability_grant_id, new_capability_revocation_id,
    validate_application_approval_subject, verify_signed_capability_grant,
    verify_signed_capability_revocation, ApplicationApprovalSubject,
    CapabilityConstraintValue, CapabilityGrantRequest, CapabilityRevocationRequest,
    ProfileIdentityVault, SignedCapabilityGrant, SignedCapabilityRevocation,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
};

pub const CAPABILITY_AUTHORITY_STATE_PROTOCOL: &str =
    "greenways-capability-authority-state/0-alpha";
pub const CAPABILITY_AUTHORITY_STATUS_PROTOCOL: &str =
    "greenways-capability-authority-status/0-alpha";
pub const CAPABILITY_DECISION_PROTOCOL: &str = "greenways-capability-decision/0-alpha";

const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_GRANTS: usize = 512;
const MAX_REVOCATIONS: usize = 512;

#[derive(Debug, Clone, Copy)]
struct CapabilityDefinition {
    id: &'static str,
    trusted_publishers: &'static [&'static str],
}

const DEFINITIONS: &[CapabilityDefinition] = &[
    CapabilityDefinition {
        id: "hestia/propose",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "hestia/approve",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "hestia/execute",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "chats/capture",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "userscripts/manage",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "key/public",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "key/sign",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "credential/manage",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "credential/use",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "model/generate",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "model/provide",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "mcp/pair",
        trusted_publishers: &["greenways-ai"],
    },
    CapabilityDefinition {
        id: "tahto/connect",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "tahto/read",
        trusted_publishers: &[],
    },
    CapabilityDefinition {
        id: "tahto/write",
        trusted_publishers: &[],
    },
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueCapabilityGrant {
    pub capability: String,
    pub subject: ApplicationApprovalSubject,
    #[serde(default)]
    pub constraints: BTreeMap<String, CapabilityConstraintValue>,
    pub issued_at_unix_ms: u64,
    pub expires_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityGrantView {
    pub grant: SignedCapabilityGrant,
    pub revocation: Option<SignedCapabilityRevocation>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityAuthorityStatus {
    pub protocol: String,
    pub state: String,
    pub revision: u64,
    pub grant_count: usize,
    pub active_grant_count: usize,
    pub revoked_grant_count: usize,
    pub expired_grant_count: usize,
    pub signed_records: bool,
    pub arbitrary_signing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityDecision {
    pub protocol: String,
    pub allowed: bool,
    pub reason: String,
    pub grant_id: Option<String>,
    pub capability: String,
    pub approval_digest: String,
    pub observed_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityAuthorityState {
    protocol: String,
    revision: u64,
    grants: Vec<SignedCapabilityGrant>,
    revocations: Vec<SignedCapabilityRevocation>,
}

impl Default for CapabilityAuthorityState {
    fn default() -> Self {
        Self {
            protocol: CAPABILITY_AUTHORITY_STATE_PROTOCOL.to_owned(),
            revision: 0,
            grants: Vec::new(),
            revocations: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum CapabilityError {
    Io(io::Error),
    Encoding(serde_json::Error),
    Identity(greenways_identity::IdentityError),
    Invalid(String),
    Conflict(String),
    NotFound(String),
}

impl fmt::Display for CapabilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "Greenways capability I/O failed: {error}"),
            Self::Encoding(_) => {
                formatter.write_str("Greenways capability authority encoding failed")
            }
            Self::Identity(error) => {
                write!(formatter, "Greenways capability signing failed: {error}")
            }
            Self::Invalid(message) => {
                write!(formatter, "Greenways capability authority is invalid: {message}")
            }
            Self::Conflict(message) => {
                write!(formatter, "Greenways capability authority conflict: {message}")
            }
            Self::NotFound(message) => {
                write!(formatter, "Greenways capability grant was not found: {message}")
            }
        }
    }
}

impl Error for CapabilityError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Encoding(error) => Some(error),
            Self::Identity(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for CapabilityError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for CapabilityError {
    fn from(value: serde_json::Error) -> Self {
        Self::Encoding(value)
    }
}

impl From<greenways_identity::IdentityError> for CapabilityError {
    fn from(value: greenways_identity::IdentityError) -> Self {
        Self::Identity(value)
    }
}

pub struct CapabilityAuthority {
    state_path: PathBuf,
    state: CapabilityAuthorityState,
}

impl fmt::Debug for CapabilityAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CapabilityAuthority")
            .field("state_path", &self.state_path)
            .field("revision", &self.state.revision)
            .field("grant_count", &self.state.grants.len())
            .field("revocation_count", &self.state.revocations.len())
            .finish()
    }
}

impl CapabilityAuthority {
    pub fn open(state_path: impl Into<PathBuf>) -> Result<Self, CapabilityError> {
        let state_path = state_path.into();
        let state = if state_path.exists() {
            load_state(&state_path)?
        } else {
            CapabilityAuthorityState::default()
        };
        validate_state(&state)?;
        Ok(Self { state_path, state })
    }

    pub fn status(&self, observed_at_unix_ms: u64) -> Result<CapabilityAuthorityStatus, CapabilityError> {
        validate_timestamp(observed_at_unix_ms, "capability status time")?;
        let views = self.list(observed_at_unix_ms)?;
        let active = views.iter().filter(|view| view.active).count();
        let revoked = views.iter().filter(|view| view.revocation.is_some()).count();
        let expired = views
            .iter()
            .filter(|view| {
                view.revocation.is_none()
                    && is_expired(&view.grant, observed_at_unix_ms)
            })
            .count();
        Ok(CapabilityAuthorityStatus {
            protocol: CAPABILITY_AUTHORITY_STATUS_PROTOCOL.to_owned(),
            state: "ready".to_owned(),
            revision: self.state.revision,
            grant_count: views.len(),
            active_grant_count: active,
            revoked_grant_count: revoked,
            expired_grant_count: expired,
            signed_records: true,
            arbitrary_signing: false,
        })
    }

    pub fn list(&self, observed_at_unix_ms: u64) -> Result<Vec<CapabilityGrantView>, CapabilityError> {
        validate_timestamp(observed_at_unix_ms, "capability list time")?;
        Ok(self
            .state
            .grants
            .iter()
            .cloned()
            .map(|grant| {
                let revocation = self
                    .state
                    .revocations
                    .iter()
                    .find(|revocation| revocation.revocation.grant_id == grant.grant.id)
                    .cloned();
                let active = revocation.is_none()
                    && grant.grant.issued_at_unix_ms <= observed_at_unix_ms
                    && !is_expired(&grant, observed_at_unix_ms);
                CapabilityGrantView {
                    grant,
                    revocation,
                    active,
                }
            })
            .collect())
    }

    pub fn issue(
        &mut self,
        signer: &ProfileIdentityVault,
        request: IssueCapabilityGrant,
    ) -> Result<SignedCapabilityGrant, CapabilityError> {
        let definition = validate_issue_request(&request)?;
        if !publisher_is_trusted(definition, &request.subject.publisher_id) {
            return Err(CapabilityError::Invalid(format!(
                "{} is restricted to a trusted publisher",
                request.capability
            )));
        }
        if self.state.grants.len() >= MAX_GRANTS {
            return Err(CapabilityError::Conflict(
                "capability grant limit has been reached".to_owned(),
            ));
        }
        let duplicate = self.state.grants.iter().any(|grant| {
            grant.grant.capability == request.capability
                && grant.grant.subject == request.subject
                && self
                    .state
                    .revocations
                    .iter()
                    .all(|revocation| revocation.revocation.grant_id != grant.grant.id)
                && !is_expired(grant, request.issued_at_unix_ms)
        });
        if duplicate {
            return Err(CapabilityError::Conflict(
                "an active exact capability grant already exists".to_owned(),
            ));
        }

        let signed = signer.sign_capability_grant(CapabilityGrantRequest {
            id: new_capability_grant_id()?,
            capability: request.capability,
            subject: request.subject,
            constraints: request.constraints,
            issued_at_unix_ms: request.issued_at_unix_ms,
            expires_at_unix_ms: request.expires_at_unix_ms,
        })?;
        verify_signed_capability_grant(&signed)?;
        validate_signed_grant_semantics(&signed)?;

        let mut next = self.state.clone();
        next.revision = next
            .revision
            .checked_add(1)
            .ok_or_else(|| CapabilityError::Invalid("capability revision overflowed".to_owned()))?;
        next.grants.push(signed.clone());
        persist_state(&self.state_path, &next)?;
        self.state = next;
        Ok(signed)
    }

    pub fn revoke(
        &mut self,
        signer: &ProfileIdentityVault,
        grant_id: &str,
        reason: &str,
        observed_at_unix_ms: u64,
    ) -> Result<SignedCapabilityRevocation, CapabilityError> {
        validate_timestamp(observed_at_unix_ms, "capability revocation time")?;
        let grant = self
            .state
            .grants
            .iter()
            .find(|grant| grant.grant.id == grant_id)
            .ok_or_else(|| CapabilityError::NotFound(grant_id.to_owned()))?;
        if let Some(existing) = self
            .state
            .revocations
            .iter()
            .find(|revocation| revocation.revocation.grant_id == grant_id)
        {
            return Ok(existing.clone());
        }
        if self.state.revocations.len() >= MAX_REVOCATIONS {
            return Err(CapabilityError::Conflict(
                "capability revocation limit has been reached".to_owned(),
            ));
        }
        if observed_at_unix_ms < grant.grant.issued_at_unix_ms {
            return Err(CapabilityError::Invalid(
                "capability revocation predates grant issuance".to_owned(),
            ));
        }
        let signer_identity = signer.public_identity().ok_or_else(|| {
            CapabilityError::Invalid("profile identity is not configured".to_owned())
        })?;
        if signer_identity.subject.id != grant.grant.issuer_identity_id
            || signer_identity.subject.key_id != grant.grant.issuer_key_id
        {
            return Err(CapabilityError::Conflict(
                "another profile identity cannot revoke this grant".to_owned(),
            ));
        }

        let signed = signer.sign_capability_revocation(CapabilityRevocationRequest {
            id: new_capability_revocation_id()?,
            grant_id: grant_id.to_owned(),
            reason: reason.to_owned(),
            revoked_at_unix_ms: observed_at_unix_ms,
        })?;
        verify_signed_capability_revocation(&signed)?;

        let mut next = self.state.clone();
        next.revision = next
            .revision
            .checked_add(1)
            .ok_or_else(|| CapabilityError::Invalid("capability revision overflowed".to_owned()))?;
        next.revocations.push(signed.clone());
        validate_state(&next)?;
        persist_state(&self.state_path, &next)?;
        self.state = next;
        Ok(signed)
    }

    pub fn check(
        &self,
        subject: &ApplicationApprovalSubject,
        capability: &str,
        observed_at_unix_ms: u64,
    ) -> Result<CapabilityDecision, CapabilityError> {
        validate_application_approval_subject(subject)?;
        validate_timestamp(observed_at_unix_ms, "capability decision time")?;
        let capability = normalize_capability(capability)?;
        if definition(&capability).is_none() {
            return Ok(decision(
                false,
                "capability-not-grantable",
                None,
                capability,
                subject,
                observed_at_unix_ms,
            ));
        }

        let matching = self
            .state
            .grants
            .iter()
            .filter(|grant| {
                grant.grant.capability == capability
                    && grant.grant.subject == *subject
                    && grant.grant.issued_at_unix_ms <= observed_at_unix_ms
            })
            .max_by_key(|grant| grant.grant.issued_at_unix_ms);
        let Some(grant) = matching else {
            return Ok(decision(
                false,
                "no-current-grant",
                None,
                capability,
                subject,
                observed_at_unix_ms,
            ));
        };
        if self
            .state
            .revocations
            .iter()
            .any(|revocation| revocation.revocation.grant_id == grant.grant.id)
        {
            return Ok(decision(
                false,
                "grant-revoked",
                Some(grant.grant.id.clone()),
                capability,
                subject,
                observed_at_unix_ms,
            ));
        }
        if is_expired(grant, observed_at_unix_ms) {
            return Ok(decision(
                false,
                "grant-expired",
                Some(grant.grant.id.clone()),
                capability,
                subject,
                observed_at_unix_ms,
            ));
        }
        Ok(decision(
            true,
            "granted",
            Some(grant.grant.id.clone()),
            capability,
            subject,
            observed_at_unix_ms,
        ))
    }
}

fn decision(
    allowed: bool,
    reason: &str,
    grant_id: Option<String>,
    capability: String,
    subject: &ApplicationApprovalSubject,
    observed_at_unix_ms: u64,
) -> CapabilityDecision {
    CapabilityDecision {
        protocol: CAPABILITY_DECISION_PROTOCOL.to_owned(),
        allowed,
        reason: reason.to_owned(),
        grant_id,
        capability,
        approval_digest: subject.approval_digest.clone(),
        observed_at_unix_ms,
    }
}

fn validate_issue_request(
    request: &IssueCapabilityGrant,
) -> Result<&'static CapabilityDefinition, CapabilityError> {
    validate_application_approval_subject(&request.subject)?;
    validate_timestamp(request.issued_at_unix_ms, "capability issue time")?;
    if request
        .expires_at_unix_ms
        .is_some_and(|expires| expires <= request.issued_at_unix_ms)
    {
        return Err(CapabilityError::Invalid(
            "capability expiry must follow issuance".to_owned(),
        ));
    }
    let capability = normalize_capability(&request.capability)?;
    if capability != request.capability {
        return Err(CapabilityError::Invalid(
            "capability must already be canonical".to_owned(),
        ));
    }
    definition(&capability).ok_or_else(|| {
        CapabilityError::Invalid("capability is not operation-grantable".to_owned())
    })
}

fn validate_signed_grant_semantics(
    signed: &SignedCapabilityGrant,
) -> Result<(), CapabilityError> {
    let definition = definition(&signed.grant.capability).ok_or_else(|| {
        CapabilityError::Invalid("stored capability is not operation-grantable".to_owned())
    })?;
    if !publisher_is_trusted(definition, &signed.grant.subject.publisher_id) {
        return Err(CapabilityError::Invalid(
            "stored capability publisher is not trusted".to_owned(),
        ));
    }
    Ok(())
}

fn validate_state(state: &CapabilityAuthorityState) -> Result<(), CapabilityError> {
    if state.protocol != CAPABILITY_AUTHORITY_STATE_PROTOCOL {
        return Err(CapabilityError::Invalid(
            "capability authority protocol is unsupported".to_owned(),
        ));
    }
    if state.grants.len() > MAX_GRANTS || state.revocations.len() > MAX_REVOCATIONS {
        return Err(CapabilityError::Invalid(
            "capability authority record count exceeds its bound".to_owned(),
        ));
    }
    if state.revision != (state.grants.len() + state.revocations.len()) as u64 {
        return Err(CapabilityError::Invalid(
            "capability authority revision does not match its records".to_owned(),
        ));
    }

    let mut grant_ids = HashSet::new();
    for grant in &state.grants {
        verify_signed_capability_grant(grant)?;
        validate_signed_grant_semantics(grant)?;
        if !grant_ids.insert(grant.grant.id.clone()) {
            return Err(CapabilityError::Invalid(
                "capability grant IDs must be unique".to_owned(),
            ));
        }
    }

    let mut revocation_ids = HashSet::new();
    let mut revoked_grants = HashSet::new();
    for revocation in &state.revocations {
        verify_signed_capability_revocation(revocation)?;
        if !revocation_ids.insert(revocation.revocation.id.clone())
            || !revoked_grants.insert(revocation.revocation.grant_id.clone())
        {
            return Err(CapabilityError::Invalid(
                "capability revocations must be unique".to_owned(),
            ));
        }
        let grant = state
            .grants
            .iter()
            .find(|grant| grant.grant.id == revocation.revocation.grant_id)
            .ok_or_else(|| {
                CapabilityError::Invalid(
                    "capability revocation references an unknown grant".to_owned(),
                )
            })?;
        if grant.grant.issuer_identity_id != revocation.revocation.issuer_identity_id
            || grant.grant.issuer_key_id != revocation.revocation.issuer_key_id
            || revocation.revocation.revoked_at_unix_ms < grant.grant.issued_at_unix_ms
        {
            return Err(CapabilityError::Invalid(
                "capability revocation does not match its grant authority".to_owned(),
            ));
        }
    }
    Ok(())
}

fn load_state(path: &Path) -> Result<CapabilityAuthorityState, CapabilityError> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err(CapabilityError::Invalid(
            "capability authority state exceeds its byte limit".to_owned(),
        ));
    }
    let state = serde_json::from_slice(&bytes)?;
    validate_state(&state)?;
    Ok(state)
}

fn persist_state(
    path: &Path,
    state: &CapabilityAuthorityState,
) -> Result<(), CapabilityError> {
    validate_state(state)?;
    let mut bytes = serde_json::to_vec_pretty(state)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_STATE_BYTES {
        return Err(CapabilityError::Invalid(
            "capability authority state exceeds its byte limit".to_owned(),
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        CapabilityError::Invalid("capability authority state has no parent".to_owned())
    })?;
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
        return Err(CapabilityError::Io(error));
    }
    Ok(())
}

fn definition(capability: &str) -> Option<&'static CapabilityDefinition> {
    DEFINITIONS.iter().find(|definition| definition.id == capability)
}

fn publisher_is_trusted(
    definition: &CapabilityDefinition,
    publisher_id: &str,
) -> bool {
    definition.trusted_publishers.is_empty()
        || definition
            .trusted_publishers
            .contains(&publisher_id)
}

fn normalize_capability(value: &str) -> Result<String, CapabilityError> {
    let value = value.trim().to_ascii_lowercase();
    let mut parts = value.split('/');
    let Some(left) = parts.next() else {
        return Err(CapabilityError::Invalid("capability is invalid".to_owned()));
    };
    let Some(right) = parts.next() else {
        return Err(CapabilityError::Invalid("capability is invalid".to_owned()));
    };
    if parts.next().is_some() || !valid_token(left) || !valid_token(right) {
        return Err(CapabilityError::Invalid("capability is invalid".to_owned()));
    }
    Ok(value)
}

fn valid_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn validate_timestamp(value: u64, label: &str) -> Result<(), CapabilityError> {
    if value == 0 {
        Err(CapabilityError::Invalid(format!("{label} must be positive")))
    } else {
        Ok(())
    }
}

fn is_expired(grant: &SignedCapabilityGrant, observed_at_unix_ms: u64) -> bool {
    grant
        .grant
        .expires_at_unix_ms
        .is_some_and(|expires| observed_at_unix_ms >= expires)
}

fn ensure_private_dir(path: &Path) -> Result<(), CapabilityError> {
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
    use greenways_identity::{ProfileIdentityVault, DIGEST_TEST_VALUE};
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_HOME: AtomicUsize = AtomicUsize::new(1);

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(label: &str) -> Self {
            let sequence = NEXT_HOME.fetch_add(1, Ordering::Relaxed);
            Self(std::env::temp_dir().join(format!(
                "greenways-capabilities-{label}-{}-{sequence}",
                process::id()
            )))
        }

        fn identity(&self) -> PathBuf {
            self.0.join("identity.json")
        }

        fn capabilities(&self) -> PathBuf {
            self.0.join("capabilities.json")
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn signer(home: &TestHome) -> ProfileIdentityVault {
        let mut signer = ProfileIdentityVault::open_test(home.identity())
            .expect("test profile identity should open");
        signer
            .create("authority", 1_000)
            .expect("test profile identity should be created");
        signer
    }

    fn subject(publisher: &str, digest: &str) -> ApplicationApprovalSubject {
        ApplicationApprovalSubject {
            kind: "app".to_owned(),
            app_id: "hara-playground".to_owned(),
            version: "1.2.3".to_owned(),
            publisher_id: publisher.to_owned(),
            lock_digest: None,
            approval_digest: digest.to_owned(),
        }
    }

    #[test]
    fn issues_checks_and_revokes_an_exact_signed_grant() {
        let home = TestHome::new("lifecycle");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        let approval = subject("hara-lang", DIGEST_TEST_VALUE);
        let grant = authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "model/generate".to_owned(),
                    subject: approval.clone(),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: Some(10_000),
                },
            )
            .expect("capability grant should issue");
        assert!(verify_signed_capability_grant(&grant).is_ok());
        let allowed = authority
            .check(&approval, "model/generate", 3_000)
            .expect("capability decision should complete");
        assert!(allowed.allowed);
        assert_eq!(allowed.grant_id.as_deref(), Some(grant.grant.id.as_str()));

        let changed = subject(
            "hara-lang",
            "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        );
        assert!(!authority
            .check(&changed, "model/generate", 3_000)
            .expect("changed approval decision")
            .allowed);

        let revocation = authority
            .revoke(&signer, &grant.grant.id, "user-revoked", 4_000)
            .expect("grant should revoke");
        assert!(verify_signed_capability_revocation(&revocation).is_ok());
        let denied = authority
            .check(&approval, "model/generate", 5_000)
            .expect("revoked decision should complete");
        assert!(!denied.allowed);
        assert_eq!(denied.reason, "grant-revoked");
        assert_eq!(authority.status(5_000).expect("status").revoked_grant_count, 1);
    }

    #[test]
    fn enforces_the_closed_vocabulary_and_trusted_publishers() {
        let home = TestHome::new("policy");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        assert!(authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "device/root".to_owned(),
                    subject: subject("greenways-ai", DIGEST_TEST_VALUE),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .is_err());
        assert!(authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "chats/capture".to_owned(),
                    subject: subject("other-publisher", DIGEST_TEST_VALUE),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .is_err());
        assert!(authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "chats/capture".to_owned(),
                    subject: subject("greenways-ai", DIGEST_TEST_VALUE),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .is_ok());
    }

    #[test]
    fn expiration_and_duplicate_issue_are_fail_closed() {
        let home = TestHome::new("expiration");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        let approval = subject("hara-lang", DIGEST_TEST_VALUE);
        let request = IssueCapabilityGrant {
            capability: "model/generate".to_owned(),
            subject: approval.clone(),
            constraints: BTreeMap::new(),
            issued_at_unix_ms: 2_000,
            expires_at_unix_ms: Some(3_000),
        };
        authority
            .issue(&signer, request.clone())
            .expect("first grant should issue");
        assert!(authority.issue(&signer, request).is_err());
        let decision = authority
            .check(&approval, "model/generate", 3_000)
            .expect("expired decision should complete");
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "grant-expired");
    }

    #[test]
    fn rejects_tampered_persisted_signed_records() {
        let home = TestHome::new("tamper");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "model/generate".to_owned(),
                    subject: subject("hara-lang", DIGEST_TEST_VALUE),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .expect("grant should issue");
        let mut state: serde_json::Value = serde_json::from_slice(
            &fs::read(home.capabilities()).expect("capability state"),
        )
        .expect("capability state JSON");
        state["grants"][0]["grant"]["capability"] =
            serde_json::Value::String("tahto/write".to_owned());
        fs::write(
            home.capabilities(),
            serde_json::to_vec_pretty(&state).expect("tampered state JSON"),
        )
        .expect("tampered state should write");
        assert!(CapabilityAuthority::open(home.capabilities()).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_capability_authority_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let home = TestHome::new("permissions");
        let signer = signer(&home);
        let mut authority = CapabilityAuthority::open(home.capabilities())
            .expect("capability authority should open");
        authority
            .issue(
                &signer,
                IssueCapabilityGrant {
                    capability: "model/generate".to_owned(),
                    subject: subject("hara-lang", DIGEST_TEST_VALUE),
                    constraints: BTreeMap::new(),
                    issued_at_unix_ms: 2_000,
                    expires_at_unix_ms: None,
                },
            )
            .expect("grant should issue");
        assert_eq!(
            fs::metadata(home.capabilities())
                .expect("capability metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(home.capabilities().parent().expect("capability parent"))
                .expect("capability parent metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
