use greenways_identity::{
    application_approval_subject, new_application_revocation_id, normalize_operation_capability,
    validate_application_approval_subject, verify_signed_application_approval,
    verify_signed_application_revocation, ApplicationApprovalRequest, ApplicationApprovalSubject,
    ApplicationDescriptor, ApplicationRevocationRequest, IdentityError, ProfileIdentityVault,
    SignedApplicationApproval, SignedApplicationRevocation,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
};

pub const APPLICATION_AUTHORITY_STATE_PROTOCOL: &str =
    "greenways-application-authority-state/0-alpha";
pub const APPLICATION_AUTHORITY_STATUS_PROTOCOL: &str =
    "greenways-application-authority-status/0-alpha";
pub const APPLICATION_AUTHORIZATION_PROTOCOL: &str = "greenways-application-authorization/0-alpha";

const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_APPROVALS: usize = 512;
const MAX_REVOCATIONS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationApprovalView {
    pub approval: SignedApplicationApproval,
    pub revocation: Option<SignedApplicationRevocation>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationAuthorityStatus {
    pub protocol: String,
    pub state: String,
    pub revision: u64,
    pub approval_count: usize,
    pub active_approval_count: usize,
    pub revoked_approval_count: usize,
    pub pending_approval_count: usize,
    pub signed_records: bool,
    pub arbitrary_signing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationAuthorization {
    pub protocol: String,
    pub allowed: bool,
    pub reason: String,
    pub approval_digest: String,
    pub capability: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplicationAuthorityState {
    protocol: String,
    revision: u64,
    approvals: Vec<SignedApplicationApproval>,
    revocations: Vec<SignedApplicationRevocation>,
}

impl Default for ApplicationAuthorityState {
    fn default() -> Self {
        Self {
            protocol: APPLICATION_AUTHORITY_STATE_PROTOCOL.to_owned(),
            revision: 0,
            approvals: Vec::new(),
            revocations: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub enum ApplicationApprovalError {
    Io(io::Error),
    Encoding(serde_json::Error),
    Identity(IdentityError),
    Invalid(String),
    Conflict(String),
    NotFound(String),
}

impl fmt::Display for ApplicationApprovalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(
                formatter,
                "Greenways application authority I/O failed: {error}"
            ),
            Self::Encoding(_) => {
                formatter.write_str("Greenways application authority encoding failed")
            }
            Self::Identity(error) => {
                write!(formatter, "Greenways application signing failed: {error}")
            }
            Self::Invalid(message) => {
                write!(
                    formatter,
                    "Greenways application authority is invalid: {message}"
                )
            }
            Self::Conflict(message) => {
                write!(
                    formatter,
                    "Greenways application authority conflict: {message}"
                )
            }
            Self::NotFound(message) => {
                write!(
                    formatter,
                    "Greenways application approval was not found: {message}"
                )
            }
        }
    }
}

impl Error for ApplicationApprovalError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Encoding(error) => Some(error),
            Self::Identity(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for ApplicationApprovalError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for ApplicationApprovalError {
    fn from(value: serde_json::Error) -> Self {
        Self::Encoding(value)
    }
}

impl From<IdentityError> for ApplicationApprovalError {
    fn from(value: IdentityError) -> Self {
        Self::Identity(value)
    }
}

pub struct ApplicationApprovalAuthority {
    state_path: PathBuf,
    state: ApplicationAuthorityState,
}

impl fmt::Debug for ApplicationApprovalAuthority {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ApplicationApprovalAuthority")
            .field("state_path", &self.state_path)
            .field("revision", &self.state.revision)
            .field("approval_count", &self.state.approvals.len())
            .field("revocation_count", &self.state.revocations.len())
            .finish()
    }
}

impl ApplicationApprovalAuthority {
    pub fn open(state_path: impl Into<PathBuf>) -> Result<Self, ApplicationApprovalError> {
        let state_path = state_path.into();
        let state = if state_path.exists() {
            load_state(&state_path)?
        } else {
            ApplicationAuthorityState::default()
        };
        validate_state(&state)?;
        Ok(Self { state_path, state })
    }

    pub fn status(
        &self,
        observed_at_unix_ms: u64,
    ) -> Result<ApplicationAuthorityStatus, ApplicationApprovalError> {
        validate_timestamp(observed_at_unix_ms, "application status time")?;
        let views = self.list(observed_at_unix_ms)?;
        Ok(ApplicationAuthorityStatus {
            protocol: APPLICATION_AUTHORITY_STATUS_PROTOCOL.to_owned(),
            state: "ready".to_owned(),
            revision: self.state.revision,
            approval_count: views.len(),
            active_approval_count: views.iter().filter(|view| view.active).count(),
            revoked_approval_count: views
                .iter()
                .filter(|view| view.revocation.is_some())
                .count(),
            pending_approval_count: views
                .iter()
                .filter(|view| {
                    view.revocation.is_none()
                        && view.approval.approval.approved_at_unix_ms > observed_at_unix_ms
                })
                .count(),
            signed_records: true,
            arbitrary_signing: false,
        })
    }

    pub fn list(
        &self,
        observed_at_unix_ms: u64,
    ) -> Result<Vec<ApplicationApprovalView>, ApplicationApprovalError> {
        validate_timestamp(observed_at_unix_ms, "application list time")?;
        Ok(self
            .state
            .approvals
            .iter()
            .cloned()
            .map(|approval| {
                let revocation = self
                    .state
                    .revocations
                    .iter()
                    .find(|revocation| {
                        revocation.revocation.approval_subject_root == approval.subject_root
                    })
                    .cloned();
                let active = revocation.is_none()
                    && approval.approval.approved_at_unix_ms <= observed_at_unix_ms;
                ApplicationApprovalView {
                    approval,
                    revocation,
                    active,
                }
            })
            .collect())
    }

    pub fn approve(
        &mut self,
        signer: &ProfileIdentityVault,
        request: ApplicationApprovalRequest,
    ) -> Result<SignedApplicationApproval, ApplicationApprovalError> {
        if self.state.approvals.len() >= MAX_APPROVALS {
            return Err(ApplicationApprovalError::Conflict(
                "application approval limit has been reached".to_owned(),
            ));
        }
        let coordinate = application_coordinate(&request.application);
        if self.state.approvals.iter().any(|approval| {
            application_coordinate(&approval.approval.application) == coordinate
                && !self.is_revoked(&approval.subject_root)
        }) {
            return Err(ApplicationApprovalError::Conflict(
                "an active approval already owns this application version".to_owned(),
            ));
        }

        let signed = signer.sign_application_approval(request)?;
        verify_signed_application_approval(&signed)?;
        if self
            .state
            .approvals
            .iter()
            .any(|approval| approval.subject_root == signed.subject_root)
        {
            return Err(ApplicationApprovalError::Conflict(
                "the exact application approval already exists".to_owned(),
            ));
        }

        let mut next = self.state.clone();
        next.revision = next.revision.checked_add(1).ok_or_else(|| {
            ApplicationApprovalError::Invalid(
                "application authority revision overflowed".to_owned(),
            )
        })?;
        next.approvals.push(signed.clone());
        validate_state(&next)?;
        persist_state(&self.state_path, &next)?;
        self.state = next;
        Ok(signed)
    }

    pub fn revoke(
        &mut self,
        signer: &ProfileIdentityVault,
        approval_subject_root: &str,
        reason: &str,
        observed_at_unix_ms: u64,
    ) -> Result<SignedApplicationRevocation, ApplicationApprovalError> {
        validate_timestamp(observed_at_unix_ms, "application revocation time")?;
        let approval = self
            .state
            .approvals
            .iter()
            .find(|approval| approval.subject_root == approval_subject_root)
            .ok_or_else(|| ApplicationApprovalError::NotFound(approval_subject_root.to_owned()))?;
        if let Some(existing) =
            self.state.revocations.iter().find(|revocation| {
                revocation.revocation.approval_subject_root == approval_subject_root
            })
        {
            return Ok(existing.clone());
        }
        if self.state.revocations.len() >= MAX_REVOCATIONS {
            return Err(ApplicationApprovalError::Conflict(
                "application revocation limit has been reached".to_owned(),
            ));
        }
        if observed_at_unix_ms < approval.approval.approved_at_unix_ms {
            return Err(ApplicationApprovalError::Invalid(
                "application revocation predates approval".to_owned(),
            ));
        }
        let signer_identity = signer.public_identity().ok_or_else(|| {
            ApplicationApprovalError::Invalid("profile identity is not configured".to_owned())
        })?;
        if signer_identity.subject.id != approval.approval.issuer_identity_id
            || signer_identity.subject.key_id != approval.approval.issuer_key_id
        {
            return Err(ApplicationApprovalError::Conflict(
                "another profile identity cannot revoke this approval".to_owned(),
            ));
        }

        let signed = signer.sign_application_revocation(ApplicationRevocationRequest {
            id: new_application_revocation_id()?,
            approval_subject_root: approval.subject_root.clone(),
            application: approval.approval.application.clone(),
            reason: reason.to_owned(),
            revoked_at_unix_ms: observed_at_unix_ms,
        })?;
        verify_signed_application_revocation(&signed)?;

        let mut next = self.state.clone();
        next.revision = next.revision.checked_add(1).ok_or_else(|| {
            ApplicationApprovalError::Invalid(
                "application authority revision overflowed".to_owned(),
            )
        })?;
        next.revocations.push(signed.clone());
        validate_state(&next)?;
        persist_state(&self.state_path, &next)?;
        self.state = next;
        Ok(signed)
    }

    pub fn authorize_subject(
        &self,
        subject: &ApplicationApprovalSubject,
        observed_at_unix_ms: u64,
    ) -> Result<ApplicationAuthorization, ApplicationApprovalError> {
        validate_application_approval_subject(subject)?;
        validate_timestamp(observed_at_unix_ms, "application authorization time")?;
        let capability = String::new();
        let Some(approval) = self
            .state
            .approvals
            .iter()
            .find(|approval| approval.subject_root == subject.approval_digest)
        else {
            return Ok(authorization(
                false,
                "approval-not-found",
                subject,
                capability,
            ));
        };
        if application_approval_subject(approval)? != *subject {
            return Ok(authorization(
                false,
                "approval-subject-mismatch",
                subject,
                capability,
            ));
        }
        if self.is_revoked(&approval.subject_root) {
            return Ok(authorization(
                false,
                "approval-revoked",
                subject,
                capability,
            ));
        }
        if approval.approval.approved_at_unix_ms > observed_at_unix_ms {
            return Ok(authorization(
                false,
                "approval-not-yet-effective",
                subject,
                capability,
            ));
        }
        Ok(authorization(true, "approved", subject, capability))
    }

    pub fn authorize_exact(
        &self,
        subject: &ApplicationApprovalSubject,
        capability: &str,
        observed_at_unix_ms: u64,
    ) -> Result<ApplicationAuthorization, ApplicationApprovalError> {
        let normalized = normalize_operation_capability(capability)?;
        if normalized != capability {
            return Err(ApplicationApprovalError::Invalid(
                "capability must already be canonical".to_owned(),
            ));
        }
        let subject_decision = self.authorize_subject(subject, observed_at_unix_ms)?;
        if !subject_decision.allowed {
            return Ok(ApplicationAuthorization {
                capability: normalized,
                ..subject_decision
            });
        }
        let approval = self
            .state
            .approvals
            .iter()
            .find(|approval| approval.subject_root == subject.approval_digest)
            .ok_or_else(|| {
                ApplicationApprovalError::Invalid(
                    "authorized application approval disappeared".to_owned(),
                )
            })?;
        if !approval
            .approval
            .declared_capabilities
            .iter()
            .any(|declared| declared == &normalized)
        {
            return Ok(authorization(
                false,
                "capability-not-declared",
                subject,
                normalized,
            ));
        }
        Ok(authorization(true, "approved", subject, normalized))
    }

    pub fn subject(
        &self,
        approval_subject_root: &str,
    ) -> Result<ApplicationApprovalSubject, ApplicationApprovalError> {
        let approval = self
            .state
            .approvals
            .iter()
            .find(|approval| approval.subject_root == approval_subject_root)
            .ok_or_else(|| ApplicationApprovalError::NotFound(approval_subject_root.to_owned()))?;
        application_approval_subject(approval).map_err(ApplicationApprovalError::from)
    }

    fn is_revoked(&self, approval_subject_root: &str) -> bool {
        self.state
            .revocations
            .iter()
            .any(|revocation| revocation.revocation.approval_subject_root == approval_subject_root)
    }
}

fn authorization(
    allowed: bool,
    reason: &str,
    subject: &ApplicationApprovalSubject,
    capability: String,
) -> ApplicationAuthorization {
    ApplicationAuthorization {
        protocol: APPLICATION_AUTHORIZATION_PROTOCOL.to_owned(),
        allowed,
        reason: reason.to_owned(),
        approval_digest: subject.approval_digest.clone(),
        capability,
    }
}

fn validate_state(state: &ApplicationAuthorityState) -> Result<(), ApplicationApprovalError> {
    if state.protocol != APPLICATION_AUTHORITY_STATE_PROTOCOL {
        return Err(ApplicationApprovalError::Invalid(
            "application authority protocol is unsupported".to_owned(),
        ));
    }
    if state.approvals.len() > MAX_APPROVALS || state.revocations.len() > MAX_REVOCATIONS {
        return Err(ApplicationApprovalError::Invalid(
            "application authority record count exceeds its bound".to_owned(),
        ));
    }
    if state.revision != (state.approvals.len() + state.revocations.len()) as u64 {
        return Err(ApplicationApprovalError::Invalid(
            "application authority revision does not match its records".to_owned(),
        ));
    }

    let mut approval_roots = HashSet::new();
    for approval in &state.approvals {
        verify_signed_application_approval(approval)?;
        if !approval_roots.insert(approval.subject_root.clone()) {
            return Err(ApplicationApprovalError::Invalid(
                "application approval roots must be unique".to_owned(),
            ));
        }
    }

    let mut revocation_ids = HashSet::new();
    let mut revoked_approvals = HashSet::new();
    for revocation in &state.revocations {
        verify_signed_application_revocation(revocation)?;
        if !revocation_ids.insert(revocation.revocation.id.clone())
            || !revoked_approvals.insert(revocation.revocation.approval_subject_root.clone())
        {
            return Err(ApplicationApprovalError::Invalid(
                "application revocations must be unique".to_owned(),
            ));
        }
        let approval = state
            .approvals
            .iter()
            .find(|approval| approval.subject_root == revocation.revocation.approval_subject_root)
            .ok_or_else(|| {
                ApplicationApprovalError::Invalid(
                    "application revocation references an unknown approval".to_owned(),
                )
            })?;
        if approval.approval.application != revocation.revocation.application
            || approval.approval.issuer_identity_id != revocation.revocation.issuer_identity_id
            || approval.approval.issuer_key_id != revocation.revocation.issuer_key_id
            || revocation.revocation.revoked_at_unix_ms < approval.approval.approved_at_unix_ms
        {
            return Err(ApplicationApprovalError::Invalid(
                "application revocation does not match its approval authority".to_owned(),
            ));
        }
    }

    let mut active_coordinates = HashSet::new();
    for approval in &state.approvals {
        if !revoked_approvals.contains(&approval.subject_root)
            && !active_coordinates.insert(application_coordinate(&approval.approval.application))
        {
            return Err(ApplicationApprovalError::Invalid(
                "multiple active approvals own one application version".to_owned(),
            ));
        }
    }
    Ok(())
}

fn application_coordinate(application: &ApplicationDescriptor) -> String {
    format!(
        "{}\u{0}{}\u{0}{}",
        application.app_id, application.version, application.publisher_id
    )
}

fn validate_timestamp(value: u64, label: &str) -> Result<(), ApplicationApprovalError> {
    if value == 0 {
        Err(ApplicationApprovalError::Invalid(format!(
            "{label} must be positive"
        )))
    } else {
        Ok(())
    }
}

fn load_state(path: &Path) -> Result<ApplicationAuthorityState, ApplicationApprovalError> {
    let bytes = fs::read(path)?;
    if bytes.len() > MAX_STATE_BYTES {
        return Err(ApplicationApprovalError::Invalid(
            "application authority state exceeds its byte limit".to_owned(),
        ));
    }
    let state = serde_json::from_slice(&bytes)?;
    validate_state(&state)?;
    Ok(state)
}

fn persist_state(
    path: &Path,
    state: &ApplicationAuthorityState,
) -> Result<(), ApplicationApprovalError> {
    validate_state(state)?;
    let mut bytes = serde_json::to_vec_pretty(state)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_STATE_BYTES {
        return Err(ApplicationApprovalError::Invalid(
            "application authority state exceeds its byte limit".to_owned(),
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        ApplicationApprovalError::Invalid("application authority state has no parent".to_owned())
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
        return Err(ApplicationApprovalError::Io(error));
    }
    Ok(())
}

fn ensure_private_dir(path: &Path) -> Result<(), ApplicationApprovalError> {
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
                "greenways-applications-{label}-{}-{sequence}",
                process::id()
            )))
        }

        fn identity(&self) -> PathBuf {
            self.0.join("profile-identity.json")
        }

        fn state(&self) -> PathBuf {
            self.0.join("applications.json")
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn identity(home: &TestHome) -> ProfileIdentityVault {
        let mut identity =
            ProfileIdentityVault::open_test(home.identity()).expect("identity vault should open");
        identity
            .create("authority", 1_000)
            .expect("identity should be created");
        identity
    }

    fn request() -> ApplicationApprovalRequest {
        ApplicationApprovalRequest {
            application: ApplicationDescriptor {
                app_id: "hara-playground".to_owned(),
                version: "1.2.3".to_owned(),
                publisher_id: "hara-lang".to_owned(),
                manifest_digest: DIGEST_TEST_VALUE.to_owned(),
                lock_digest: Some(format!("sha256:{}", "1".repeat(64))),
            },
            declared_capabilities: vec!["tahto/read".to_owned(), "model/generate".to_owned()],
            approved_at_unix_ms: 2_000,
        }
    }

    #[test]
    fn persists_exact_signed_approval_and_authorizes_declared_capabilities() {
        let home = TestHome::new("lifecycle");
        let signer = identity(&home);
        let approval = {
            let mut authority =
                ApplicationApprovalAuthority::open(home.state()).expect("authority should open");
            authority
                .approve(&signer, request())
                .expect("approval should commit")
        };
        let subject = application_approval_subject(&approval).expect("subject should derive");
        let reopened =
            ApplicationApprovalAuthority::open(home.state()).expect("authority should reopen");
        let decision = reopened
            .authorize_exact(&subject, "model/generate", 3_000)
            .expect("authorization should evaluate");
        assert!(decision.allowed);
        assert_eq!(decision.reason, "approved");
        assert_eq!(
            reopened
                .status(3_000)
                .expect("status")
                .active_approval_count,
            1
        );

        let denied = reopened
            .authorize_exact(&subject, "tahto/write", 3_000)
            .expect("undeclared decision should evaluate");
        assert!(!denied.allowed);
        assert_eq!(denied.reason, "capability-not-declared");
    }

    #[test]
    fn rejects_changed_subjects_duplicate_coordinates_and_tampering() {
        let home = TestHome::new("exactness");
        let signer = identity(&home);
        let mut authority =
            ApplicationApprovalAuthority::open(home.state()).expect("authority should open");
        let approval = authority
            .approve(&signer, request())
            .expect("approval should commit");
        assert!(matches!(
            authority.approve(&signer, request()),
            Err(ApplicationApprovalError::Conflict(_))
        ));

        let mut changed = application_approval_subject(&approval).expect("subject should derive");
        changed.version = "1.2.4".to_owned();
        let decision = authority
            .authorize_exact(&changed, "model/generate", 3_000)
            .expect("changed subject should evaluate");
        assert!(!decision.allowed);
        assert_eq!(decision.reason, "approval-subject-mismatch");

        let mut corrupt = authority.state.clone();
        corrupt.approvals[0].approval.application.manifest_digest =
            format!("sha256:{}", "2".repeat(64));
        assert!(validate_state(&corrupt).is_err());
    }

    #[test]
    fn revocation_is_restart_safe_and_cannot_be_redirected() {
        let home = TestHome::new("revocation");
        let signer = identity(&home);
        let mut authority =
            ApplicationApprovalAuthority::open(home.state()).expect("authority should open");
        let approval = authority
            .approve(&signer, request())
            .expect("approval should commit");
        let subject = application_approval_subject(&approval).expect("subject should derive");
        let revocation = authority
            .revoke(&signer, &approval.subject_root, "user-revoked", 4_000)
            .expect("revocation should commit");
        assert_eq!(
            authority
                .revoke(&signer, &approval.subject_root, "ignored", 5_000)
                .expect("repeat should return existing"),
            revocation
        );
        drop(authority);

        let reopened =
            ApplicationApprovalAuthority::open(home.state()).expect("authority should reopen");
        let denied = reopened
            .authorize_exact(&subject, "model/generate", 6_000)
            .expect("revoked decision should evaluate");
        assert!(!denied.allowed);
        assert_eq!(denied.reason, "approval-revoked");

        let mut redirected = reopened.state.clone();
        redirected.revocations[0].revocation.application.version = "9.9.9".to_owned();
        assert!(validate_state(&redirected).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn writes_private_application_authority_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let home = TestHome::new("permissions");
        let signer = identity(&home);
        let mut authority =
            ApplicationApprovalAuthority::open(home.state()).expect("authority should open");
        authority
            .approve(&signer, request())
            .expect("approval should commit");
        assert_eq!(
            fs::metadata(home.state())
                .expect("application state")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(home.state().parent().expect("application parent"))
                .expect("application parent metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
