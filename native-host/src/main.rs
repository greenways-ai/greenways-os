use greenways_browser_bridge_host::{run_native_host, BROWSER_HOST_VERSION};
use std::{env, io};

fn main() {
    let arguments = env::args_os().skip(1).collect::<Vec<_>>();
    if arguments.len() == 1 && arguments[0] == "--version" {
        println!("greenways-browser-bridge-host {BROWSER_HOST_VERSION}");
        return;
    }
    if !arguments.is_empty() {
        std::process::exit(2);
    }
    if run_native_host(&mut io::stdin().lock(), &mut io::stdout().lock()).is_err() {
        std::process::exit(1);
    }
}
