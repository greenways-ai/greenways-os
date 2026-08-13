use crate::{
    HESTIA_ROOM_AUTHORITY_DECISION_PROTOCOL, HESTIA_ROOM_INVOCATION_PROTOCOL,
    PREPARED_ROOM_EXECUTION_PROTOCOL,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fmt,
};

pub const HESTIA_IMPORT_STATUS_PROTOCOL: &str = "greenways-hestia-import-status/0-alpha";
pub const HESTIA_IMPORT_STATE: &str = "pinned";
pub const HESTIA_IMPORT_REPOSITORY: &str = "greenways-ai/hestia";
pub const HESTIA_IMPORT_REVISION: &str = "64707d7a38216d800bcc22b8da215c3e6946e1bb";
pub const HESTIA_IMPORT_PACKAGE: &str = "@greenways/hestia-browser";
pub const HESTIA_IMPORT_ARTIFACT_COUNT: u64 = 12;
pub const HESTIA_IMPORT_VERIFICATION_SCOPE: &str = "compiled-lock";

const HESTIA_LOCK_PROTOCOL: &str = "greenways-hestia-room-authority-lock/0-alpha";
const HESTIA_LOCK_SHA256: &str = "d294839838385254184652c94e4c980aa2ace82071590925531a3e2094703c3b";
const DIGEST_PREFIX: &str = "sha256:";
const MAX_PATH_BYTES: usize = 320;
const COMPILED_LOCK: &[u8] = include_bytes!("../../../extension/hestia-room-authority.lock.json");

const EXPECTED_ARTIFACTS: [(&str, &str); 12] = [
    ("packageManifest", "browser/package.json"),
    ("importManifest", "browser/room-authority-import.json"),
    ("decisionModule", "browser/src/room-authority.js"),
    (
        "roomProjectionModule",
        "browser/src/room-authority-projections.js",
    ),
    (
        "authorityRecordModule",
        "browser/src/room-authority-records.js",
    ),
    (
        "sourceGrantProjectionModule",
        "browser/src/room-authority-source-projections.js",
    ),
    ("agentRoomRecordModule", "browser/src/agent-room-records.js"),
    ("agentProtocolModule", "browser/src/agent-protocol.js"),
    ("agentHcv1Module", "browser/src/agent-hcv1.js"),
    ("protocolModule", "browser/src/protocol.js"),
    ("encodingModule", "browser/src/encoding.js"),
    (
        "conformanceFixture",
        "browser/fixtures/room-authority-conformance.json",
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HestiaImportStatus {
    pub protocol: String,
    pub state: String,
    pub repository: String,
    pub revision: String,
    pub package: String,
    pub artifact_count: u64,
    pub room_invocation_protocol: String,
    pub authority_decision_protocol: String,
    pub prepared_execution_protocol: String,
    pub verification_scope: String,
    pub room_projections_admitted: bool,
    pub admitted_room_projection_count: u64,
}

impl HestiaImportStatus {
    pub fn from_compiled_lock() -> Result<Self, HestiaImportError> {
        Self::from_lock_bytes(COMPILED_LOCK, 0)
    }

    pub fn from_lock_bytes(
        bytes: &[u8],
        admitted_room_projection_count: u64,
    ) -> Result<Self, HestiaImportError> {
        let imported: HestiaImportLock = serde_json::from_slice(bytes).map_err(|_| {
            HestiaImportError::new(
                "invalid-hestia-import-lock",
                "The compiled Hestia import lock is not one closed JSON object.",
            )
        })?;
        imported.validate()?;

        let actual_digest = encode_hex(&Sha256::digest(bytes));
        if actual_digest != HESTIA_LOCK_SHA256 {
            return Err(HestiaImportError::new(
                "hestia-import-lock-drift",
                "The compiled Hestia import lock differs from the reviewed byte sequence.",
            ));
        }

        let status = Self {
            protocol: HESTIA_IMPORT_STATUS_PROTOCOL.to_owned(),
            state: HESTIA_IMPORT_STATE.to_owned(),
            repository: HESTIA_IMPORT_REPOSITORY.to_owned(),
            revision: HESTIA_IMPORT_REVISION.to_owned(),
            package: HESTIA_IMPORT_PACKAGE.to_owned(),
            artifact_count: HESTIA_IMPORT_ARTIFACT_COUNT,
            room_invocation_protocol: HESTIA_ROOM_INVOCATION_PROTOCOL.to_owned(),
            authority_decision_protocol: HESTIA_ROOM_AUTHORITY_DECISION_PROTOCOL.to_owned(),
            prepared_execution_protocol: PREPARED_ROOM_EXECUTION_PROTOCOL.to_owned(),
            verification_scope: HESTIA_IMPORT_VERIFICATION_SCOPE.to_owned(),
            room_projections_admitted: admitted_room_projection_count > 0,
            admitted_room_projection_count,
        };
        status.validate()?;
        Ok(status)
    }

    pub fn validate(&self) -> Result<(), HestiaImportError> {
        if self.protocol != HESTIA_IMPORT_STATUS_PROTOCOL
            || self.state != HESTIA_IMPORT_STATE
            || self.repository != HESTIA_IMPORT_REPOSITORY
            || self.revision != HESTIA_IMPORT_REVISION
            || self.package != HESTIA_IMPORT_PACKAGE
            || self.artifact_count != HESTIA_IMPORT_ARTIFACT_COUNT
            || self.room_invocation_protocol != HESTIA_ROOM_INVOCATION_PROTOCOL
            || self.authority_decision_protocol != HESTIA_ROOM_AUTHORITY_DECISION_PROTOCOL
            || self.prepared_execution_protocol != PREPARED_ROOM_EXECUTION_PROTOCOL
            || self.verification_scope != HESTIA_IMPORT_VERIFICATION_SCOPE
        {
            return Err(HestiaImportError::new(
                "invalid-hestia-import-status",
                "The Hestia import status does not identify this exact compiled package closure.",
            ));
        }
        if self.room_projections_admitted != (self.admitted_room_projection_count > 0) {
            return Err(HestiaImportError::new(
                "invalid-hestia-room-admission-status",
                "The Hestia room projection admission flag and count disagree.",
            ));
        }
        if self.room_projections_admitted || self.admitted_room_projection_count != 0 {
            return Err(HestiaImportError::new(
                "hestia-room-projections-not-supported",
                "This Desktop readiness build does not admit Hestia room projections.",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HestiaImportLock {
    protocol: String,
    repository: String,
    revision: String,
    package: String,
    artifacts: BTreeMap<String, HestiaLockArtifact>,
}

impl HestiaImportLock {
    fn validate(&self) -> Result<(), HestiaImportError> {
        if !valid_revision(&self.revision) {
            return Err(HestiaImportError::new(
                "invalid-hestia-import-revision",
                "The compiled Hestia import revision is malformed.",
            ));
        }
        if self.protocol != HESTIA_LOCK_PROTOCOL
            || self.repository != HESTIA_IMPORT_REPOSITORY
            || self.revision != HESTIA_IMPORT_REVISION
            || self.package != HESTIA_IMPORT_PACKAGE
        {
            return Err(HestiaImportError::new(
                "invalid-hestia-import-identity",
                "The compiled Hestia import lock identifies an unsupported package closure.",
            ));
        }
        if self.artifacts.len() != EXPECTED_ARTIFACTS.len()
            || EXPECTED_ARTIFACTS
                .iter()
                .any(|(name, _)| !self.artifacts.contains_key(*name))
            || self.artifacts.keys().any(|name| {
                !EXPECTED_ARTIFACTS
                    .iter()
                    .any(|(expected, _)| name == expected)
            })
        {
            return Err(HestiaImportError::new(
                "invalid-hestia-import-artifact-set",
                "The compiled Hestia import lock does not contain the exact reviewed artifact set.",
            ));
        }

        let mut paths = BTreeSet::<&str>::new();
        let mut digests = BTreeSet::<&str>::new();
        for artifact in self.artifacts.values() {
            validate_artifact_path(&artifact.path)?;
            validate_artifact_digest(&artifact.digest)?;
            if !paths.insert(artifact.path.as_str()) {
                return Err(HestiaImportError::new(
                    "duplicate-hestia-import-artifact-path",
                    "The compiled Hestia import lock contains a duplicate artifact path.",
                ));
            }
            if !digests.insert(artifact.digest.as_str()) {
                return Err(HestiaImportError::new(
                    "duplicate-hestia-import-artifact-digest",
                    "The compiled Hestia import lock contains a duplicate artifact digest.",
                ));
            }
        }
        for (name, expected_path) in EXPECTED_ARTIFACTS {
            let artifact = self.artifacts.get(name).ok_or_else(|| {
                HestiaImportError::new(
                    "missing-hestia-import-artifact",
                    "The compiled Hestia import lock is missing a reviewed artifact.",
                )
            })?;
            if artifact.path != expected_path {
                return Err(HestiaImportError::new(
                    "invalid-hestia-import-artifact-path",
                    "A compiled Hestia import artifact has an unexpected path.",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct HestiaLockArtifact {
    path: String,
    digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HestiaImportError {
    code: &'static str,
    message: String,
}

impl HestiaImportError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub const fn code(&self) -> &'static str {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for HestiaImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl Error for HestiaImportError {}

fn valid_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(is_lower_hex)
}

fn validate_artifact_path(value: &str) -> Result<(), HestiaImportError> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.starts_with('/')
        || value
            .as_bytes()
            .get(1)
            .is_some_and(|byte| *byte == b':' && value.as_bytes()[0].is_ascii_alphabetic())
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(HestiaImportError::new(
            "invalid-hestia-import-artifact-path",
            "A compiled Hestia import artifact path is unsafe.",
        ));
    }
    Ok(())
}

fn validate_artifact_digest(value: &str) -> Result<(), HestiaImportError> {
    if value
        .strip_prefix(DIGEST_PREFIX)
        .is_none_or(|suffix| suffix.len() != 64 || !suffix.bytes().all(is_lower_hex))
    {
        return Err(HestiaImportError::new(
            "invalid-hestia-import-artifact-digest",
            "A compiled Hestia import artifact digest is malformed.",
        ));
    }
    Ok(())
}

const fn is_lower_hex(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'a'..=b'f')
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn compiled_value() -> Value {
        serde_json::from_slice(COMPILED_LOCK).expect("compiled lock should decode")
    }

    fn changed_bytes(change: impl FnOnce(&mut Value)) -> Vec<u8> {
        let mut value = compiled_value();
        change(&mut value);
        serde_json::to_vec_pretty(&value).expect("changed lock should encode")
    }

    fn artifacts(value: &mut Value) -> &mut serde_json::Map<String, Value> {
        value
            .get_mut("artifacts")
            .and_then(Value::as_object_mut)
            .expect("lock artifacts")
    }

    #[test]
    fn projects_only_the_exact_compiled_lock_status() {
        let status = HestiaImportStatus::from_compiled_lock().expect("compiled lock should verify");
        assert_eq!(status.protocol, HESTIA_IMPORT_STATUS_PROTOCOL);
        assert_eq!(status.state, HESTIA_IMPORT_STATE);
        assert_eq!(status.repository, HESTIA_IMPORT_REPOSITORY);
        assert_eq!(status.revision, HESTIA_IMPORT_REVISION);
        assert_eq!(status.package, HESTIA_IMPORT_PACKAGE);
        assert_eq!(status.artifact_count, HESTIA_IMPORT_ARTIFACT_COUNT);
        assert_eq!(
            status.room_invocation_protocol,
            HESTIA_ROOM_INVOCATION_PROTOCOL
        );
        assert_eq!(
            status.authority_decision_protocol,
            HESTIA_ROOM_AUTHORITY_DECISION_PROTOCOL
        );
        assert_eq!(
            status.prepared_execution_protocol,
            PREPARED_ROOM_EXECUTION_PROTOCOL
        );
        assert_eq!(status.verification_scope, HESTIA_IMPORT_VERIFICATION_SCOPE);
        assert!(!status.room_projections_admitted);
        assert_eq!(status.admitted_room_projection_count, 0);
        status.validate().expect("status should validate");

        let encoded = serde_json::to_string(&status).expect("status should encode");
        for forbidden in [
            "packageManifest",
            "browser/src",
            "digest",
            "governanceRoot",
            "membershipRoot",
            "invitation",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "forbidden projection: {forbidden}"
            );
        }
    }

    #[test]
    fn rejects_unknown_lock_and_artifact_fields_before_digest_drift() {
        let bytes = changed_bytes(|value| {
            value
                .as_object_mut()
                .expect("lock object")
                .insert("extra".to_owned(), json!(true));
        });
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(&bytes, 0)
                .expect_err("unknown lock field should fail")
                .code(),
            "invalid-hestia-import-lock"
        );

        let bytes = changed_bytes(|value| {
            artifacts(value)["packageManifest"]
                .as_object_mut()
                .expect("artifact object")
                .insert("size".to_owned(), json!(1));
        });
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(&bytes, 0)
                .expect_err("unknown artifact field should fail")
                .code(),
            "invalid-hestia-import-lock"
        );

        let bytes = changed_bytes(|value| {
            artifacts(value).insert(
                "unexpectedModule".to_owned(),
                json!({"path": "browser/src/unexpected.js", "digest": format!("sha256:{}", "a".repeat(64))}),
            );
        });
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(&bytes, 0)
                .expect_err("unexpected artifact should fail")
                .code(),
            "invalid-hestia-import-artifact-set"
        );
    }

    #[test]
    fn rejects_malformed_revision_before_digest_drift() {
        let bytes = changed_bytes(|value| value["revision"] = json!("not-a-revision"));
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(&bytes, 0)
                .expect_err("malformed revision should fail")
                .code(),
            "invalid-hestia-import-revision"
        );
    }

    #[test]
    fn rejects_unsafe_and_changed_artifact_paths_before_digest_drift() {
        for path in [
            "",
            "/browser/package.json",
            "C:/browser/package.json",
            "browser\\package.json",
            "browser/../package.json",
            "browser//package.json",
        ] {
            let bytes = changed_bytes(|value| {
                artifacts(value)["packageManifest"]["path"] = json!(path);
            });
            assert_eq!(
                HestiaImportStatus::from_lock_bytes(&bytes, 0)
                    .expect_err("unsafe path should fail")
                    .code(),
                "invalid-hestia-import-artifact-path"
            );
        }

        let bytes = changed_bytes(|value| {
            artifacts(value)["packageManifest"]["path"] = json!("browser/other.json");
        });
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(&bytes, 0)
                .expect_err("changed reviewed path should fail")
                .code(),
            "invalid-hestia-import-artifact-path"
        );
    }

    #[test]
    fn rejects_malformed_and_duplicate_digests_before_digest_drift() {
        let bytes = changed_bytes(|value| {
            artifacts(value)["packageManifest"]["digest"] = json!("sha256:bad");
        });
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(&bytes, 0)
                .expect_err("malformed digest should fail")
                .code(),
            "invalid-hestia-import-artifact-digest"
        );

        let bytes = changed_bytes(|value| {
            let duplicate = artifacts(value)["packageManifest"]["digest"].clone();
            artifacts(value)["importManifest"]["digest"] = duplicate;
        });
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(&bytes, 0)
                .expect_err("duplicate digest should fail")
                .code(),
            "duplicate-hestia-import-artifact-digest"
        );
    }

    #[test]
    fn rejects_duplicate_paths_before_digest_drift() {
        let bytes = changed_bytes(|value| {
            let duplicate = artifacts(value)["packageManifest"]["path"].clone();
            artifacts(value)["importManifest"]["path"] = duplicate;
        });
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(&bytes, 0)
                .expect_err("duplicate path should fail")
                .code(),
            "duplicate-hestia-import-artifact-path"
        );
    }

    #[test]
    fn rejects_semantically_equivalent_lock_byte_drift() {
        let mut drifted = COMPILED_LOCK.to_vec();
        drifted.push(b'\n');
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(&drifted, 0)
                .expect_err("byte drift should fail")
                .code(),
            "hestia-import-lock-drift"
        );
    }

    #[test]
    fn rejects_room_projection_admission_in_the_readiness_build() {
        assert_eq!(
            HestiaImportStatus::from_lock_bytes(COMPILED_LOCK, 1)
                .expect_err("readiness build cannot admit projections")
                .code(),
            "hestia-room-projections-not-supported"
        );
        let mut status = HestiaImportStatus::from_compiled_lock().expect("compiled status");
        status.room_projections_admitted = true;
        assert_eq!(
            status
                .validate()
                .expect_err("inconsistent status should fail")
                .code(),
            "invalid-hestia-room-admission-status"
        );
    }
}
