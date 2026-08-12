use greenways_local::{GreenwaysPaths, LocalClient};
use greenways_protocol::{DaemonPaths, DaemonStatus, LocalResponse, Outcome, VaultStatus};
use std::{env, path::PathBuf, process};

#[derive(Debug)]
enum Command {
    Status,
    Paths,
    Vault,
}

#[derive(Debug)]
struct Options {
    command: Command,
    home: Option<PathBuf>,
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
    let client = LocalClient::from_paths(&paths);
    let response = match options.command {
        Command::Status => client.status(),
        Command::Paths => client.paths(),
        Command::Vault => client.vault_status(),
    }
    .map_err(|error| error.to_string())?;

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
        Command::Status => {
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
        }
        Command::Paths => {
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
        }
        Command::Vault => {
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
        }
    }
    Ok(())
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
    let mut json = false;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--home" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| "--home requires a path".to_owned())?;
                home = Some(PathBuf::from(value));
            }
            "--json" => json = true,
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            _ => return Err(format!("unsupported argument: {argument}")),
        }
    }

    Ok(Options {
        command,
        home,
        json,
    })
}

fn print_help() {
    println!(
        "Usage: greenways <status|paths|vault> [--home PATH] [--json]\n\
         \n\
         Reads the local authoritative greenwaysd service through its closed IPC protocol."
    );
}
