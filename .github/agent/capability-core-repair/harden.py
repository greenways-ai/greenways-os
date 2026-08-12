from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def replace(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text()
    if content.count(old) != 1:
        raise SystemExit(f"capability hardening anchor was not unique in {path}: {old[:160]!r}")
    target.write_text(content.replace(old, new))


replace(
    "crates/greenways-identity/src/lib.rs",
    '''pub struct CapabilityRevocationRequest {
    pub id: String,
    pub grant_id: String,
    pub reason: String,
''',
    '''pub struct CapabilityRevocationRequest {
    pub id: String,
    pub grant_id: String,
    pub grant_subject_root: String,
    pub reason: String,
''',
)
replace(
    "crates/greenways-identity/src/lib.rs",
    '''pub struct CapabilityRevocationBody {
    pub protocol: String,
    pub id: String,
    pub grant_id: String,
    pub reason: String,
''',
    '''pub struct CapabilityRevocationBody {
    pub protocol: String,
    pub id: String,
    pub grant_id: String,
    pub grant_subject_root: String,
    pub reason: String,
''',
)
replace(
    "crates/greenways-identity/src/lib.rs",
    '''            id: request.id,
            grant_id: request.grant_id,
            reason: request.reason,
''',
    '''            id: request.id,
            grant_id: request.grant_id,
            grant_subject_root: request.grant_subject_root,
            reason: request.reason,
''',
)
replace(
    "crates/greenways-identity/src/lib.rs",
    '''        || !valid_record_id(&revocation.grant_id, CAPABILITY_GRANT_PREFIX)
        || revocation.reason.is_empty()
''',
    '''        || !valid_record_id(&revocation.grant_id, CAPABILITY_GRANT_PREFIX)
        || !valid_digest(&revocation.grant_subject_root)
        || revocation.reason.is_empty()
''',
)
replace(
    "crates/greenways-identity/src/lib.rs",
    '''                grant_id: grant.grant.id.clone(),
                reason: "user-revoked".to_owned(),
''',
    '''                grant_id: grant.grant.id.clone(),
                grant_subject_root: grant.subject_root.clone(),
                reason: "user-revoked".to_owned(),
''',
)
replace(
    "crates/greenways-capabilities/src/lib.rs",
    '''            grant_id: grant_id.to_owned(),
            reason: reason.to_owned(),
''',
    '''            grant_id: grant_id.to_owned(),
            grant_subject_root: grant.subject_root.clone(),
            reason: reason.to_owned(),
''',
)
replace(
    "crates/greenways-capabilities/src/lib.rs",
    '''        if grant.grant.issuer_identity_id != revocation.revocation.issuer_identity_id
            || grant.grant.issuer_key_id != revocation.revocation.issuer_key_id
            || revocation.revocation.revoked_at_unix_ms < grant.grant.issued_at_unix_ms
''',
    '''        if grant.grant.issuer_identity_id != revocation.revocation.issuer_identity_id
            || grant.grant.issuer_key_id != revocation.revocation.issuer_key_id
            || grant.subject_root != revocation.revocation.grant_subject_root
            || revocation.revocation.revoked_at_unix_ms < grant.grant.issued_at_unix_ms
''',
)

print("Bound capability revocations to exact grant roots")
