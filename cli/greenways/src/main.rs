use greenways_authority::LocalClient as AuthorityClient;
use greenways_capabilities::{
    CapabilityAuthorityStatus, CapabilityDecision, CapabilityGrantView, CheckCapability,
};
use greenways_identity::{
    ApplicationApprovalSubject, ProfileIdentityStatus, SignedProfileIdentity,
};
use greenways_local::{
    decode_capability_decision, decode_client, decode_clients, decode_provider_result,
    AuthenticatedLocalClient, GreenwaysPaths, LocalClient,
};
use greenways_protocol::{DaemonPaths, DaemonStatus, LocalResponse, Outcome, VaultStatus};
use greenways_provider::{
    ModelMessage, ModelMessageRole, ProviderInvocation, ProviderResult, DEFAULT_MAX_OUTPUT_TOKENS,
    DEFAULT_TIMEOUT_MS, MAX_PROVIDER_INPUT_BYTES,
};
use std::{
    env,
    io::{self, IsTerminal, Read},
    path::PathBuf,
    process,
};

#[derive(Debug, Clone, Copy)]
enum Command {
    Status,
    Paths,
    Vault,
    Whoami,
    Clients,
    Invoke,
    IdentityStatus,
    IdentityCard,
    CapabilitiesStatus,
    Capabilities,
    CapabilityCheck,
}

impl Command {
    const fn requires_credential(self) -> bool {
        matches!(
            self,
            Self::Vault
                | Self::Whoami
                | Self::Clients
                | Self::Invoke
                | Self::IdentityStatus
                | Self::IdentityCard
                | Self::CapabilitiesStatus
                | Self::Capabilities
                | Self::CapabilityCheck
        )
    }
}

#[derive(Debug)]
struct Options {
    command: Command,
    home: Option<PathBuf>,
    credential: Option<PathBuf>,
    profile: Option<String>,
    model: Option<String>,
    max_output_tokens: u32,
    timeout_ms: u64,
    capability: Option<String>,
    app_id: Option<String>,
    app_version: Option<String>,
    publisher_id: Option<String>,
    approval_digest: Option<String>,
    lock_digest: Option<String>,
    json: bool,
}

fn main() {
    if let Err(message) = run() {
        eprintln!("greenways: {message}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let options = parse_options(env::args().skip(1))?;
    let paths = GreenwaysPaths::resolve(options.home).map_err(|error| error.to_string())?;
    let response = if options.command.requires_credential() {
        let credential = options
            .credential
            .as_ref()
            .ok_or_else(|| "--credential is required for this command".to_owned())?;
        let mut client = AuthenticatedLocalClient::from_paths(&paths, credential)
            .map_err(|error| error.to_string())?;
        match options.command {
            Command::Vault => client.vault_status(),
            Command::Whoami => client.whoami(),
            Command::Clients => client.clients(),
            Command::Invoke => {
                let invocation = ProviderInvocation::new(
                    options
                        .profile
                        .ok_or_else(|| "--profile is required for invoke".to_owned())?,
                    options
                        .model
                        .ok_or_else(|| "--model is required for invoke".to_owned())?,
                    vec![ModelMessage {
                        role: ModelMessageRole::User,
                        content: read_prompt_from_stdin()?,
                    }],
                    options.max_output_tokens,
                    options.timeout_ms,
                )
                .map_err(|error| error.to_string())?;
                client.invoke(invocation)
            }
            Command::IdentityStatus => client.identity_status(),
            Command::IdentityCard => client.identity_public_card(),
            Command::CapabilitiesStatus => client.capabilities_status(),
            Command::Capabilities => client.capabilities(),
            Command::CapabilityCheck => {
                let check = CheckCapability::new(
                    ApplicationApprovalSubject {
                        kind: "app".to_owned(),
                        app_id: options
                            .app_id
                            .ok_or_else(|| "--app-id is required".to_owned())?,
                        version: options
                            .app_version
                            .ok_or_else(|| "--app-version is required".to_owned())?,
                        publisher_id: options
                            .publisher_id
                            .ok_or_else(|| "--publisher is required".to_owned())?,
                        lock_digest: options.lock_digest,
                        approval_digest: options
                            .approval_digest
                            .ok_or_else(|| "--approval-digest is required".to_owned())?,
                    },
                    options
                        .capability
                        .ok_or_else(|| "--capability is required".to_owned())?,
                )
                .map_err(|error| error.to_string())?;
                client.capability_check(check)
            }
            _ => unreachable!("credential command was already classified"),
        }
        .map_err(|error| error.to_string())?
    } else {
        let client = LocalClient::from_paths(&paths);
        match options.command {
            Command::Status => client.status(),
            Command::Paths => client.paths(),
            _ => unreachable!("public command was already classified"),
        }
        .map_err(|error| error.to_string())?
    };

    if options.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&response)
                .map_err(|_| "could not encode daemon response".to_owned())?
        );
        return response_result(&response);
    }

    response_result(&response)?;
    match options.command {
        Command::Status => print_status(response)?,
        Command::Paths => print_paths(response)?,
        Command::Vault => print_vault(response)?,
        Command::Whoami => print_client(
            "Authenticated Greenways client",
            decode_client(&response).map_err(|error| error.to_string())?,
        ),
        Command::Clients => {
            print_clients(decode_clients(&response).map_err(|error| error.to_string())?)
        }
        Command::Invoke => print_provider_result(
            decode_provider_result(&response).map_err(|error| error.to_string())?,
        ),
        Command::IdentityStatus => print_identity_status(response)?,
        Command::IdentityCard => print_identity_card(response)?,
        Command::CapabilitiesStatus => print_capabilities_status(response)?,
        Command::Capabilities => print_capabilities(response)?,
        Command::CapabilityCheck => print_capability_decision(
            decode_capability_decision(&response).map_err(|error| error.to_string())?,
        ),
    }
    Ok(())
}

fn read_prompt_from_stdin() -> Result<String, String> {
    if io::stdin().is_terminal() {
        return Err(
            "provider prompt text must be piped through stdin; it is never accepted as a command-line argument"
                .to_owned(),
        );
    }
    let mut bytes = Vec::new();
    io::stdin()
        .take((MAX_PROVIDER_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "could not read provider prompt from stdin".to_owned())?;
    if bytes.len() > MAX_PROVIDER_INPUT_BYTES {
        return Err("provider prompt exceeds its input byte limit".to_owned());
    }
    let prompt =
        String::from_utf8(bytes).map_err(|_| "provider prompt must be valid UTF-8".to_owned())?;
    if prompt.trim().is_empty() {
        return Err("provider prompt cannot be empty".to_owned());
    }
    Ok(prompt)
}

fn print_status(response: LocalResponse) -> Result<(), String> {
    let status: DaemonStatus = serde_json::from_value(
        response
            .value
            .ok_or_else(|| "daemon status response had no value".to_owned())?,
    )
    .map_err(|_| "daemon status response was invalid".to_owned())?;
    println!("Greenways daemon online");
    println!("  node:       {}", status.node_id);
    println!("  generation: {}", status.generation);
    println!("  revision:   {}", status.state_revision);
    println!("  pid:        {}", status.process_id);
    println!("  authority:  {}", status.authority_mode);
    println!("  profile:    {}", status.profile_mode);
    Ok(())
}

fn print_paths(response: LocalResponse) -> Result<(), String> {
    let paths: DaemonPaths = serde_json::from_value(
        response
            .value
            .ok_or_else(|| "daemon paths response had no value".to_owned())?,
    )
    .map_err(|_| "daemon paths response was invalid".to_owned())?;
    println!("Greenways daemon paths");
    println!("  home:   {}", paths.home);
    println!("  state:  {}", paths.state_file);
    println!("  socket: {}", paths.socket_file);
    Ok(())
}

fn print_vault(response: LocalResponse) -> Result<(), String> {
    let status: VaultStatus = serde_json::from_value(
        response
            .value
            .ok_or_else(|| "vault status response had no value".to_owned())?,
    )
    .map_err(|_| "vault status response was invalid".to_owned())?;
    println!("Greenways provider vault");
    println!("  metadata:    {}", status.metadata_state);
    println!("  credentials: {}", status.credential_store);
    println!("  profiles:    {}", status.provider_profile_count);
    println!("  projects secrets: {}", status.secret_projection);
    Ok(())
}

fn print_provider_result(result: ProviderResult) {
    println!("{}", result.output);
    eprintln!(
        "greenways: {} via {} ({})",
        result.model, result.provider, result.profile_id
    );
    if let Some(usage) = result.usage {
        eprintln!(
            "greenways: tokens input={} output={} total={}",
            optional_number(usage.input_tokens),
            optional_number(usage.output_tokens),
            optional_number(usage.total_tokens),
        );
    }
}

fn optional_number(value: Option<u64>) -> String {
    value.map_or_else(|| "unknown".to_owned(), |value| value.to_string())
}

fn print_identity_status(response: LocalResponse) -> Result<(), String> {
    let status: ProfileIdentityStatus = serde_json::from_value(
        response
            .value
            .ok_or_else(|| "identity status response had no value".to_owned())?,
    )
    .map_err(|_| "identity status response was invalid".to_owned())?;
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
    Ok(())
}

fn print_identity_card(response: LocalResponse) -> Result<(), String> {
    let identity: SignedProfileIdentity = serde_json::from_value(
        response
            .value
            .ok_or_else(|| "public identity response had no value".to_owned())?,
    )
    .map_err(|_| "public identity response was invalid".to_owned())?;
    println!("Greenways public profile identity");
    println!("  id:      {}", identity.subject.id);
    println!("  handle:  {}", identity.subject.handle);
    println!("  key:     {}", identity.subject.key_id);
    println!("  root:    {}", identity.subject_root);
    Ok(())
}

fn print_capabilities_status(response: LocalResponse) -> Result<(), String> {
    let status: CapabilityAuthorityStatus = serde_json::from_value(
        response
            .value
            .ok_or_else(|| "capability status response had no value".to_owned())?,
    )
    .map_err(|_| "capability status response was invalid".to_owned())?;
    println!("Greenways capability authority");
    println!("  state:    {}", status.state);
    println!("  revision: {}", status.revision);
    println!("  grants:   {}", status.grant_count);
    println!("  active:   {}", status.active_grant_count);
    println!("  revoked:  {}", status.revoked_grant_count);
    println!("  expired:  {}", status.expired_grant_count);
    println!("  arbitrary signing: {}", status.arbitrary_signing);
    Ok(())
}

fn print_capabilities(response: LocalResponse) -> Result<(), String> {
    let grants: Vec<CapabilityGrantView> = serde_json::from_value(
        response
            .value
            .ok_or_else(|| "capability list response had no value".to_owned())?,
    )
    .map_err(|_| "capability list response was invalid".to_owned())?;
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
            "  {}  {}  {}@{}  ({state})",
            view.grant.grant.id,
            view.grant.grant.capability,
            view.grant.grant.subject.app_id,
            view.grant.grant.subject.version
        );
    }
    Ok(())
}

fn print_capability_decision(decision: CapabilityDecision) {
    println!("Greenways capability decision");
    println!("  allowed:    {}", decision.allowed);
    println!("  reason:     {}", decision.reason);
    println!("  capability: {}", decision.capability);
    println!("  approval:   {}", decision.approval_digest);
    println!(
        "  grant:      {}",
        decision.grant_id.as_deref().unwrap_or("none")
    );
    println!(
        "  grant root: {}",
        decision.grant_subject_root.as_deref().unwrap_or("none")
    );
}

fn print_client(prefix: &str, client: AuthorityClient) {
    let state = if client.revoked_at_unix_ms.is_some() {
        "revoked"
    } else {
        "active"
    };
    println!("{prefix}");
    println!("  id:    {}", client.id);
    println!("  role:  {}", client.role.as_str());
    println!("  label: {}", client.label);
    println!("  state: {state}");
}

fn print_clients(clients: Vec<AuthorityClient>) {
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
}

fn response_result(response: &LocalResponse) -> Result<(), String> {
    match response.outcome {
        Outcome::Ok => Ok(()),
        Outcome::Error => {
            let error = response
                .error
                .as_ref()
                .ok_or_else(|| "daemon returned an invalid error response".to_owned())?;
            Err(format!("{}: {}", error.code, error.message))
        }
    }
}

fn parse_options(arguments: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut arguments = arguments.peekable();
    let command = match arguments.next().as_deref() {
        Some("status") => Command::Status,
        Some("paths") => Command::Paths,
        Some("vault") => Command::Vault,
        Some("whoami") => Command::Whoami,
        Some("clients") => Command::Clients,
        Some("invoke") => Command::Invoke,
        Some("identity-status") => Command::IdentityStatus,
        Some("identity-card") => Command::IdentityCard,
        Some("capabilities-status") => Command::CapabilitiesStatus,
        Some("capabilities") => Command::Capabilities,
        Some("capability-check") => Command::CapabilityCheck,
        Some("-h") | Some("--help") | None => {
            print_help();
            process::exit(0);
        }
        Some("--version") => {
            println!("greenways {}", env!("CARGO_PKG_VERSION"));
            process::exit(0);
        }
        Some(value) => return Err(format!("unsupported command: {value}")),
    };

    let mut home = None;
    let mut credential = None;
    let mut profile = None;
    let mut model = None;
    let mut max_output_tokens = DEFAULT_MAX_OUTPUT_TOKENS;
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    let mut capability = None;
    let mut app_id = None;
    let mut app_version = None;
    let mut publisher_id = None;
    let mut approval_digest = None;
    let mut lock_digest = None;
    let mut json = false;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--home" => {
                home = Some(PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--home requires a path".to_owned())?,
                ));
            }
            "--credential" => {
                credential = Some(PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| "--credential requires a path".to_owned())?,
                ));
            }
            "--profile" => {
                profile = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--profile requires an ID".to_owned())?,
                );
            }
            "--model" => {
                model = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--model requires an ID".to_owned())?,
                );
            }
            "--max-output-tokens" => {
                max_output_tokens = arguments
                    .next()
                    .ok_or_else(|| "--max-output-tokens requires a number".to_owned())?
                    .parse()
                    .map_err(|_| "--max-output-tokens must be an integer".to_owned())?;
            }
            "--timeout-ms" => {
                timeout_ms = arguments
                    .next()
                    .ok_or_else(|| "--timeout-ms requires a number".to_owned())?
                    .parse()
                    .map_err(|_| "--timeout-ms must be an integer".to_owned())?;
            }
            "--capability" => {
                capability = Some(
                    arguments
                        .next()
                        .ok_or_else(|| "--capability requires an operation".to_owned())?,
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
                        .ok_or_else(|| "--app-version requires a version".to_owned())?,
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
            "--json" => json = true,
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            _ => return Err(format!("unsupported argument: {argument}")),
        }
    }
    if command.requires_credential() && credential.is_none() {
        return Err(
            "--credential is required for vault, whoami, clients, invoke, identity, and capability commands"
                .to_owned(),
        );
    }
    if !command.requires_credential() && credential.is_some() {
        return Err(
            "--credential is accepted only by vault, whoami, clients, invoke, identity, and capability commands"
                .to_owned(),
        );
    }
    let has_provider_fields = profile.is_some()
        || model.is_some()
        || max_output_tokens != DEFAULT_MAX_OUTPUT_TOKENS
        || timeout_ms != DEFAULT_TIMEOUT_MS;
    let has_capability_fields = capability.is_some()
        || app_id.is_some()
        || app_version.is_some()
        || publisher_id.is_some()
        || approval_digest.is_some()
        || lock_digest.is_some();
    match command {
        Command::Invoke => {
            if profile.is_none() || model.is_none() {
                return Err("invoke requires --profile and --model".to_owned());
            }
            if has_capability_fields {
                return Err(
                    "application authority fields are accepted only by capability-check".to_owned(),
                );
            }
        }
        Command::CapabilityCheck => {
            if has_provider_fields {
                return Err("provider selection and limits are accepted only by invoke".to_owned());
            }
            if capability.is_none()
                || app_id.is_none()
                || app_version.is_none()
                || publisher_id.is_none()
                || approval_digest.is_none()
            {
                return Err(
                    "capability-check requires --capability, --app-id, --app-version, --publisher, and --approval-digest"
                        .to_owned(),
                );
            }
        }
        _ if has_provider_fields => {
            return Err("provider selection and limits are accepted only by invoke".to_owned());
        }
        _ if has_capability_fields => {
            return Err(
                "application authority fields are accepted only by capability-check".to_owned(),
            );
        }
        _ => {}
    }

    Ok(Options {
        command,
        home,
        credential,
        profile,
        model,
        max_output_tokens,
        timeout_ms,
        capability,
        app_id,
        app_version,
        publisher_id,
        approval_digest,
        lock_digest,
        json,
    })
}

fn print_help() {
    println!(
        "Usage:\n\
         greenways <status|paths> [--home PATH] [--json]\n\
         greenways vault --credential PATH [--home PATH] [--json]\n\
         greenways whoami --credential PATH [--home PATH] [--json]\n\
         greenways clients --credential PATH [--home PATH] [--json]\n\
greenways invoke --credential PATH --profile ID --model ID \
  [--max-output-tokens N] [--timeout-ms N] [--home PATH] [--json]
greenways identity-status --credential PATH [--home PATH] [--json]
greenways identity-card --credential PATH [--home PATH] [--json]
greenways capabilities-status --credential PATH [--home PATH] [--json]
greenways capabilities --credential PATH [--home PATH] [--json]
greenways capability-check --credential PATH --capability OP --app-id ID \
  --app-version VERSION --publisher PUBLISHER --approval-digest SHA256 \
  [--lock-digest SHA256] [--home PATH] [--json]
         \n\
         Public reads use one-shot local IPC. Authority reads open a short-lived connection-bound\n\
         session from a private enrolled-client credential file. invoke reads one user prompt from\n\
         stdin; credentials and prompt text are never accepted as command-line values. Browser-bridge\n\
         provider invocation remains disabled until application grants land."
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(values: &[&str]) -> Result<Options, String> {
        parse_options(values.iter().map(|value| (*value).to_owned()))
    }

    #[test]
    fn requires_credentials_only_for_authority_commands() {
        assert!(parse(&["vault"]).is_err());
        assert!(parse(&["whoami"]).is_err());
        assert!(parse(&["clients"]).is_err());
        assert!(parse(&["identity-status"]).is_err());
        assert!(parse(&["identity-card"]).is_err());
        assert!(parse(&["capabilities-status"]).is_err());
        assert!(parse(&["capabilities"]).is_err());
        assert!(parse(&["capability-check"]).is_err());
        assert!(parse(&["vault", "--credential", "/tmp/client.json"]).is_ok());
        assert!(parse(&["whoami", "--credential", "/tmp/client.json",]).is_ok());
        assert!(parse(&["status", "--credential", "/tmp/client.json",]).is_err());
    }

    #[test]
    fn parses_only_one_exact_capability_check_shape() {
        assert!(parse(&[
            "capability-check",
            "--credential",
            "/tmp/browser.json",
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
        .is_ok());
        assert!(parse(&[
            "capability-check",
            "--credential",
            "/tmp/browser.json",
            "--capability",
            "model/generate",
            "--app-id",
            "hara-playground",
        ])
        .is_err());
        assert!(parse(&[
            "capability-check",
            "--credential",
            "/tmp/browser.json",
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
            "--endpoint",
            "https://evil.example",
        ])
        .is_err());
    }

    #[test]
    fn closes_provider_invoke_options() {
        assert!(parse(&[
            "invoke",
            "--credential",
            "/tmp/client.json",
            "--profile",
            "openai.personal",
            "--model",
            "gpt-5",
        ])
        .is_ok());
        assert!(parse(&[
            "invoke",
            "--credential",
            "/tmp/client.json",
            "--profile",
            "openai.personal",
            "--model",
            "gpt-5",
            "--endpoint",
            "https://evil.example",
        ])
        .is_err());
        assert!(parse(&["status", "--model", "gpt-5"]).is_err());
    }
}
