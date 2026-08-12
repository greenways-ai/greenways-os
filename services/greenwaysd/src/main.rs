use greenways_local::GreenwaysPaths;
use greenwaysd::serve;
use serde_json::json;
use std::{env, path::PathBuf, process};

#[derive(Debug, Default)]
struct Options {
    home: Option<PathBuf>,
    once: bool,
    print_paths: bool,
}

fn main() {
    if let Err(message) = run() {
        eprintln!("greenwaysd: {message}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let options = parse_options(env::args().skip(1))?;
    let paths = GreenwaysPaths::resolve(options.home).map_err(|error| error.to_string())?;
    if options.print_paths {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "home": paths.home,
                "stateFile": paths.state_file,
                "socketFile": paths.socket_file,
            }))
            .map_err(|_| "could not encode Greenways paths".to_owned())?
        );
        return Ok(());
    }
    serve(paths, options.once).map_err(|error| error.to_string())
}

fn parse_options(arguments: impl Iterator<Item = String>) -> Result<Options, String> {
    let mut options = Options::default();
    let mut arguments = arguments.peekable();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--home" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| "--home requires a path".to_owned())?;
                options.home = Some(PathBuf::from(value));
            }
            "--once" => options.once = true,
            "--print-paths" => options.print_paths = true,
            "--version" => {
                println!("greenwaysd {}", env!("CARGO_PKG_VERSION"));
                process::exit(0);
            }
            "-h" | "--help" => {
                println!(
                    "Usage: greenwaysd [--home PATH] [--once] [--print-paths]\n\
                     \n\
                     Runs the authoritative Greenways service in the foreground.\n\
                     Service managers should own daemonization and restart policy."
                );
                process::exit(0);
            }
            _ => return Err(format!("unsupported argument: {argument}")),
        }
    }
    Ok(options)
}
