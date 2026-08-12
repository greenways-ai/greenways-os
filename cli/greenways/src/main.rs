use greenways_authority::LocalClient as AuthorityClient;
use greenways_identity::{ProfileIdentityStatus, SignedProfileIdentity};
use greenways_local::{
    decode_client, decode_clients, AuthenticatedLocalClient, GreenwaysPaths, LocalClient,
};
use greenways_protocol::{DaemonPaths, DaemonStatus, LocalResponse, Outcome, VaultStatus};
use std::{env, path::PathBuf, process};

#[derive(Debug, Clone, Copy)]
enum Command {
    Status,
    Paths,
    Vault,
    Whoami,
    Clients,
    IdentityStatus,
    IdentityCard,
}

impl Command {
    const fn requires_credential(self) -> bool {
        matches!(
            self,
            Self::Whoami | Self::Clients | Self::IdentityStatus | Self::IdentityCard
        )
    }
}

#[derive(Debug)]
struct Options {
    command: Command,
    home: Option<PathBuf>,
    credential: Option<PathBuf>,
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
            Command::Whoami => client.whoami(),
            Command::Clients => client.clients(),
            Command::IdentityStatus => client.identity_status(),
            Command::IdentityCard => client.identity_public_card(),
            _ => unreachable!("credential command was already classified"),
        }
        .map_err(|error| error.to_string())?
    } else {
        let client = LocalClient::from_paths(&paths);
        match options.command {
            Command::Status => client.status(),
            Command::Paths => client.paths(),
            Command::Vault => client.vault_status(),
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
        Command::IdentityStatus => print_identity_status(response)?,
        Command::IdentityCard => print_identity_card(response)?,
    }
    Ok(())
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
        Some("identity-status") => Command::IdentityStatus,
        Some("identity-card") => Command::IdentityCard,
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
            "--credential is required for whoami, clients, and identity commands".to_owned(),
        );
    }
    if !command.requires_credential() && credential.is_some() {
        return Err("--credential is accepted only by whoami and clients".to_owned());
    }

    Ok(Options {
        command,
        home,
        credential,
        json,
    })
}

fn print_help() {
    println!(
        "Usage:\n\
         greenways <status|paths|vault> [--home PATH] [--json]\n\
         greenways whoami --credential PATH [--home PATH] [--json]\n\
         greenways clients --credential PATH [--home PATH] [--json]\n\
         greenways identity-status --credential PATH [--home PATH] [--json]\n\
         greenways identity-card --credential PATH [--home PATH] [--json]\n\
         \n\
         Public reads use one-shot local IPC. Authority reads open a short-lived connection-bound\n\
         session from a private enrolled-client credential file."
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
        assert!(parse(&["whoami"]).is_err());
        assert!(parse(&["clients"]).is_err());
        assert!(parse(&["identity-status"]).is_err());
        assert!(parse(&["identity-card"]).is_err());
        assert!(parse(&["whoami", "--credential", "/tmp/client.json",]).is_ok());
        assert!(parse(&["status", "--credential", "/tmp/client.json",]).is_err());
    }
}
