from __future__ import annotations

from pathlib import Path
import re


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    path.write_text(text.replace(old, new))


def matching_brace(text: str, opening: int) -> int:
    depth = 0
    in_string = False
    escaped = False
    for index in range(opening, len(text)):
        char = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
    raise SystemExit("unbalanced Rust braces")


root = Path("Cargo.toml")
text = root.read_text()
member = '  "crates/greenways-applications",\n'
if member not in text:
    anchor = '  "crates/greenways-authority",\n'
    if text.count(anchor) != 1:
        raise SystemExit("workspace application member anchor is not unique")
    text = text.replace(anchor, anchor + member)
root.write_text(text)

identity = Path("crates/greenways-identity/src/lib.rs")
text = identity.read_text()
if "ApplicationApproval {" not in text:
    marker = "pub enum ProfileSignSubject {"
    start = text.index(marker)
    opening = text.index("{", start)
    closing = matching_brace(text, opening)
    variants = '''    ApplicationApproval {
        application: CapabilitySubject,
        declared_capabilities: Vec<String>,
    },
    ApplicationRevocation {
        approval_root: String,
        application: CapabilitySubject,
    },
'''
    text = text[:closing] + variants + text[closing:]

if '"kind": "application-approval"' not in text:
    marker = "fn subject_payload(subject: &ProfileSignSubject)"
    start = text.index(marker)
    function_open = text.index("{", start)
    function_close = matching_brace(text, function_open)
    function = text[function_open:function_close + 1]
    match_index = function.index("match subject")
    match_open = function.index("{", match_index)
    absolute_match_open = function_open + match_open
    absolute_match_close = matching_brace(text, absolute_match_open)
    arms = '''        ProfileSignSubject::ApplicationApproval {
            application,
            declared_capabilities,
        } => serde_json::json!({
            "kind": "application-approval",
            "application": application,
            "declaredCapabilities": declared_capabilities,
        }),
        ProfileSignSubject::ApplicationRevocation {
            approval_root,
            application,
        } => serde_json::json!({
            "kind": "application-revocation",
            "approvalRoot": approval_root,
            "application": application,
        }),
'''
    text = text[:absolute_match_close] + arms + text[absolute_match_close:]
identity.write_text(text)

capabilities = Path("crates/greenways-capabilities/src/lib.rs")
text = capabilities.read_text()
if "pub fn normalize_declared_capabilities" not in text:
    issue_marker = "pub fn issue_application_grant"
    issue_start = text.index(issue_marker)
    issue_open = text.index("{", issue_start)
    issue_close = matching_brace(text, issue_open)
    issue_body = text[issue_open:issue_close]
    match = re.search(r"let\s+capability\s*=\s*(.+?);", issue_body, flags=re.DOTALL)
    if not match:
        raise SystemExit("could not discover capability normalization expression")
    expression = " ".join(match.group(1).split())
    helper = f'''

#[derive(Debug)]
pub enum DeclaredCapabilityError {{
    Capability(CapabilityError),
    TooMany,
    Duplicate(String),
}}

impl std::fmt::Display for DeclaredCapabilityError {{
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {{
        match self {{
            Self::Capability(error) => write!(formatter, "{{error}}"),
            Self::TooMany => formatter.write_str("an application cannot declare more than 64 capabilities"),
            Self::Duplicate(capability) => write!(formatter, "application capability {{capability}} is duplicated"),
        }}
    }}
}}

impl std::error::Error for DeclaredCapabilityError {{
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {{
        match self {{
            Self::Capability(error) => Some(error),
            _ => None,
        }}
    }}
}}

impl From<CapabilityError> for DeclaredCapabilityError {{
    fn from(error: CapabilityError) -> Self {{
        Self::Capability(error)
    }}
}}

pub fn normalize_declared_capabilities(
    values: &[String],
) -> Result<Vec<String>, DeclaredCapabilityError> {{
    if values.len() > 64 {{
        return Err(DeclaredCapabilityError::TooMany);
    }}
    let mut output = Vec::with_capacity(values.len());
    let mut seen = std::collections::BTreeSet::new();
    for capability in values {{
        let capability = {expression};
        if !seen.insert(capability.clone()) {{
            return Err(DeclaredCapabilityError::Duplicate(capability));
        }}
        output.push(capability);
    }}
    output.sort();
    Ok(output)
}}
'''
    text += helper
capabilities.write_text(text)

crate = Path("crates/greenways-applications")
(crate / "src").mkdir(parents=True, exist_ok=True)
(crate / "Cargo.toml").write_text('''[package]
name = "greenways-applications"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
greenways-capabilities = { path = "../greenways-capabilities" }
greenways-identity = { path = "../greenways-identity" }
serde.workspace = true
serde_json.workspace = true

[lints]
workspace = true
''')

(crate / "src/lib.rs").write_text(r'''use greenways_capabilities::{
    normalize_declared_capabilities, DeclaredCapabilityError,
};
use greenways_identity::{
    verify_signed_profile_identity, CapabilitySubject, IdentityError, ProfileSignSubject,
    ProfileSigner, SignedProfileIdentity,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    error::Error,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};

pub const APPLICATION_APPROVAL_PROTOCOL: &str = "greenways-application-approval/0-alpha";
pub const APPLICATION_APPROVAL_STATUS_PROTOCOL: &str =
    "greenways-application-approval-status/0-alpha";
const STATE_PROTOCOL: &str = "greenways-application-approvals/0-alpha";
const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ACTIONS: usize = 2_048;

#[derive(Debug)]
pub enum ApplicationApprovalError {
    Io(io::Error),
    Encoding(serde_json::Error),
    Identity(IdentityError),
    Capability(DeclaredCapabilityError),
    Invalid(String),
    Conflict(String),
    NotFound(String),
}

impl fmt::Display for ApplicationApprovalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(_) => formatter.write_str("application approval storage is unavailable"),
            Self::Encoding(_) => formatter.write_str("application approval state is not valid JSON"),
            Self::Identity(error) => write!(formatter, "application approval identity failed: {error}"),
            Self::Capability(error) => write!(formatter, "application approval capability failed: {error}"),
            Self::Invalid(message) => write!(formatter, "application approval is invalid: {message}"),
            Self::Conflict(message) => write!(formatter, "application approval conflicts: {message}"),
            Self::NotFound(message) => write!(formatter, "application approval was not found: {message}"),
        }
    }
}

impl Error for ApplicationApprovalError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Encoding(error) => Some(error),
            Self::Identity(error) => Some(error),
            Self::Capability(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for ApplicationApprovalError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ApplicationApprovalError {
    fn from(error: serde_json::Error) -> Self {
        Self::Encoding(error)
    }
}

impl From<IdentityError> for ApplicationApprovalError {
    fn from(error: IdentityError) -> Self {
        Self::Identity(error)
    }
}

impl From<DeclaredCapabilityError> for ApplicationApprovalError {
    fn from(error: DeclaredCapabilityError) -> Self {
        Self::Capability(error)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationApproval {
    pub protocol: String,
    pub approval_root: String,
    pub application: CapabilitySubject,
    pub declared_capabilities: Vec<String>,
    pub approved_at_unix_ms: u64,
    pub revoked_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplicationApprovalStatus {
    pub protocol: String,
    pub configured: bool,
    pub revision: u64,
    pub approvals: usize,
    pub active: usize,
    pub revoked: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedState {
    protocol: String,
    revision: u64,
    actions: Vec<SignedProfileIdentity>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            protocol: STATE_PROTOCOL.to_owned(),
            revision: 0,
            actions: Vec::new(),
        }
    }
}

pub struct ApplicationApprovalAuthority<S: ProfileSigner> {
    path: PathBuf,
    signer: S,
    state: PersistedState,
}

impl<S: ProfileSigner> ApplicationApprovalAuthority<S> {
    pub fn open(path: impl Into<PathBuf>, signer: S) -> Result<Self, ApplicationApprovalError> {
        let path = path.into();
        let state = load_state(&path)?;
        validate_state(&state, signer.profile_public_card().as_ref())?;
        Ok(Self { path, signer, state })
    }

    pub fn status(&self) -> Result<ApplicationApprovalStatus, ApplicationApprovalError> {
        let approvals = rebuild(&self.state, self.signer.profile_public_card().as_ref())?;
        let revoked = approvals
            .values()
            .filter(|approval| approval.revoked_at_unix_ms.is_some())
            .count();
        Ok(ApplicationApprovalStatus {
            protocol: APPLICATION_APPROVAL_STATUS_PROTOCOL.to_owned(),
            configured: self.signer.profile_public_card().is_some(),
            revision: self.state.revision,
            approvals: approvals.len(),
            active: approvals.len().saturating_sub(revoked),
            revoked,
        })
    }

    pub fn list(&self) -> Result<Vec<ApplicationApproval>, ApplicationApprovalError> {
        Ok(rebuild(&self.state, self.signer.profile_public_card().as_ref())?
            .into_values()
            .collect())
    }

    pub fn approve(
        &mut self,
        application: CapabilitySubject,
        declared_capabilities: Vec<String>,
        observed_at_unix_ms: u64,
    ) -> Result<ApplicationApproval, ApplicationApprovalError> {
        validate_application_subject(&application)?;
        validate_timestamp(observed_at_unix_ms, "approval timestamp")?;
        let declared_capabilities = normalize_declared_capabilities(&declared_capabilities)?;
        let approvals = rebuild(&self.state, self.signer.profile_public_card().as_ref())?;
        if let Some(existing) = approvals.values().find(|approval| {
            approval.revoked_at_unix_ms.is_none()
                && exact_application(&approval.application, &application).unwrap_or(false)
        }) {
            return Err(ApplicationApprovalError::Conflict(format!(
                "the exact application is already approved at {}",
                existing.approval_root
            )));
        }
        let proof = self.signer.sign_capability_subject(
            ProfileSignSubject::ApplicationApproval {
                application: application.clone(),
                declared_capabilities: declared_capabilities.clone(),
            },
            observed_at_unix_ms,
        )?;
        verify_signed_profile_identity(&proof)?;
        let root = proof.body_digest.clone();
        self.append(proof)?;
        rebuild(&self.state, self.signer.profile_public_card().as_ref())?
            .remove(&root)
            .ok_or_else(|| ApplicationApprovalError::Invalid("committed approval disappeared".to_owned()))
    }

    pub fn revoke(
        &mut self,
        approval_root: &str,
        observed_at_unix_ms: u64,
    ) -> Result<ApplicationApproval, ApplicationApprovalError> {
        validate_digest(approval_root, "approval root")?;
        validate_timestamp(observed_at_unix_ms, "revocation timestamp")?;
        let approvals = rebuild(&self.state, self.signer.profile_public_card().as_ref())?;
        let approval = approvals
            .get(approval_root)
            .ok_or_else(|| ApplicationApprovalError::NotFound(approval_root.to_owned()))?;
        if approval.revoked_at_unix_ms.is_some() {
            return Err(ApplicationApprovalError::Conflict(
                "an application approval cannot be revoked twice".to_owned(),
            ));
        }
        if observed_at_unix_ms < approval.approved_at_unix_ms {
            return Err(ApplicationApprovalError::Invalid(
                "revocation predates approval".to_owned(),
            ));
        }
        let proof = self.signer.sign_capability_subject(
            ProfileSignSubject::ApplicationRevocation {
                approval_root: approval_root.to_owned(),
                application: approval.application.clone(),
            },
            observed_at_unix_ms,
        )?;
        verify_signed_profile_identity(&proof)?;
        self.append(proof)?;
        rebuild(&self.state, self.signer.profile_public_card().as_ref())?
            .remove(approval_root)
            .ok_or_else(|| ApplicationApprovalError::Invalid("committed approval disappeared".to_owned()))
    }

    pub fn authorize_exact(
        &self,
        application: &CapabilitySubject,
        capability: &str,
    ) -> Result<bool, ApplicationApprovalError> {
        validate_application_subject(application)?;
        let normalized = normalize_declared_capabilities(&[capability.to_owned()])?;
        let capability = normalized
            .first()
            .ok_or_else(|| ApplicationApprovalError::Invalid("capability is empty".to_owned()))?;
        Ok(rebuild(&self.state, self.signer.profile_public_card().as_ref())?
            .values()
            .any(|approval| {
                approval.revoked_at_unix_ms.is_none()
                    && exact_application(&approval.application, application).unwrap_or(false)
                    && approval.declared_capabilities.contains(capability)
            }))
    }

    pub fn into_signer(self) -> S {
        self.signer
    }

    fn append(&mut self, proof: SignedProfileIdentity) -> Result<(), ApplicationApprovalError> {
        if self.state.actions.len() >= MAX_ACTIONS {
            return Err(ApplicationApprovalError::Invalid(
                "application approval history is full".to_owned(),
            ));
        }
        let previous = self.state.clone();
        self.state.revision = self
            .state
            .revision
            .checked_add(1)
            .ok_or_else(|| ApplicationApprovalError::Invalid("revision overflowed".to_owned()))?;
        self.state.actions.push(proof);
        if let Err(error) = validate_state(&self.state, self.signer.profile_public_card().as_ref())
            .and_then(|_| write_state(&self.path, &self.state))
        {
            self.state = previous;
            return Err(error);
        }
        Ok(())
    }
}

fn load_state(path: &Path) -> Result<PersistedState, ApplicationApprovalError> {
    if !path.exists() {
        return Ok(PersistedState::default());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(ApplicationApprovalError::Invalid(
            "state path must be a regular file".to_owned(),
        ));
    }
    if metadata.len() > MAX_STATE_BYTES as u64 {
        return Err(ApplicationApprovalError::Invalid(
            "state exceeds its byte limit".to_owned(),
        ));
    }
    let bytes = fs::read(path)?;
    let state: PersistedState = serde_json::from_slice(&bytes)?;
    Ok(state)
}

fn validate_state(
    state: &PersistedState,
    expected_identity: Option<&greenways_identity::ProfileIdentityCard>,
) -> Result<(), ApplicationApprovalError> {
    if state.protocol != STATE_PROTOCOL {
        return Err(ApplicationApprovalError::Invalid(
            "state protocol is unsupported".to_owned(),
        ));
    }
    if state.actions.len() > MAX_ACTIONS || state.revision != state.actions.len() as u64 {
        return Err(ApplicationApprovalError::Invalid(
            "state revision or action bound is invalid".to_owned(),
        ));
    }
    let _ = rebuild(state, expected_identity)?;
    Ok(())
}

fn rebuild(
    state: &PersistedState,
    expected_identity: Option<&greenways_identity::ProfileIdentityCard>,
) -> Result<BTreeMap<String, ApplicationApproval>, ApplicationApprovalError> {
    let mut approvals = BTreeMap::new();
    for proof in &state.actions {
        verify_signed_profile_identity(proof)?;
        if let Some(expected) = expected_identity {
            if serde_json::to_value(&proof.identity)? != serde_json::to_value(expected)? {
                return Err(ApplicationApprovalError::Invalid(
                    "signed action belongs to another profile identity".to_owned(),
                ));
            }
        }
        match &proof.subject {
            ProfileSignSubject::ApplicationApproval {
                application,
                declared_capabilities,
            } => {
                validate_application_subject(application)?;
                validate_timestamp(proof.issued_at_unix_ms, "approval timestamp")?;
                let normalized = normalize_declared_capabilities(declared_capabilities)?;
                if &normalized != declared_capabilities {
                    return Err(ApplicationApprovalError::Invalid(
                        "declared capabilities are not canonical".to_owned(),
                    ));
                }
                validate_digest(&proof.body_digest, "approval root")?;
                let approval = ApplicationApproval {
                    protocol: APPLICATION_APPROVAL_PROTOCOL.to_owned(),
                    approval_root: proof.body_digest.clone(),
                    application: application.clone(),
                    declared_capabilities: normalized,
                    approved_at_unix_ms: proof.issued_at_unix_ms,
                    revoked_at_unix_ms: None,
                };
                if approvals.insert(proof.body_digest.clone(), approval).is_some() {
                    return Err(ApplicationApprovalError::Invalid(
                        "approval root is duplicated".to_owned(),
                    ));
                }
            }
            ProfileSignSubject::ApplicationRevocation {
                approval_root,
                application,
            } => {
                validate_application_subject(application)?;
                validate_digest(approval_root, "revoked approval root")?;
                validate_timestamp(proof.issued_at_unix_ms, "revocation timestamp")?;
                let approval = approvals.get_mut(approval_root).ok_or_else(|| {
                    ApplicationApprovalError::Invalid(
                        "revocation does not name an earlier approval".to_owned(),
                    )
                })?;
                if approval.revoked_at_unix_ms.is_some() {
                    return Err(ApplicationApprovalError::Invalid(
                        "approval has multiple revocations".to_owned(),
                    ));
                }
                if !exact_application(&approval.application, application)? {
                    return Err(ApplicationApprovalError::Invalid(
                        "revocation application identity does not match".to_owned(),
                    ));
                }
                if proof.issued_at_unix_ms < approval.approved_at_unix_ms {
                    return Err(ApplicationApprovalError::Invalid(
                        "revocation predates approval".to_owned(),
                    ));
                }
                approval.revoked_at_unix_ms = Some(proof.issued_at_unix_ms);
            }
            _ => {
                return Err(ApplicationApprovalError::Invalid(
                    "state contains a non-application signed action".to_owned(),
                ))
            }
        }
    }
    Ok(approvals)
}

fn validate_application_subject(
    application: &CapabilitySubject,
) -> Result<(), ApplicationApprovalError> {
    let value = serde_json::to_value(application)?;
    let object = value.as_object().ok_or_else(|| {
        ApplicationApprovalError::Invalid("application identity is not an object".to_owned())
    })?;
    if object.get("kind").and_then(Value::as_str) != Some("application") {
        return Err(ApplicationApprovalError::Invalid(
            "only application subjects can be approved".to_owned(),
        ));
    }
    Ok(())
}

fn exact_application(
    left: &CapabilitySubject,
    right: &CapabilitySubject,
) -> Result<bool, ApplicationApprovalError> {
    Ok(serde_json::to_value(left)? == serde_json::to_value(right)?)
}

fn validate_digest(value: &str, label: &str) -> Result<(), ApplicationApprovalError> {
    let valid = value
        .strip_prefix("sha256:")
        .is_some_and(|digest| digest.len() == 64 && digest.bytes().all(|byte| {
            byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
        }));
    if valid {
        Ok(())
    } else {
        Err(ApplicationApprovalError::Invalid(format!(
            "{label} must be sha256:<64 lowercase hex characters>"
        )))
    }
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

fn write_state(path: &Path, state: &PersistedState) -> Result<(), ApplicationApprovalError> {
    let mut bytes = serde_json::to_vec_pretty(state)?;
    bytes.push(b'\n');
    if bytes.len() > MAX_STATE_BYTES {
        return Err(ApplicationApprovalError::Invalid(
            "state exceeds its byte limit".to_owned(),
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        ApplicationApprovalError::Invalid("state path has no parent".to_owned())
    })?;
    fs::create_dir_all(parent)?;
    set_private_directory(parent)?;
    let temporary = path.with_extension(format!("json.tmp-{}", std::process::id()));
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
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn set_private_directory(path: &Path) -> Result<(), ApplicationApprovalError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    let _ = path;
    Ok(())
}

fn set_private_file(path: &Path) -> Result<(), ApplicationApprovalError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    let _ = path;
    Ok(())
}
''')

Path("protocol/application-approvals.md").write_text('''# Daemon-owned application approvals

Status: first exact application-approval authority slice for issue #51.

`greenwaysd` must not trust an application ID supplied by a caller. Before an
application grant can authorize an operation, the daemon needs an approval for
one exact application identity:

```text
application id
+ semantic version
+ publisher id
+ manifest digest
+ lock digest
+ declared capability set
```

The approval registry introduced here is signed by the daemon-owned profile
identity and persisted independently of browser or Flutter state. A changed
version, publisher, manifest, lock, or declared capability set is not the same
approval.

## Signed transitions

The profile signer accepts two additional closed typed subjects:

```text
application-approval
application-revocation
```

An approval root is the signed proof body digest. Revocation names that exact
root and repeats the exact application identity. Revocation is final for the
named root and survives daemon restart.

## Authorization seam

`authorize_exact(application, capability)` succeeds only when:

1. the subject is an application subject;
2. an active approval matches every application identity field;
3. the capability appears in the approval's canonical declared set; and
4. no signed revocation names the approval root.

This seam does not yet invoke providers or execute application work. The next
slice combines an exact active application approval with an active signed
capability grant at the operation boundary.

## Exclusions

The ordinary application authority does not expose:

```text
kernel.eval
private keys
provider credentials
arbitrary signing
generic database or filesystem access
caller-selected publishers or manifests
```
''')

capability_doc = Path("protocol/capability-grants.md")
if capability_doc.exists():
    text = capability_doc.read_text()
    marker = "## Next release boundary"
    if marker in text and "application approval registry is now" not in text:
        prefix, suffix = text.split(marker, 1)
        suffix = suffix.lstrip("\n")
        replacement = '''## Next release boundary

The signed application approval registry is now defined in
`protocol/application-approvals.md`. The following slice must combine one exact
active application approval with one active capability grant before a daemon
operation such as provider/model invocation is authorized.

'''
        capability_doc.write_text(prefix + replacement + suffix)

print("materialized daemon-owned signed application approval registry")
