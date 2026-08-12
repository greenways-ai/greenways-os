use greenways_local::GreenwaysPaths;
use greenways_vault::{ProviderKind, ProviderProfile, ProviderVault, MAX_PROVIDER_SECRET_BYTES};
use std::{
    env,
    io::{self, IsTerminal, Read},
    path::{Path, PathBuf},
    process,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
enum Command {
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
    let metadata_path = paths.home.join("state").join("providers.json");

    match options.command {
        Command::List => {
            let vault =
                ProviderVault::open_system(metadata_path).map_err(|error| error.to_string())?;
            print_profiles(&vault.profiles(), options.json)
        }
        Command::Add {
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
            print_profile("Added", &profile, options.json)
        }
        Command::Rotate { id } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let secret = read_secret_from_stdin()?;
            let mut vault =
                ProviderVault::open_system(metadata_path).map_err(|error| error.to_string())?;
            let profile = vault
                .rotate_profile(&id, secret, now_unix_ms()?)
                .map_err(|error| error.to_string())?;
            print_profile("Rotated", &profile, options.json)
        }
        Command::Remove { id } => {
            assert_daemon_stopped(&paths.socket_file)?;
            let mut vault =
                ProviderVault::open_system(metadata_path).map_err(|error| error.to_string())?;
            let profile = vault
                .remove_profile(&id)
                .map_err(|error| error.to_string())?;
            print_profile("Removed", &profile, options.json)
        }
    }
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
            "stop greenwaysd before changing provider credentials so there is one metadata authority"
                .to_owned(),
        ),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
            ) => Ok(()),
        Err(_) => Err("could not prove that greenwaysd is stopped".to_owned()),
    }
}

#[cfg(not(unix))]
fn assert_daemon_stopped(_socket_file: &Path) -> Result<(), String> {
    Err("offline provider administration is not implemented on this platform".to_owned())
}

fn now_unix_ms() -> Result<u64, String> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock predates Unix epoch".to_owned())?;
    u64::try_from(duration.as_millis()).map_err(|_| "system clock overflowed".to_owned())
}

fn parse_options(arguments: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut arguments = arguments.peekable();
    match arguments.next().as_deref() {
        Some("provider") => {}
        Some("-h") | Some("--help") | None => {
            print_help();
            process::exit(0);
        }
        Some("--version") => {
            println!("greenways-admin {}", env!("CARGO_PKG_VERSION"));
            process::exit(0);
        }
        Some(value) => return Err(format!("unsupported command group: {value}")),
    }

    let action = arguments
        .next()
        .ok_or_else(|| "provider action is required".to_owned())?;
    let mut home = None;
    let mut json = false;
    let mut id = None;
    let mut provider = None;
    let mut label = None;

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
                        .ok_or_else(|| "--id requires a provider profile id".to_owned())?,
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
            "-h" | "--help" => {
                print_help();
                process::exit(0);
            }
            _ => return Err(format!("unsupported argument: {argument}")),
        }
    }

    let required_id = || id.clone().ok_or_else(|| "--id is required".to_owned());
    let command = match action.as_str() {
        "list" => {
            if id.is_some() || provider.is_some() || label.is_some() {
                return Err("provider list does not accept profile fields".to_owned());
            }
            Command::List
        }
        "add" => Command::Add {
            id: required_id()?,
            provider: provider.ok_or_else(|| "--provider is required".to_owned())?,
            label: label.ok_or_else(|| "--label is required".to_owned())?,
        },
        "rotate" => {
            if provider.is_some() || label.is_some() {
                return Err("provider rotate accepts only --id".to_owned());
            }
            Command::Rotate { id: required_id()? }
        }
        "remove" => {
            if provider.is_some() || label.is_some() {
                return Err("provider remove accepts only --id".to_owned());
            }
            Command::Remove { id: required_id()? }
        }
        _ => return Err(format!("unsupported provider action: {action}")),
    };

    Ok(Options {
        command,
        home,
        json,
    })
}

fn print_help() {
    println!(
        "Usage:\n\
         greenways-admin provider list [--home PATH] [--json]\n\
         greenways-admin provider add --id ID --provider PROVIDER --label LABEL [--home PATH] [--json]\n\
         greenways-admin provider rotate --id ID [--home PATH] [--json]\n\
         greenways-admin provider remove --id ID [--home PATH] [--json]\n\
         \n\
         Add and rotate read the credential from stdin. The secret is placed directly into the\n\
         operating-system credential store and is never accepted as an argument or printed.\n\
         Stop greenwaysd before mutating provider profiles."
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_closed_provider_commands() {
        let options = parse_options(
            [
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
            ]
            .into_iter()
            .map(str::to_owned),
        )
        .expect("add command should parse");
        assert!(matches!(
            options.command,
            Command::Add {
                provider: ProviderKind::OpenAi,
                ..
            }
        ));
        assert_eq!(options.home, Some(PathBuf::from("/tmp/greenways")));
        assert!(options.json);
    }

    #[test]
    fn rejects_secret_and_endpoint_arguments() {
        for field in ["--secret", "--endpoint", "--key"] {
            let result = parse_options(
                [
                    "provider",
                    "rotate",
                    "--id",
                    "openai.personal",
                    field,
                    "value",
                ]
                .into_iter()
                .map(str::to_owned),
            );
            assert!(result.is_err());
        }
    }
}
