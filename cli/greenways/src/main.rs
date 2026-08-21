mod desktop;

mod legacy {
    include!("legacy.rs");

    pub(super) fn dispatch() {
        main();
    }
}

fn main() {
    match desktop::run_if_requested(std::env::args_os().skip(1)) {
        Ok(true) => {}
        Ok(false) => legacy::dispatch(),
        Err(message) => {
            eprintln!("greenways: {message}");
            std::process::exit(1);
        }
    }
}
