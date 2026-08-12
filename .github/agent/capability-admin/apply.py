from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def replace(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"anchor count {count} in {path}: {old[:160]!r}")
    target.write_text(text.replace(old, new))


replace(
    "cli/greenways-admin/Cargo.toml",
    '[dependencies]\ngreenways-authority = { path = "../../crates/greenways-authority" }\n',
    '[dependencies]\ngreenways-authority = { path = "../../crates/greenways-authority" }\ngreenways-capabilities = { path = "../../crates/greenways-capabilities" }\n',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''use greenways_identity::{
    ProfileIdentityStatus, ProfileIdentityVault, SignedProfileIdentity,
};
''',
    '''use greenways_capabilities::{
    CapabilityAuthority, CapabilityAuthorityStatus, CapabilityGrantView, IssueCapabilityGrant,
};
use greenways_identity::{
    ApplicationApprovalSubject, ProfileIdentityStatus, ProfileIdentityVault,
    SignedCapabilityGrant, SignedCapabilityRevocation, SignedProfileIdentity,
};
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''use std::{
''',
    '''use std::{
    collections::BTreeMap,
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''enum Command {
    Provider(ProviderCommand),
    Client(ClientCommand),
    Identity(IdentityCommand),
}
''',
    '''enum Command {
    Provider(ProviderCommand),
    Client(ClientCommand),
    Identity(IdentityCommand),
    Capability(CapabilityCommand),
}
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''enum IdentityCommand {
    Status,
    Create { handle: String },
}
''',
    '''enum IdentityCommand {
    Status,
    Create { handle: String },
}

#[derive(Debug)]
enum CapabilityCommand {
    Status,
    List,
    Issue {
        capability: String,
        app_id: String,
        app_version: String,
        publisher_id: String,
        approval_digest: String,
        lock_digest: Option<String>,
        expires_at_unix_ms: Option<u64>,
    },
    Revoke {
        grant_id: String,
        reason: String,
    },
}
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''        Command::Provider(command) => run_provider(command, &paths, options.json),
        Command::Client(command) => run_client(command, &paths, options.json),
        Command::Identity(command) => run_identity(command, &paths, options.json),
''',
    '''        Command::Provider(command) => run_provider(command, &paths, options.json),
        Command::Client(command) => run_client(command, &paths, options.json),
        Command::Identity(command) => run_identity(command, &paths, options.json),
        Command::Capability(command) => run_capability(command, &paths, options.json),
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''fn print_profiles(profiles: &[ProviderProfile], json: bool) -> Result<(), String> {
''',
    '''fn run_capability(
    command: CapabilityCommand,
    paths: &GreenwaysPaths,
    json: bool,
) -> Result<(), String> {
    let authority_path = paths.home.join("state").join("capabilities.json");
    match command {
        CapabilityCommand::Status => {
            let authority = CapabilityAuthority::open(authority_path)
                .map_err(|error| error.to_string())?;
            let status = authority
                .status(now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_capability_status(&status, json)
        }
        CapabilityCommand::List => {
            let authority = CapabilityAuthority::open(authority_path)
                .map_err(|error| error.to_string())?;
            let grants = authority
                .list(now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_capability_grants(&grants, json)
        }
        CapabilityCommand::Issue {
            capability,
            app_id,
            app_version,
            publisher_id,
            approval_digest,
            lock_digest,
            expires_at_unix_ms,
        } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let identity = ProfileIdentityVault::open_system(
                paths.home.join("state").join("profile-identity.json"),
            )
            .map_err(|error| error.to_string())?;
            let mut authority = CapabilityAuthority::open(authority_path)
                .map_err(|error| error.to_string())?;
            let grant = authority
                .issue(
                    &identity,
                    IssueCapabilityGrant {
                        capability,
                        subject: ApplicationApprovalSubject {
                            kind: "app".to_owned(),
                            app_id,
                            version: app_version,
                            publisher_id,
                            lock_digest,
                            approval_digest,
                        },
                        constraints: BTreeMap::new(),
                        issued_at_unix_ms: now_unix_ms()?,
                        expires_at_unix_ms,
                    },
                )
                .map_err(|error| error.to_string())?;
            print_capability_grant("Issued", &grant, json)
        }
        CapabilityCommand::Revoke { grant_id, reason } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let identity = ProfileIdentityVault::open_system(
                paths.home.join("state").join("profile-identity.json"),
            )
            .map_err(|error| error.to_string())?;
            let mut authority = CapabilityAuthority::open(authority_path)
                .map_err(|error| error.to_string())?;
            let revocation = authority
                .revoke(&identity, &grant_id, &reason, now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_capability_revocation(&revocation, json)
        }
    }
}

fn print_capability_status(
    status: &CapabilityAuthorityStatus,
    json: bool,
) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(status)
                .map_err(|_| "could not encode capability authority status".to_owned())?
        );
    } else {
        println!("Greenways capability authority");
        println!("  state:    {}", status.state);
        println!("  revision: {}", status.revision);
        println!("  grants:   {}", status.grant_count);
        println!("  active:   {}", status.active_grant_count);
        println!("  revoked:  {}", status.revoked_grant_count);
        println!("  expired:  {}", status.expired_grant_count);
        println!("  signed records: {}", status.signed_records);
        println!("  arbitrary signing: {}", status.arbitrary_signing);
    }
    Ok(())
}

fn print_capability_grants(
    grants: &[CapabilityGrantView],
    json: bool,
) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(grants)
                .map_err(|_| "could not encode capability grants".to_owned())?
        );
        return Ok(());
    }
    println!("Greenways application capability grants");
    if grants.is_empty() {
        println!("  none");
        return Ok(());
    }
    for view in grants {
        let state = if view.active {
            "active"
        } else if view.revocation.is_some() {
            "revoked"
        } else {
            "expired"
        };
        println!(
            "  {}  {}  {}@{} from {}  ({state})",
            view.grant.grant.id,
            view.grant.grant.capability,
            view.grant.grant.subject.app_id,
            view.grant.grant.subject.version,
            view.grant.grant.subject.publisher_id,
        );
        println!(
            "    approval: {}",
            view.grant.grant.subject.approval_digest
        );
    }
    Ok(())
}

fn print_capability_grant(
    prefix: &str,
    grant: &SignedCapabilityGrant,
    json: bool,
) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(grant)
                .map_err(|_| "could not encode signed capability grant".to_owned())?
        );
    } else {
        println!("{prefix} Greenways capability grant.");
        println!("  id:         {}", grant.grant.id);
        println!("  capability: {}", grant.grant.capability);
        println!(
            "  app:        {}@{}",
            grant.grant.subject.app_id, grant.grant.subject.version
        );
        println!("  publisher:  {}", grant.grant.subject.publisher_id);
        println!("  approval:   {}", grant.grant.subject.approval_digest);
        println!("  root:       {}", grant.subject_root);
    }
    Ok(())
}

fn print_capability_revocation(
    revocation: &SignedCapabilityRevocation,
    json: bool,
) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(revocation)
                .map_err(|_| "could not encode signed capability revocation".to_owned())?
        );
    } else {
        println!("Revoked Greenways capability grant.");
        println!("  revocation: {}", revocation.revocation.id);
        println!("  grant:      {}", revocation.revocation.grant_id);
        println!("  grant root: {}", revocation.revocation.grant_subject_root);
        println!("  reason:     {}", revocation.revocation.reason);
        println!("  root:       {}", revocation.subject_root);
    }
    Ok(())
}

fn print_profiles(profiles: &[ProviderProfile], json: bool) -> Result<(), String> {
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''        Some("provider") => "provider",
        Some("client") => "client",
        Some("identity") => "identity",
''',
    '''        Some("provider") => "provider",
        Some("client") => "client",
        Some("identity") => "identity",
        Some("capability") => "capability",
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''    let mut role = None;
    let mut output = None;
    let mut handle = None;
''',
    '''    let mut role = None;
    let mut output = None;
    let mut handle = None;
    let mut capability = None;
    let mut app_id = None;
    let mut app_version = None;
    let mut publisher_id = None;
    let mut approval_digest = None;
    let mut lock_digest = None;
    let mut expires_at_unix_ms = None;
    let mut grant_id = None;
    let mut reason = None;
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''            "--handle" => {
                handle = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--handle requires a profile handle".to_owned())?,
                );
            }
''',
    '''            "--handle" => {
                handle = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--handle requires a profile handle".to_owned())?,
                );
            }
            "--capability" => {
                capability = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--capability requires an operation capability".to_owned())?,
                );
            }
            "--app-id" => {
                app_id = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--app-id requires an application id".to_owned())?,
                );
            }
            "--app-version" => {
                app_version = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--app-version requires a semantic version".to_owned())?,
                );
            }
            "--publisher" => {
                publisher_id = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--publisher requires a publisher id".to_owned())?,
                );
            }
            "--approval-digest" => {
                approval_digest = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--approval-digest requires sha256 evidence".to_owned())?,
                );
            }
            "--lock-digest" => {
                lock_digest = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--lock-digest requires sha256 evidence".to_owned())?,
                );
            }
            "--expires-at-unix-ms" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| "--expires-at-unix-ms requires a positive integer".to_owned())?;
                let parsed = value.parse::<u64>().map_err(|_| {
                    "--expires-at-unix-ms requires a positive integer".to_owned()
                })?;
                if parsed == 0 {
                    return Err("--expires-at-unix-ms requires a positive integer".to_owned());
                }
                expires_at_unix_ms = Some(parsed);
            }
            "--grant-id" => {
                grant_id = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--grant-id requires a grant id".to_owned())?,
                );
            }
            "--reason" => {
                reason = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--reason requires a revocation reason".to_owned())?,
                );
            }
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''    if group != "identity" && handle.is_some() {
        return Err(format!("{group} {action} does not accept --handle"));
    }
''',
    '''    if group != "identity" && handle.is_some() {
        return Err(format!("{group} {action} does not accept --handle"));
    }
    let has_capability_fields = capability.is_some()
        || app_id.is_some()
        || app_version.is_some()
        || publisher_id.is_some()
        || approval_digest.is_some()
        || lock_digest.is_some()
        || expires_at_unix_ms.is_some()
        || grant_id.is_some()
        || reason.is_some();
    if group != "capability" && has_capability_fields {
        return Err(format!(
            "{group} {action} does not accept capability authority fields"
        ));
    }
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''        ("identity", "create") => {
            require_absent(&id, "--id", "identity create")?;
            require_absent(&provider, "--provider", "identity create")?;
            require_absent(&label, "--label", "identity create")?;
            require_absent(&role, "--role", "identity create")?;
            require_absent(&output, "--output", "identity create")?;
            Command::Identity(IdentityCommand::Create {
                handle: handle.ok_or_else(|| "--handle is required".to_owned())?,
            })
        }
        _ => return Err(format!("unsupported {group} action: {action}")),
''',
    '''        ("identity", "create") => {
            require_absent(&id, "--id", "identity create")?;
            require_absent(&provider, "--provider", "identity create")?;
            require_absent(&label, "--label", "identity create")?;
            require_absent(&role, "--role", "identity create")?;
            require_absent(&output, "--output", "identity create")?;
            Command::Identity(IdentityCommand::Create {
                handle: handle.ok_or_else(|| "--handle is required".to_owned())?,
            })
        }
        ("capability", "status") => {
            require_absent(&id, "--id", "capability status")?;
            require_absent(&provider, "--provider", "capability status")?;
            require_absent(&label, "--label", "capability status")?;
            require_absent(&role, "--role", "capability status")?;
            require_absent(&output, "--output", "capability status")?;
            if has_capability_fields {
                return Err("capability status accepts no authority fields".to_owned());
            }
            Command::Capability(CapabilityCommand::Status)
        }
        ("capability", "list") => {
            require_absent(&id, "--id", "capability list")?;
            require_absent(&provider, "--provider", "capability list")?;
            require_absent(&label, "--label", "capability list")?;
            require_absent(&role, "--role", "capability list")?;
            require_absent(&output, "--output", "capability list")?;
            if has_capability_fields {
                return Err("capability list accepts no authority fields".to_owned());
            }
            Command::Capability(CapabilityCommand::List)
        }
        ("capability", "issue") => {
            require_absent(&id, "--id", "capability issue")?;
            require_absent(&provider, "--provider", "capability issue")?;
            require_absent(&label, "--label", "capability issue")?;
            require_absent(&role, "--role", "capability issue")?;
            require_absent(&output, "--output", "capability issue")?;
            require_absent(&grant_id, "--grant-id", "capability issue")?;
            require_absent(&reason, "--reason", "capability issue")?;
            Command::Capability(CapabilityCommand::Issue {
                capability: capability
                    .ok_or_else(|| "--capability is required".to_owned())?,
                app_id: app_id.ok_or_else(|| "--app-id is required".to_owned())?,
                app_version: app_version
                    .ok_or_else(|| "--app-version is required".to_owned())?,
                publisher_id: publisher_id
                    .ok_or_else(|| "--publisher is required".to_owned())?,
                approval_digest: approval_digest
                    .ok_or_else(|| "--approval-digest is required".to_owned())?,
                lock_digest,
                expires_at_unix_ms,
            })
        }
        ("capability", "revoke") => {
            require_absent(&id, "--id", "capability revoke")?;
            require_absent(&provider, "--provider", "capability revoke")?;
            require_absent(&label, "--label", "capability revoke")?;
            require_absent(&role, "--role", "capability revoke")?;
            require_absent(&output, "--output", "capability revoke")?;
            require_absent(&capability, "--capability", "capability revoke")?;
            require_absent(&app_id, "--app-id", "capability revoke")?;
            require_absent(&app_version, "--app-version", "capability revoke")?;
            require_absent(&publisher_id, "--publisher", "capability revoke")?;
            require_absent(
                &approval_digest,
                "--approval-digest",
                "capability revoke",
            )?;
            require_absent(&lock_digest, "--lock-digest", "capability revoke")?;
            require_absent(
                &expires_at_unix_ms,
                "--expires-at-unix-ms",
                "capability revoke",
            )?;
            Command::Capability(CapabilityCommand::Revoke {
                grant_id: grant_id.ok_or_else(|| "--grant-id is required".to_owned())?,
                reason: reason.ok_or_else(|| "--reason is required".to_owned())?,
            })
        }
        _ => return Err(format!("unsupported {group} action: {action}")),
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''         greenways-admin identity create --handle HANDLE [--home PATH] [--json]\\n\\
         \\n\\
         Provider credentials and profile private keys are placed directly into operating-system\\n\\
''',
    '''         greenways-admin identity create --handle HANDLE [--home PATH] [--json]\\n\\
         greenways-admin capability status [--home PATH] [--json]\\n\\
         greenways-admin capability list [--home PATH] [--json]\\n\\
         greenways-admin capability issue --capability OP --app-id ID --app-version VERSION \\\n\\
           --publisher PUBLISHER --approval-digest SHA256 [--lock-digest SHA256] \\\n\\
           [--expires-at-unix-ms INTEGER] [--home PATH] [--json]\\n\\
         greenways-admin capability revoke --grant-id ID --reason TEXT [--home PATH] [--json]\\n\\
         \\n\\
         Provider credentials and profile private keys are placed directly into operating-system\\n\\
''',
)
replace(
    "cli/greenways-admin/src/main.rs",
    '''    #[test]
    fn rejects_secret_fields_and_cross_command_authority() {
''',
    '''    #[test]
    fn parses_closed_capability_authority_commands() {
        let issue = parse(&[
            "capability",
            "issue",
            "--capability",
            "model/generate",
            "--app-id",
            "hara-playground",
            "--app-version",
            "1.2.3",
            "--publisher",
            "hara-lang",
            "--approval-digest",
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ])
        .expect("capability issue should parse");
        assert!(matches!(
            issue.command,
            Command::Capability(CapabilityCommand::Issue { .. })
        ));
        let revoke = parse(&[
            "capability",
            "revoke",
            "--grant-id",
            "grant/00112233445566778899aabbccddeeff",
            "--reason",
            "user-revoked",
        ])
        .expect("capability revoke should parse");
        assert!(matches!(
            revoke.command,
            Command::Capability(CapabilityCommand::Revoke { .. })
        ));
        assert!(parse(&[
            "capability",
            "issue",
            "--capability",
            "model/generate",
        ])
        .is_err());
        assert!(parse(&[
            "identity",
            "status",
            "--capability",
            "model/generate",
        ])
        .is_err());
    }

    #[test]
    fn rejects_secret_fields_and_cross_command_authority() {
''',
)

readme = ROOT / "services/greenwaysd/README.md"
readme.write_text(
    readme.read_text()
    + '''

## Offline capability administration

Capability grants are issued and revoked only while `greenwaysd` is stopped:

```sh
greenways-admin capability issue \\
  --capability model/generate \\
  --app-id hara-playground \\
  --app-version 1.2.3 \\
  --publisher hara-lang \\
  --approval-digest sha256:…

greenways-admin capability revoke \\
  --grant-id grant/… \\
  --reason user-revoked
```

The administrator reconstructs the exact application approval subject, asks the daemon-owned profile identity to sign one closed grant or revocation subject, and atomically commits the immutable record. It never accepts private keys, arbitrary signing bytes, generic JSON constraints, or provider credentials on the command line. Status and list remain read-only and may run while the daemon is active.
'''
)
protocol = ROOT / "protocol/capability-grants.md"
protocol.write_text(
    protocol.read_text()
    + '''

## Offline administration

`greenways-admin capability issue` and `capability revoke` are the first mutation surfaces. Both require the daemon socket to be inactive before opening the identity and capability metadata files. Issuance accepts only the exact capability and application approval fields; arbitrary constraints are intentionally absent from the first CLI. Revocation accepts only an existing grant ID and bounded reason.

The signed grant or revocation is committed before the command reports success. Re-running a revocation returns the existing immutable revocation. No corresponding mutation operation exists on ordinary local IPC.
'''
)

print("Applied offline capability authority administration")
