use greenways_applications::{
    ApplicationApprovalAuthority, ApplicationApprovalView, ApplicationAuthorityStatus,
};
use greenways_authority::{LocalClient, LocalClientRegistry, LocalClientRole};
use greenways_capabilities::{
    CapabilityAuthority, CapabilityAuthorityStatus, CapabilityGrantView, IssueCapabilityGrant,
    ModelGeneratePolicy, MODEL_GENERATE_CAPABILITY,
};
use greenways_identity::{
    ApplicationApprovalRequest, ApplicationApprovalSubject, ApplicationDescriptor,
    ProfileIdentityStatus, ProfileIdentityVault, SignedApplicationApproval,
    SignedApplicationRevocation, SignedCapabilityGrant, SignedCapabilityRevocation,
    SignedProfileIdentity,
};
use greenways_local::GreenwaysPaths;
use greenways_vault::{ProviderKind, ProviderProfile, ProviderVault, MAX_PROVIDER_SECRET_BYTES};
use serde_json::json;
use std::{
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
    Application(ApplicationCommand),
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
enum ApplicationCommand {
    Status,
    List,
    Approve {
        app_id: String,
        app_version: String,
        publisher_id: String,
        manifest_digest: String,
        lock_digest: Option<String>,
        declared_capabilities: Vec<String>,
    },
    Revoke {
        approval_digest: String,
        reason: String,
    },
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
        provider_policy: Option<ModelGeneratePolicy>,
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
        Command::Application(command) => run_application(command, &paths, options.json),
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

fn run_application(
    command: ApplicationCommand,
    paths: &GreenwaysPaths,
    json: bool,
) -> Result<(), String> {
    let authority_path = paths.home.join("state").join("applications.json");
    match command {
        ApplicationCommand::Status => {
            let authority = ApplicationApprovalAuthority::open(authority_path)
                .map_err(|error| error.to_string())?;
            let status = authority
                .status(now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_application_status(&status, json)
        }
        ApplicationCommand::List => {
            let authority = ApplicationApprovalAuthority::open(authority_path)
                .map_err(|error| error.to_string())?;
            let approvals = authority
                .list(now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_application_approvals(&approvals, json)
        }
        ApplicationCommand::Approve {
            app_id,
            app_version,
            publisher_id,
            manifest_digest,
            lock_digest,
            declared_capabilities,
        } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let identity = ProfileIdentityVault::open_system(
                paths.home.join("state").join("profile-identity.json"),
            )
            .map_err(|error| error.to_string())?;
            let mut authority = ApplicationApprovalAuthority::open(authority_path)
                .map_err(|error| error.to_string())?;
            let approval = authority
                .approve(
                    &identity,
                    ApplicationApprovalRequest {
                        application: ApplicationDescriptor {
                            app_id,
                            version: app_version,
                            publisher_id,
                            manifest_digest,
                            lock_digest,
                        },
                        declared_capabilities,
                        approved_at_unix_ms: now_unix_ms()?,
                    },
                )
                .map_err(|error| error.to_string())?;
            print_application_approval("Approved", &approval, json)
        }
        ApplicationCommand::Revoke {
            approval_digest,
            reason,
        } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let identity = ProfileIdentityVault::open_system(
                paths.home.join("state").join("profile-identity.json"),
            )
            .map_err(|error| error.to_string())?;
            let mut authority = ApplicationApprovalAuthority::open(authority_path)
                .map_err(|error| error.to_string())?;
            let revocation = authority
                .revoke(&identity, &approval_digest, &reason, now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_application_revocation(&revocation, json)
        }
    }
}

fn print_application_status(status: &ApplicationAuthorityStatus, json: bool) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(status)
                .map_err(|_| "could not encode application authority status".to_owned())?
        );
    } else {
        println!("Greenways application approval authority");
        println!("  state:    {}", status.state);
        println!("  revision: {}", status.revision);
        println!("  approvals: {}", status.approval_count);
        println!("  active:    {}", status.active_approval_count);
        println!("  revoked:   {}", status.revoked_approval_count);
        println!("  pending:   {}", status.pending_approval_count);
        println!("  signed records: {}", status.signed_records);
        println!("  arbitrary signing: {}", status.arbitrary_signing);
    }
    Ok(())
}

fn print_application_approvals(
    approvals: &[ApplicationApprovalView],
    json: bool,
) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(approvals)
                .map_err(|_| "could not encode application approvals".to_owned())?
        );
        return Ok(());
    }
    println!("Greenways application approvals");
    if approvals.is_empty() {
        println!("  none");
        return Ok(());
    }
    for view in approvals {
        let state = if view.active {
            "active"
        } else if view.revocation.is_some() {
            "revoked"
        } else {
            "pending"
        };
        println!(
            "  {}@{} from {}  ({state})",
            view.approval.approval.application.app_id,
            view.approval.approval.application.version,
            view.approval.approval.application.publisher_id,
        );
        println!(
            "    manifest: {}",
            view.approval.approval.application.manifest_digest
        );
        println!("    root:     {}", view.approval.subject_root);
        println!(
            "    capabilities: {}",
            view.approval.approval.declared_capabilities.join(", ")
        );
    }
    Ok(())
}

fn print_application_approval(
    prefix: &str,
    approval: &SignedApplicationApproval,
    json: bool,
) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(approval)
                .map_err(|_| "could not encode signed application approval".to_owned())?
        );
    } else {
        println!("{prefix} Greenways application.");
        println!(
            "  app:        {}@{}",
            approval.approval.application.app_id, approval.approval.application.version
        );
        println!(
            "  publisher:  {}",
            approval.approval.application.publisher_id
        );
        println!(
            "  manifest:   {}",
            approval.approval.application.manifest_digest
        );
        println!(
            "  capabilities: {}",
            approval.approval.declared_capabilities.join(", ")
        );
        println!("  root:       {}", approval.subject_root);
    }
    Ok(())
}

fn print_application_revocation(
    revocation: &SignedApplicationRevocation,
    json: bool,
) -> Result<(), String> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(revocation)
                .map_err(|_| "could not encode signed application revocation".to_owned())?
        );
    } else {
        println!("Revoked Greenways application approval.");
        println!("  id:       {}", revocation.revocation.id);
        println!(
            "  approval: {}",
            revocation.revocation.approval_subject_root
        );
        println!("  reason:   {}", revocation.revocation.reason);
        println!("  root:     {}", revocation.subject_root);
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
            provider_policy,
        } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let identity = ProfileIdentityVault::open_system(
                paths.home.join("state").join("profile-identity.json"),
            )
            .map_err(|error| error.to_string())?;
            let subject = ApplicationApprovalSubject {
                kind: "app".to_owned(),
                app_id,
                version: app_version,
                publisher_id,
                lock_digest,
                approval_digest,
            };
            let observed_at_unix_ms = now_unix_ms()?;
            let applications = ApplicationApprovalAuthority::open(
                paths.home.join("state").join("applications.json"),
            )
            .map_err(|error| error.to_string())?;
            let application = applications
                .authorize_exact(&subject, &capability, observed_at_unix_ms)
                .map_err(|error| error.to_string())?;
            if !application.allowed {
                return Err(format!(
                    "application authority denied capability issuance: {}",
                    application.reason
                ));
            }
            let mut authority =
                CapabilityAuthority::open(authority_path).map_err(|error| error.to_string())?;
            let grant = authority
                .issue(
                    &identity,
                    IssueCapabilityGrant {
                        capability,
                        subject,
                        constraints: provider_policy
                            .map(|policy| policy.constraints())
                            .unwrap_or_default(),
                        issued_at_unix_ms: observed_at_unix_ms,
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
        Some("application") => "application",
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
    let mut capabilities = Vec::new();
    let mut app_id = None;
    let mut app_version = None;
    let mut publisher_id = None;
    let mut manifest_digest = None;
    let mut approval_digest = None;
    let mut lock_digest = None;
    let mut expires_at_unix_ms = None;
    let mut provider_profile_id = None;
    let mut provider_model = None;
    let mut provider_max_output_tokens = None;
    let mut provider_max_timeout_ms = None;
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
            "--capability" => capabilities.push(
                arguments
                    .next()
                    .ok_or_else(|| "--capability requires an operation capability".to_owned())?,
            ),
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
            "--manifest-digest" => {
                manifest_digest = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--manifest-digest requires sha256 evidence".to_owned())?,
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
            "--provider-profile" => {
                provider_profile_id = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--provider-profile requires a profile ID".to_owned())?,
                );
            }
            "--provider-model" => {
                provider_model = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--provider-model requires a model ID".to_owned())?,
                );
            }
            "--provider-max-output-tokens" => {
                provider_max_output_tokens = Some(
                    arguments
                        .next()
                        .ok_or_else(|| {
                            "--provider-max-output-tokens requires a positive integer".to_owned()
                        })?
                        .parse::<u32>()
                        .map_err(|_| {
                            "--provider-max-output-tokens requires a positive integer".to_owned()
                        })?,
                );
            }
            "--provider-max-timeout-ms" => {
                provider_max_timeout_ms = Some(
                    arguments
                        .next()
                        .ok_or_else(|| {
                            "--provider-max-timeout-ms requires a positive integer".to_owned()
                        })?
                        .parse::<u64>()
                        .map_err(|_| {
                            "--provider-max-timeout-ms requires a positive integer".to_owned()
                        })?,
                );
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

    let has_provider_policy_fields = provider_profile_id.is_some()
        || provider_model.is_some()
        || provider_max_output_tokens.is_some()
        || provider_max_timeout_ms.is_some();
    let has_application_fields = !capabilities.is_empty()
        || app_id.is_some()
        || app_version.is_some()
        || publisher_id.is_some()
        || manifest_digest.is_some()
        || approval_digest.is_some()
        || lock_digest.is_some()
        || expires_at_unix_ms.is_some()
        || has_provider_policy_fields
        || grant_id.is_some()
        || reason.is_some();
    let required_id = || id.clone().ok_or_else(|| "--id is required".to_owned());
    macro_rules! reject_common {
        ($command:expr) => {{
            require_absent(&id, "--id", $command)?;
            require_absent(&provider, "--provider", $command)?;
            require_absent(&label, "--label", $command)?;
            require_absent(&role, "--role", $command)?;
            require_absent(&output, "--output", $command)?;
            require_absent(&handle, "--handle", $command)?;
        }};
    }

    let command = match (group, action.as_str()) {
        ("provider", "list") => {
            require_absent(&id, "--id", "provider list")?;
            require_absent(&provider, "--provider", "provider list")?;
            require_absent(&label, "--label", "provider list")?;
            require_absent(&role, "--role", "provider list")?;
            require_absent(&output, "--output", "provider list")?;
            if handle.is_some() || has_application_fields {
                return Err("provider list accepts no authority fields".to_owned());
            }
            Command::Provider(ProviderCommand::List)
        }
        ("provider", "add") => {
            require_absent(&role, "--role", "provider add")?;
            require_absent(&output, "--output", "provider add")?;
            if handle.is_some() || has_application_fields {
                return Err("provider add accepts no application authority fields".to_owned());
            }
            Command::Provider(ProviderCommand::Add {
                id: required_id()?,
                provider: provider.ok_or_else(|| "--provider is required".to_owned())?,
                label: label.ok_or_else(|| "--label is required".to_owned())?,
            })
        }
        ("provider", "rotate") | ("provider", "remove") => {
            require_absent(&provider, "--provider", "provider mutation")?;
            require_absent(&label, "--label", "provider mutation")?;
            require_absent(&role, "--role", "provider mutation")?;
            require_absent(&output, "--output", "provider mutation")?;
            if handle.is_some() || has_application_fields {
                return Err("provider mutation accepts no application authority fields".to_owned());
            }
            if action == "rotate" {
                Command::Provider(ProviderCommand::Rotate { id: required_id()? })
            } else {
                Command::Provider(ProviderCommand::Remove { id: required_id()? })
            }
        }
        ("client", "list") => {
            reject_common!("client list");
            if has_application_fields {
                return Err("client list accepts no application authority fields".to_owned());
            }
            Command::Client(ClientCommand::List)
        }
        ("client", "issue") => {
            require_absent(&id, "--id", "client issue")?;
            require_absent(&provider, "--provider", "client issue")?;
            require_absent(&handle, "--handle", "client issue")?;
            if has_application_fields {
                return Err("client issue accepts no application authority fields".to_owned());
            }
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
            require_absent(&handle, "--handle", "client revoke")?;
            if has_application_fields {
                return Err("client revoke accepts no application authority fields".to_owned());
            }
            Command::Client(ClientCommand::Revoke { id: required_id()? })
        }
        ("identity", "status") => {
            reject_common!("identity status");
            if has_application_fields {
                return Err("identity status accepts no application authority fields".to_owned());
            }
            Command::Identity(IdentityCommand::Status)
        }
        ("identity", "create") => {
            require_absent(&id, "--id", "identity create")?;
            require_absent(&provider, "--provider", "identity create")?;
            require_absent(&label, "--label", "identity create")?;
            require_absent(&role, "--role", "identity create")?;
            require_absent(&output, "--output", "identity create")?;
            if has_application_fields {
                return Err("identity create accepts no application authority fields".to_owned());
            }
            Command::Identity(IdentityCommand::Create {
                handle: handle.ok_or_else(|| "--handle is required".to_owned())?,
            })
        }
        ("application", "status") | ("application", "list") => {
            reject_common!("application read");
            if has_application_fields {
                return Err("application reads accept no authority fields".to_owned());
            }
            if action == "status" {
                Command::Application(ApplicationCommand::Status)
            } else {
                Command::Application(ApplicationCommand::List)
            }
        }
        ("application", "approve") => {
            reject_common!("application approve");
            require_absent(&approval_digest, "--approval-digest", "application approve")?;
            require_absent(
                &expires_at_unix_ms,
                "--expires-at-unix-ms",
                "application approve",
            )?;
            require_absent(&grant_id, "--grant-id", "application approve")?;
            require_absent(&reason, "--reason", "application approve")?;
            if has_provider_policy_fields {
                return Err(
                    "application approve accepts no provider grant policy fields".to_owned(),
                );
            }
            if capabilities.is_empty() {
                return Err("application approve requires at least one --capability".to_owned());
            }
            Command::Application(ApplicationCommand::Approve {
                app_id: app_id.ok_or_else(|| "--app-id is required".to_owned())?,
                app_version: app_version.ok_or_else(|| "--app-version is required".to_owned())?,
                publisher_id: publisher_id.ok_or_else(|| "--publisher is required".to_owned())?,
                manifest_digest: manifest_digest
                    .ok_or_else(|| "--manifest-digest is required".to_owned())?,
                lock_digest,
                declared_capabilities: capabilities,
            })
        }
        ("application", "revoke") => {
            reject_common!("application revoke");
            if !capabilities.is_empty()
                || app_id.is_some()
                || app_version.is_some()
                || publisher_id.is_some()
                || manifest_digest.is_some()
                || lock_digest.is_some()
                || expires_at_unix_ms.is_some()
                || has_provider_policy_fields
                || grant_id.is_some()
            {
                return Err("application revoke accepts only approval digest and reason".to_owned());
            }
            Command::Application(ApplicationCommand::Revoke {
                approval_digest: approval_digest
                    .ok_or_else(|| "--approval-digest is required".to_owned())?,
                reason: reason.ok_or_else(|| "--reason is required".to_owned())?,
            })
        }
        ("capability", "status") | ("capability", "list") => {
            reject_common!("capability read");
            if has_application_fields {
                return Err("capability reads accept no authority fields".to_owned());
            }
            if action == "status" {
                Command::Capability(CapabilityCommand::Status)
            } else {
                Command::Capability(CapabilityCommand::List)
            }
        }
        ("capability", "issue") => {
            reject_common!("capability issue");
            require_absent(&manifest_digest, "--manifest-digest", "capability issue")?;
            require_absent(&grant_id, "--grant-id", "capability issue")?;
            require_absent(&reason, "--reason", "capability issue")?;
            if capabilities.len() != 1 {
                return Err("capability issue requires exactly one --capability".to_owned());
            }
            let capability = capabilities
                .into_iter()
                .next()
                .ok_or_else(|| "--capability is required".to_owned())?;
            let provider_policy = if capability == MODEL_GENERATE_CAPABILITY {
                Some(
                    ModelGeneratePolicy::new(
                        provider_profile_id.ok_or_else(|| {
                            "model/generate requires --provider-profile".to_owned()
                        })?,
                        provider_model
                            .ok_or_else(|| "model/generate requires --provider-model".to_owned())?,
                        provider_max_output_tokens.ok_or_else(|| {
                            "model/generate requires --provider-max-output-tokens".to_owned()
                        })?,
                        provider_max_timeout_ms.ok_or_else(|| {
                            "model/generate requires --provider-max-timeout-ms".to_owned()
                        })?,
                    )
                    .map_err(|error| error.to_string())?,
                )
            } else {
                if has_provider_policy_fields {
                    return Err(
                        "provider grant policy fields are valid only for model/generate".to_owned(),
                    );
                }
                None
            };
            Command::Capability(CapabilityCommand::Issue {
                capability,
                app_id: app_id.ok_or_else(|| "--app-id is required".to_owned())?,
                app_version: app_version.ok_or_else(|| "--app-version is required".to_owned())?,
                publisher_id: publisher_id.ok_or_else(|| "--publisher is required".to_owned())?,
                approval_digest: approval_digest
                    .ok_or_else(|| "--approval-digest is required".to_owned())?,
                lock_digest,
                expires_at_unix_ms,
                provider_policy,
            })
        }
        ("capability", "revoke") => {
            reject_common!("capability revoke");
            if !capabilities.is_empty()
                || app_id.is_some()
                || app_version.is_some()
                || publisher_id.is_some()
                || manifest_digest.is_some()
                || approval_digest.is_some()
                || lock_digest.is_some()
                || expires_at_unix_ms.is_some()
                || has_provider_policy_fields
            {
                return Err("capability revoke accepts only grant id and reason".to_owned());
            }
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
         greenways-admin application status [--home PATH] [--json]\n\
         greenways-admin application list [--home PATH] [--json]\n\
         greenways-admin application approve --app-id ID --app-version VERSION \
\
           --publisher PUBLISHER --manifest-digest SHA256 --capability OP [--capability OP ...] \
\
           [--lock-digest SHA256] [--home PATH] [--json]\n\
         greenways-admin application revoke --approval-digest SHA256 --reason TEXT \
\
           [--home PATH] [--json]\n\
         greenways-admin capability status [--home PATH] [--json]\n\
         greenways-admin capability list [--home PATH] [--json]\n\
         greenways-admin capability issue --capability OP --app-id ID --app-version VERSION \
\
           --publisher PUBLISHER --approval-digest SHA256 [--lock-digest SHA256] \
\
           [--provider-profile ID --provider-model ID --provider-max-output-tokens N \
\
            --provider-max-timeout-ms N] [--expires-at-unix-ms INTEGER] [--home PATH] [--json]\n\
         greenways-admin capability revoke --grant-id ID --reason TEXT [--home PATH] [--json]\n\
         \n\
         Provider credentials and profile private keys are placed directly into operating-system\n\
         credential store. Local client credentials are written once to a new private file.\n\
         Neither secret is accepted as a command-line argument or printed. A model/generate grant\n\
         requires the four explicit provider-policy fields. Stop greenwaysd before mutating provider,\n\
         application, capability, or local-client authority."
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
    fn parses_closed_application_authority_commands() {
        let approve = parse(&[
            "application",
            "approve",
            "--app-id",
            "hara-playground",
            "--app-version",
            "1.2.3",
            "--publisher",
            "hara-lang",
            "--manifest-digest",
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "--capability",
            "model/generate",
            "--capability",
            "tahto/read",
        ])
        .expect("application approval should parse");
        assert!(matches!(
            approve.command,
            Command::Application(ApplicationCommand::Approve { .. })
        ));
        let revoke = parse(&[
            "application",
            "revoke",
            "--approval-digest",
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "--reason",
            "user-revoked",
        ])
        .expect("application revocation should parse");
        assert!(matches!(
            revoke.command,
            Command::Application(ApplicationCommand::Revoke { .. })
        ));
        assert!(parse(&[
            "application",
            "approve",
            "--app-id",
            "hara-playground",
            "--app-version",
            "1.2.3",
            "--publisher",
            "hara-lang",
            "--manifest-digest",
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
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
            "--provider-profile",
            "openai.personal",
            "--provider-model",
            "gpt-5",
            "--provider-max-output-tokens",
            "512",
            "--provider-max-timeout-ms",
            "30000",
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
        assert!(parse(&[
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
        .is_err());
        assert!(parse(&[
            "capability",
            "issue",
            "--capability",
            "tahto/read",
            "--app-id",
            "hara-playground",
            "--app-version",
            "1.2.3",
            "--publisher",
            "hara-lang",
            "--approval-digest",
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        ])
        .is_ok());
        assert!(parse(&[
            "capability",
            "issue",
            "--capability",
            "tahto/read",
            "--app-id",
            "hara-playground",
            "--app-version",
            "1.2.3",
            "--publisher",
            "hara-lang",
            "--approval-digest",
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "--provider-profile",
            "openai.personal",
        ])
        .is_err());
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
