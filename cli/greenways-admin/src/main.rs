use greenways_authority::{LocalClient, LocalClientRegistry, LocalClientRole};
use greenways_capabilities::{
    CapabilityAuthority, CapabilityAuthorityStatus, CapabilityGrantView, IssueCapabilityGrant,
};
use greenways_identity::{
    ApplicationApprovalSubject, ProfileIdentityStatus, ProfileIdentityVault, SignedCapabilityGrant,
    SignedCapabilityRevocation, SignedProfileIdentity,
};
use greenways_local::GreenwaysPaths;
use greenways_vault::{ProviderKind, ProviderProfile, ProviderVault, MAX_PROVIDER_SECRET_BYTES};
use serde_json::json;
use std::{
    collections::BTreeMap,
    env,
    io::{self, IsTerminal, Read},
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
enum Command {
    Provider(ProviderCommand),
    Client(ClientCommand),
    Identity(IdentityCommand),
    Capability(CapabilityCommand),
}

#[derive(Debug)]
enum ProviderCommand {
    List,
    Add {
        id: String,
        provider: ProviderKind,
        label: String,
    },
    Rotate {
        id: String,
    },
    Remove {
        id: String,
    },
}

#[derive(Debug)]
enum ClientCommand {
    List,
    Issue {
        role: LocalClientRole,
        label: String,
        output: PathBuf,
    },
    Revoke {
        id: String,
    },
}

#[derive(Debug)]
enum IdentityCommand {
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

#[derive(Debug)]
struct Options {
    command: Command,
    home: Option<PathBuf>,
    json: bool,
}

fn main() {
    if let Err(message) = run() {
        eprintln!("greenways-admin: {message}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let options = parse_options(env::args().skip(1))?;
    let paths = GreenwaysPaths::resolve(options.home).map_err(|error| error.to_string())?;
    match options.command {
        Command::Provider(command) => run_provider(command, &paths, options.json),
        Command::Client(command) => run_client(command, &paths, options.json),
        Command::Identity(command) => run_identity(command, &paths, options.json),
        Command::Capability(command) => run_capability(command, &paths, options.json),
    }
}

fn run_provider(
    command: ProviderCommand,
    paths: &GreenwaysPaths,
    json: bool,
) -> Result<(), String> {
    let metadata_path = paths.home.join("state").join("providers.json");
    match command {
        ProviderCommand::List => {
            let vault =
                ProviderVault::open_system(metadata_path).map_err(|error| error.to_string())?;
            print_profiles(&vault.profiles(), json)
        }
        ProviderCommand::Add {
            id,
            provider,
            label,
        } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let secret = read_secret_from_stdin()?;
            let mut vault =
                ProviderVault::open_system(metadata_path).map_err(|error| error.to_string())?;
            let profile = vault
                .add_profile(&id, provider, &label, secret, now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_profile("Added", &profile, json)
        }
        ProviderCommand::Rotate { id } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let secret = read_secret_from_stdin()?;
            let mut vault =
                ProviderVault::open_system(metadata_path).map_err(|error| error.to_string())?;
            let profile = vault
                .rotate_profile(&id, secret, now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_profile("Rotated", &profile, json)
        }
        ProviderCommand::Remove { id } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let mut vault =
                ProviderVault::open_system(metadata_path).map_err(|error| error.to_string())?;
            let profile = vault
                .remove_profile(&id)
                .map_err(|error| error.to_string())?;
            print_profile("Removed", &profile, json)
        }
    }
}

fn run_client(command: ClientCommand, paths: &GreenwaysPaths, json: bool) -> Result<(), String> {
    let registry_path = paths.home.join("state").join("local-clients.json");
    match command {
        ClientCommand::List => {
            let registry =
                LocalClientRegistry::open(registry_path).map_err(|error| error.to_string())?;
            print_clients(&registry.clients(), json)
        }
        ClientCommand::Issue {
            role,
            label,
            output,
        } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let mut registry =
                LocalClientRegistry::open(registry_path).map_err(|error| error.to_string())?;
            let client = registry
                .issue_to_file(role, &label, &output, now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_issued_client(&client, &output, json)
        }
        ClientCommand::Revoke { id } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let mut registry =
                LocalClientRegistry::open(registry_path).map_err(|error| error.to_string())?;
            let client = registry
                .revoke(&id, now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_client("Revoked", &client, json)
        }
    }
}

fn run_identity(
    command: IdentityCommand,
    paths: &GreenwaysPaths,
    json: bool,
) -> Result<(), String> {
    let metadata_path = paths.home.join("state").join("profile-identity.json");
    match command {
        IdentityCommand::Status => {
            let identity = ProfileIdentityVault::open_system(metadata_path)
                .map_err(|error| error.to_string())?;
            print_identity_status(&identity.status(), json)
        }
        IdentityCommand::Create { handle } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let mut identity = ProfileIdentityVault::open_system(metadata_path)
                .map_err(|error| error.to_string())?;
            let card = identity
                .create(&handle, now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_identity_card("Created", &card, json)
        }
    }
}

fn print_identity_status(status: &ProfileIdentityStatus, json: bool) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(status)
                .map_err(|_| "could not encode profile identity status".to_owned())?
        );
    } else {
        println!("Greenways profile identity");
        println!("  state:      {}", status.state);
        println!("  custody:    {}", status.key_custody);
        println!(
            "  identity:   {}",
            status.identity_id.as_deref().unwrap_or("not configured")
        );
        println!(
            "  key:        {}",
            status.key_id.as_deref().unwrap_or("not configured")
        );
        println!("  algorithm:  {}", status.algorithm);
        println!("  private key projected: {}", status.private_key_projection);
    }
    Ok(())
}

fn print_identity_card(
    prefix: &str,
    card: &SignedProfileIdentity,
    json: bool,
) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(card)
                .map_err(|_| "could not encode public profile identity".to_owned())?
        );
    } else {
        println!("{prefix} Greenways profile identity.");
        println!("  id:      {}", card.subject.id);
        println!("  handle:  {}", card.subject.handle);
        println!("  key:     {}", card.subject.key_id);
        println!("  root:    {}", card.subject_root);
        println!("  custody: system-keyring");
    }
    Ok(())
}

fn run_capability(
    command: CapabilityCommand,
    paths: &GreenwaysPaths,
    json: bool,
) -> Result<(), String> {
    let authority_path = paths.home.join("state").join("capabilities.json");
    match command {
        CapabilityCommand::Status => {
            let authority =
                CapabilityAuthority::open(authority_path).map_err(|error| error.to_string())?;
            let status = authority
                .status(now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_capability_status(&status, json)
        }
        CapabilityCommand::List => {
            let authority =
                CapabilityAuthority::open(authority_path).map_err(|error| error.to_string())?;
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
            let mut authority =
                CapabilityAuthority::open(authority_path).map_err(|error| error.to_string())?;
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
            let mut authority =
                CapabilityAuthority::open(authority_path).map_err(|error| error.to_string())?;
            let revocation = authority
                .revoke(&identity, &grant_id, &reason, now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_capability_revocation(&revocation, json)
        }
    }
}

fn print_capability_status(status: &CapabilityAuthorityStatus, json: bool) -> Result<(), String> {
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

fn print_capability_grants(grants: &[CapabilityGrantView], json: bool) -> Result<(), String> {
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
        println!("    approval: {}", view.grant.grant.subject.approval_digest);
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
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(profiles)
                .map_err(|_| "could not encode provider profiles".to_owned())?
        );
        return Ok(());
    }
    if profiles.is_empty() {
        println!("No provider profiles configured.");
        return Ok(());
    }
    println!("Greenways provider profiles");
    for profile in profiles {
        println!(
            "  {}  {}  {}  ({})",
            profile.id,
            profile.provider.as_str(),
            profile.label,
            profile.credential_custody
        );
    }
    Ok(())
}

fn print_profile(prefix: &str, profile: &ProviderProfile, json: bool) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(profile)
                .map_err(|_| "could not encode provider profile".to_owned())?
        );
    } else {
        println!(
            "{prefix} provider profile {} ({}, {}).",
            profile.id,
            profile.provider.as_str(),
            profile.credential_custody
        );
    }
    Ok(())
}

fn print_clients(clients: &[LocalClient], json: bool) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(clients)
                .map_err(|_| "could not encode local clients".to_owned())?
        );
        return Ok(());
    }
    if clients.is_empty() {
        println!("No local clients enrolled.");
        return Ok(());
    }
    println!("Greenways local clients");
    for client in clients {
        let state = if client.revoked_at_unix_ms.is_some() {
            "revoked"
        } else {
            "active"
        };
        println!(
            "  {}  {}  {}  ({state})",
            client.id,
            client.role.as_str(),
            client.label
        );
    }
    Ok(())
}

fn print_issued_client(client: &LocalClient, output: &Path, json: bool) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "client": client,
                "credentialFile": output.to_string_lossy(),
                "secretProjection": false
            }))
            .map_err(|_| "could not encode issued local client".to_owned())?
        );
    } else {
        println!(
            "Issued {} client {}. Credential written once to {}.",
            client.role.as_str(),
            client.id,
            output.display()
        );
    }
    Ok(())
}

fn print_client(prefix: &str, client: &LocalClient, json: bool) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(client)
                .map_err(|_| "could not encode local client".to_owned())?
        );
    } else {
        println!(
            "{prefix} local client {} ({}).",
            client.id,
            client.role.as_str()
        );
    }
    Ok(())
}

fn read_secret_from_stdin() -> Result<Vec<u8>, String> {
    if io::stdin().is_terminal() {
        return Err(
            "provider credentials must be piped through stdin; they are never accepted as command-line arguments"
                .to_owned(),
        );
    }
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_PROVIDER_SECRET_BYTES + 2) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "could not read provider credential from stdin".to_owned())?;
    while matches!(bytes.last(), Some(b'\n' | b'\r')) {
        bytes.pop();
    }
    if bytes.len() > MAX_PROVIDER_SECRET_BYTES {
        return Err("provider credential exceeds its byte limit".to_owned());
    }
    Ok(bytes)
}

#[cfg(unix)]
fn assert_daemon_stopped(socket_file: &Path) -> Result<(), String> {
    use std::os::unix::net::UnixStream;

    if !socket_file.exists() {
        return Ok(());
    }
    match UnixStream::connect(socket_file) {
        Ok(_) => Err(
            "stop greenwaysd before changing authority state so there is one metadata writer"
                .to_owned(),
        ),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) =>
        {
            Ok(())
        }
        Err(_) => Err("could not prove that greenwaysd is stopped".to_owned()),
    }
}

#[cfg(not(unix))]
fn assert_daemon_stopped(_socket_file: &Path) -> Result<(), String> {
    Err("offline Greenways administration is not implemented on this platform".to_owned())
}

fn now_unix_ms() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock predates Unix epoch".to_owned())?;
    u64::try_from(duration.as_millis()).map_err(|_| "system clock overflowed".to_owned())
}

fn parse_options(arguments: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut arguments = arguments.peekable();
    let group = match arguments.next().as_deref() {
        Some("provider") => "provider",
        Some("client") => "client",
        Some("identity") => "identity",
        Some("capability") => "capability",
        Some("-h") | Some("--help") | None => {
            print_help();
            process::exit(0);
        }
        Some("--version") => {
            println!("greenways-admin {}", env!("CARGO_PKG_VERSION"));
            process::exit(0);
        }
        Some(value) => return Err(format!("unsupported command group: {value}")),
    };
    let action = arguments
        .next()
        .ok_or_else(|| format!("{group} action is required"))?;

    let mut home = None;
    let mut json = false;
    let mut id = None;
    let mut provider = None;
    let mut label = None;
    let mut role = None;
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

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--home" => {
                home = Some(PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--home requires a path".to_owned())?,
                ));
            }
            "--json" => json = true,
            "--id" => {
                id = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--id requires an identifier".to_owned())?,
                );
            }
            "--provider" => {
                provider = Some(
                    ProviderKind::parse(
                        &arguments
                            .next()
                            .ok_or_else(|| "--provider requires a provider id".to_owned())?,
                    )
                    .map_err(|error| error.to_string())?,
                );
            }
            "--label" => {
                label = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--label requires text".to_owned())?,
                );
            }
            "--role" => {
                role = Some(
                    LocalClientRole::parse(
                        &arguments
                            .next()
                            .ok_or_else(|| "--role requires a role".to_owned())?,
                    )
                    .map_err(|error| error.to_string())?,
                );
            }
            "--output" => {
                output = Some(PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--output requires a path".to_owned())?,
                ));
            }
            "--handle" => {
                handle = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--handle requires a profile handle".to_owned())?,
                );
            }
            "--capability" => {
                capability =
                    Some(arguments.next().ok_or_else(|| {
                        "--capability requires an operation capability".to_owned()
                    })?);
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
                let parsed = value
                    .parse::<u64>()
                    .map_err(|_| "--expires-at-unix-ms requires a positive integer".to_owned())?;
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
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            _ => return Err(format!("unsupported argument: {argument}")),
        }
    }

    if group != "identity" && handle.is_some() {
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
    let required_id = || id.clone().ok_or_else(|| "--id is required".to_owned());
    let command = match (group, action.as_str()) {
        ("provider", "list") => {
            require_absent(&id, "--id", "provider list")?;
            require_absent(&provider, "--provider", "provider list")?;
            require_absent(&label, "--label", "provider list")?;
            require_absent(&role, "--role", "provider list")?;
            require_absent(&output, "--output", "provider list")?;
            Command::Provider(ProviderCommand::List)
        }
        ("provider", "add") => {
            require_absent(&role, "--role", "provider add")?;
            require_absent(&output, "--output", "provider add")?;
            Command::Provider(ProviderCommand::Add {
                id: required_id()?,
                provider: provider.ok_or_else(|| "--provider is required".to_owned())?,
                label: label.ok_or_else(|| "--label is required".to_owned())?,
            })
        }
        ("provider", "rotate") => {
            require_absent(&provider, "--provider", "provider rotate")?;
            require_absent(&label, "--label", "provider rotate")?;
            require_absent(&role, "--role", "provider rotate")?;
            require_absent(&output, "--output", "provider rotate")?;
            Command::Provider(ProviderCommand::Rotate { id: required_id()? })
        }
        ("provider", "remove") => {
            require_absent(&provider, "--provider", "provider remove")?;
            require_absent(&label, "--label", "provider remove")?;
            require_absent(&role, "--role", "provider remove")?;
            require_absent(&output, "--output", "provider remove")?;
            Command::Provider(ProviderCommand::Remove { id: required_id()? })
        }
        ("client", "list") => {
            require_absent(&id, "--id", "client list")?;
            require_absent(&provider, "--provider", "client list")?;
            require_absent(&label, "--label", "client list")?;
            require_absent(&role, "--role", "client list")?;
            require_absent(&output, "--output", "client list")?;
            Command::Client(ClientCommand::List)
        }
        ("client", "issue") => {
            require_absent(&id, "--id", "client issue")?;
            require_absent(&provider, "--provider", "client issue")?;
            Command::Client(ClientCommand::Issue {
                role: role.ok_or_else(|| "--role is required".to_owned())?,
                label: label.ok_or_else(|| "--label is required".to_owned())?,
                output: output.ok_or_else(|| "--output is required".to_owned())?,
            })
        }
        ("client", "revoke") => {
            require_absent(&provider, "--provider", "client revoke")?;
            require_absent(&label, "--label", "client revoke")?;
            require_absent(&role, "--role", "client revoke")?;
            require_absent(&output, "--output", "client revoke")?;
            Command::Client(ClientCommand::Revoke { id: required_id()? })
        }
        ("identity", "status") => {
            require_absent(&id, "--id", "identity status")?;
            require_absent(&provider, "--provider", "identity status")?;
            require_absent(&label, "--label", "identity status")?;
            require_absent(&role, "--role", "identity status")?;
            require_absent(&output, "--output", "identity status")?;
            require_absent(&handle, "--handle", "identity status")?;
            Command::Identity(IdentityCommand::Status)
        }
        ("identity", "create") => {
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
                capability: capability.ok_or_else(|| "--capability is required".to_owned())?,
                app_id: app_id.ok_or_else(|| "--app-id is required".to_owned())?,
                app_version: app_version.ok_or_else(|| "--app-version is required".to_owned())?,
                publisher_id: publisher_id.ok_or_else(|| "--publisher is required".to_owned())?,
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
            require_absent(&approval_digest, "--approval-digest", "capability revoke")?;
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
    };

    Ok(Options {
        command,
        home,
        json,
    })
}

fn require_absent<T>(value: &Option<T>, flag: &str, command: &str) -> Result<(), String> {
    if value.is_some() {
        Err(format!("{command} does not accept {flag}"))
    } else {
        Ok(())
    }
}

fn print_help() {
    println!(
        "Usage:\n\
         greenways-admin provider list [--home PATH] [--json]\n\
         greenways-admin provider add --id ID --provider PROVIDER --label LABEL [--home PATH] [--json]\n\
         greenways-admin provider rotate --id ID [--home PATH] [--json]\n\
         greenways-admin provider remove --id ID [--home PATH] [--json]\n\
         greenways-admin client list [--home PATH] [--json]\n\
         greenways-admin client issue --role ROLE --label LABEL --output PATH [--home PATH] [--json]\n\
         greenways-admin client revoke --id ID [--home PATH] [--json]\n\
         greenways-admin identity status [--home PATH] [--json]\n\
         greenways-admin identity create --handle HANDLE [--home PATH] [--json]\n\
         greenways-admin capability status [--home PATH] [--json]\n\
         greenways-admin capability list [--home PATH] [--json]\n\
         greenways-admin capability issue --capability OP --app-id ID --app-version VERSION \
\
           --publisher PUBLISHER --approval-digest SHA256 [--lock-digest SHA256] \
\
           [--expires-at-unix-ms INTEGER] [--home PATH] [--json]\n\
         greenways-admin capability revoke --grant-id ID --reason TEXT [--home PATH] [--json]\n\
         \n\
         Provider credentials and profile private keys are placed directly into operating-system\n\
         credential store. Local client credentials are written once to a new private file.\n\
         Neither secret is accepted as a command-line argument or printed. Stop greenwaysd before\n\
         mutating provider or local-client authority."
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(values: &[&str]) -> Result<Options, String> {
        parse_options(values.iter().map(|value| (*value).to_owned()))
    }

    #[test]
    fn parses_closed_provider_commands() {
        let options = parse(&[
            "provider",
            "add",
            "--id",
            "openai.personal",
            "--provider",
            "openai",
            "--label",
            "Personal",
            "--home",
            "/tmp/greenways",
            "--json",
        ])
        .expect("add command should parse");
        assert!(matches!(
            options.command,
            Command::Provider(ProviderCommand::Add {
                provider: ProviderKind::OpenAi,
                ..
            })
        ));
        assert_eq!(options.home, Some(PathBuf::from("/tmp/greenways")));
        assert!(options.json);
    }

    #[test]
    fn parses_local_client_issue_and_revocation() {
        let issue = parse(&[
            "client",
            "issue",
            "--role",
            "browser-bridge",
            "--label",
            "Chrome bridge",
            "--output",
            "/tmp/browser.json",
        ])
        .expect("client issue should parse");
        assert!(matches!(
            issue.command,
            Command::Client(ClientCommand::Issue {
                role: LocalClientRole::BrowserBridge,
                ..
            })
        ));
        let revoke = parse(&[
            "client",
            "revoke",
            "--id",
            "local/client/00112233445566778899aabbccddeeff",
        ])
        .expect("client revoke should parse");
        assert!(matches!(
            revoke.command,
            Command::Client(ClientCommand::Revoke { .. })
        ));
    }

    #[test]
    fn parses_closed_profile_identity_commands() {
        let create = parse(&["identity", "create", "--handle", "river.studio", "--json"])
            .expect("identity create should parse");
        assert!(matches!(
            create.command,
            Command::Identity(IdentityCommand::Create { .. })
        ));
        assert!(parse(&["identity", "create"]).is_err());
        assert!(parse(&[
            "identity",
            "create",
            "--handle",
            "river.studio",
            "--key",
            "secret",
        ])
        .is_err());
    }

    #[test]
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
        assert!(parse(&["capability", "issue", "--capability", "model/generate",]).is_err());
        assert!(parse(&["identity", "status", "--capability", "model/generate",]).is_err());
    }

    #[test]
    fn rejects_secret_fields_and_cross_command_authority() {
        for field in ["--secret", "--token", "--key", "--endpoint"] {
            assert!(parse(&[
                "client",
                "issue",
                "--role",
                "cli",
                "--label",
                "CLI",
                "--output",
                "/tmp/client.json",
                field,
                "value",
            ])
            .is_err());
        }
        assert!(parse(&[
            "client",
            "issue",
            "--role",
            "cli",
            "--label",
            "CLI",
            "--output",
            "/tmp/client.json",
            "--provider",
            "openai",
        ])
        .is_err());
        assert!(parse(&[
            "provider",
            "rotate",
            "--id",
            "openai.personal",
            "--role",
            "desktop",
        ])
        .is_err());
    }
}
