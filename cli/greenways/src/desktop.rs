use serde_json::{json, Map, Value};
use std::{
    env,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const REQUEST_PROTOCOL: &str = "greenways-desktop-control/0-alpha";
const RESULT_PROTOCOL: &str = "greenways-desktop-control-result/0-alpha";
const SNAPSHOT_PROTOCOL: &str = "greenways-desktop-connection-status/0-alpha";
const SOCKET_NAME: &str = "greenways-desktop.sock";
const MAX_REQUEST: usize = 8 * 1024;
const MAX_RESPONSE: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(5);
static SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Command {
    Status,
    Connect,
    Refresh,
    Disconnect,
    ShowWindow,
    Quit,
}

impl Command {
    const fn wire(self) -> &'static str {
        match self {
            Self::Status => "status",
            Self::Connect => "connect",
            Self::Refresh => "refresh",
            Self::Disconnect => "disconnect",
            Self::ShowWindow => "show-window",
            Self::Quit => "quit",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Options {
    command: Command,
    home: Option<PathBuf>,
}

enum Parsed {
    Run(Options),
    Help,
}

pub(super) fn run_if_requested(
    arguments: impl Iterator<Item = OsString>,
) -> Result<bool, String> {
    let arguments = arguments.collect::<Vec<_>>();
    if arguments.first().and_then(|value| value.to_str()) != Some("desktop") {
        return Ok(false);
    }
    let arguments = arguments
        .into_iter()
        .skip(1)
        .map(|value| {
            value
                .into_string()
                .map_err(|_| "desktop arguments must be valid UTF-8".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    match parse(&arguments)? {
        Parsed::Help => help(),
        Parsed::Run(options) => execute(options)?,
    }
    Ok(true)
}

fn parse(arguments: &[String]) -> Result<Parsed, String> {
    if matches!(
        arguments.first().map(String::as_str),
        None | Some("-h") | Some("--help")
    ) {
        return Ok(Parsed::Help);
    }
    let command = match arguments[0].as_str() {
        "status" => Command::Status,
        "connect" => Command::Connect,
        "refresh" => Command::Refresh,
        "disconnect" => Command::Disconnect,
        "show-window" => Command::ShowWindow,
        "quit" => Command::Quit,
        value => return Err(format!("unsupported desktop command: {value}")),
    };
    let mut home = None;
    let mut json = false;
    let mut index = 1;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--home" => {
                if home.is_some() {
                    return Err("--home may be supplied only once".to_owned());
                }
                index += 1;
                let value = arguments
                    .get(index)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "--home requires a path".to_owned())?;
                home = Some(PathBuf::from(value));
            }
            "--json" => {
                if json {
                    return Err("--json may be supplied only once".to_owned());
                }
                json = true;
            }
            "-h" | "--help" => return Ok(Parsed::Help),
            value => return Err(format!("unsupported desktop argument: {value}")),
        }
        index += 1;
    }
    if !json {
        return Err("desktop commands require --json".to_owned());
    }
    Ok(Parsed::Run(Options { command, home }))
}

fn help() {
    println!(
        "Usage:\n\
         greenways desktop <status|connect|refresh|disconnect|show-window|quit> --json \
           [--home PATH]\n\n\
         Controls only the running same-user Desktop app and returns its redacted public \
         connection snapshot."
    );
}

fn home(explicit: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(value) = explicit {
        return Ok(value);
    }
    if let Some(value) = env::var_os("GREENWAYS_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value));
    }
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|value| value.join(".greenways"))
        .ok_or_else(|| "HOME is unavailable; set GREENWAYS_HOME or pass --home".to_owned())
}

#[cfg(unix)]
fn execute(options: Options) -> Result<(), String> {
    use std::{
        io::{Read, Write},
        net::Shutdown,
        os::unix::net::UnixStream,
    };

    let socket = home(options.home)?.join("run").join(SOCKET_NAME);
    let request_id = request_id();
    let mut request = serde_json::to_vec(&json!({
        "protocol": REQUEST_PROTOCOL,
        "requestId": request_id,
        "command": options.command.wire(),
    }))
    .map_err(|_| "could not encode Desktop control request".to_owned())?;
    request.push(b'\n');
    if request.len() > MAX_REQUEST {
        return Err("Desktop control request exceeded its byte limit".to_owned());
    }

    let mut stream =
        UnixStream::connect(&socket).map_err(|_| unavailable(&socket))?;
    stream
        .set_read_timeout(Some(TIMEOUT))
        .map_err(|_| "could not configure Desktop control read timeout".to_owned())?;
    stream
        .set_write_timeout(Some(TIMEOUT))
        .map_err(|_| "could not configure Desktop control write timeout".to_owned())?;
    stream
        .write_all(&request)
        .and_then(|()| stream.flush())
        .and_then(|()| stream.shutdown(Shutdown::Write))
        .map_err(|_| "could not send Desktop control request".to_owned())?;

    let mut response = Vec::new();
    stream
        .take((MAX_RESPONSE + 2) as u64)
        .read_to_end(&mut response)
        .map_err(|_| "could not read Desktop control result".to_owned())?;
    let value = frame(response, MAX_RESPONSE)?;
    let snapshot = result(&value, &request_id)?;
    println!(
        "{}",
        serde_json::to_string_pretty(snapshot)
            .map_err(|_| "could not encode Desktop connection snapshot".to_owned())?
    );
    Ok(())
}

#[cfg(not(unix))]
fn execute(_options: Options) -> Result<(), String> {
    Err("Desktop control requires Unix domain sockets".to_owned())
}

fn unavailable(socket: &Path) -> String {
    format!(
        "Greenways Desktop is unavailable at {}; launch the installed app and try again",
        socket.display()
    )
}

fn request_id() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "desktop/control/{:08x}-{:016x}-{:08x}",
        std::process::id(),
        elapsed.as_millis(),
        sequence
    )
}

fn frame(mut bytes: Vec<u8>, maximum: usize) -> Result<Value, String> {
    if bytes.is_empty() || bytes.len() > maximum + 1 {
        return Err("Desktop control result exceeded its byte limit".to_owned());
    }
    if bytes.pop() != Some(b'\n') || bytes.contains(&b'\n') {
        return Err("Desktop control result was not one bounded JSON frame".to_owned());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Desktop control result was not valid JSON".to_owned())
}

fn result<'a>(value: &'a Value, request_id: &str) -> Result<&'a Value, String> {
    scan(value, 0)?;
    let result = object(value, "Desktop control result")?;
    exact(
        result,
        &["protocol", "requestId", "outcome", "snapshot", "error"],
        "Desktop control result",
    )?;
    if text(result.get("protocol"), "result protocol", 120)? != RESULT_PROTOCOL {
        return Err("Desktop control result protocol is unsupported".to_owned());
    }
    if text(result.get("requestId"), "result request ID", 180)? != request_id {
        return Err("Desktop control result request ID did not match".to_owned());
    }
    match text(result.get("outcome"), "result outcome", 16)? {
        "ok" => {
            if !result.get("error").is_some_and(Value::is_null) {
                return Err("successful Desktop control result contained an error".to_owned());
            }
            let snapshot = result
                .get("snapshot")
                .ok_or_else(|| "Desktop control result omitted its snapshot".to_owned())?;
            snapshot_shape(snapshot)?;
            Ok(snapshot)
        }
        "error" => {
            if !result.get("snapshot").is_some_and(Value::is_null) {
                return Err("failed Desktop control result exposed a snapshot".to_owned());
            }
            let error = object(
                result
                    .get("error")
                    .ok_or_else(|| "Desktop control result omitted its error".to_owned())?,
                "Desktop control error",
            )?;
            exact(error, &["code", "message"], "Desktop control error")?;
            let code = text(error.get("code"), "Desktop control error code", 80)?;
            let message = text(error.get("message"), "Desktop control error message", 400)?;
            Err(format!("{code}: {message}"))
        }
        _ => Err("Desktop control result outcome is unsupported".to_owned()),
    }
}

fn snapshot_shape(value: &Value) -> Result<(), String> {
    let snapshot = object(value, "Desktop connection snapshot")?;
    exact(
        snapshot,
        &[
            "protocol",
            "state",
            "daemon",
            "actor",
            "identity",
            "hestiaImport",
            "session",
            "error",
            "observedAtUnixMs",
        ],
        "Desktop connection snapshot",
    )?;
    if text(snapshot.get("protocol"), "snapshot protocol", 120)? != SNAPSHOT_PROTOCOL {
        return Err("Desktop connection snapshot protocol is unsupported".to_owned());
    }
    integer(snapshot.get("observedAtUnixMs"), "observedAtUnixMs")?;
    let state = text(snapshot.get("state"), "snapshot state", 80)?;
    if ![
        "connecting",
        "connected",
        "daemon-unavailable",
        "credential-unavailable",
        "authentication-rejected",
        "session-expired",
        "protocol-mismatch",
        "desktop-bridge-unavailable",
        "disconnected",
    ]
    .contains(&state)
    {
        return Err("Desktop connection snapshot state is unsupported".to_owned());
    }
    if state == "connected" {
        for field in ["daemon", "actor", "hestiaImport", "session"] {
            object(
                snapshot
                    .get(field)
                    .ok_or_else(|| format!("connected snapshot omitted {field}"))?,
                field,
            )?;
        }
        if !snapshot.get("error").is_some_and(Value::is_null) {
            return Err("connected Desktop snapshot contained an error".to_owned());
        }
    } else {
        for field in ["daemon", "actor", "identity", "hestiaImport", "session"] {
            if !snapshot.get(field).is_some_and(Value::is_null) {
                return Err(format!("inactive Desktop snapshot exposed {field}"));
            }
        }
        let inactive = matches!(state, "connecting" | "disconnected");
        if inactive != snapshot.get("error").is_some_and(Value::is_null) {
            return Err("inactive Desktop snapshot error shape is invalid".to_owned());
        }
    }
    Ok(())
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{label} must be an object"))
}

fn exact(value: &Map<String, Value>, expected: &[&str], label: &str) -> Result<(), String> {
    if value.len() != expected.len()
        || expected.iter().any(|field| !value.contains_key(*field))
    {
        return Err(format!("{label} contains missing or unknown fields"));
    }
    Ok(())
}

fn text<'a>(value: Option<&'a Value>, field: &str, maximum: usize) -> Result<&'a str, String> {
    let value = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field} must be public text"))?;
    if value.is_empty()
        || value.len() > maximum
        || value.chars().any(|character| character.is_control())
    {
        return Err(format!("{field} must be bounded public text"));
    }
    Ok(value)
}

fn integer(value: Option<&Value>, field: &str) -> Result<(), String> {
    let value = value
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{field} must be a bounded integer"))?;
    if value > 9_007_199_254_740_991 {
        return Err(format!("{field} must be a bounded integer"));
    }
    Ok(())
}

fn scan(value: &Value, depth: usize) -> Result<(), String> {
    if depth > 32 {
        return Err("Desktop control result nesting is excessive".to_owned());
    }
    match value {
        Value::Object(entries) => {
            for (key, entry) in entries {
                let key = key
                    .chars()
                    .filter(|character| character.is_ascii_alphanumeric())
                    .flat_map(|character| character.to_lowercase())
                    .collect::<String>();
                let redaction = matches!(
                    key.as_str(),
                    "credentialstore" | "secretprojection" | "privatekeyprojection"
                );
                if !redaction
                    && [
                        "token",
                        "credential",
                        "secret",
                        "password",
                        "cookie",
                        "authorization",
                        "privatekey",
                        "keyhandle",
                        "providerhandle",
                        "sessionid",
                    ]
                    .iter()
                    .any(|forbidden| key.contains(forbidden))
                {
                    return Err("Desktop control result exposed confidential authority".to_owned());
                }
                scan(entry, depth + 1)?;
            }
        }
        Value::Array(values) => {
            for entry in values {
                scan(entry, depth + 1)?;
            }
        }
        Value::String(text) => {
            let text = text.to_ascii_lowercase();
            if text.starts_with("gwc_")
                || text.contains("local/session/")
                || text.contains("profile-key-")
                || text.contains("provider-key-")
                || text.contains("credential-key-")
            {
                return Err("Desktop control result exposed confidential authority".to_owned());
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn disconnected() -> Value {
        json!({
            "protocol": SNAPSHOT_PROTOCOL,
            "state": "disconnected",
            "daemon": null,
            "actor": null,
            "identity": null,
            "hestiaImport": null,
            "session": null,
            "error": null,
            "observedAtUnixMs": 1,
        })
    }

    #[test]
    fn parses_only_the_closed_surface() {
        let Parsed::Run(options) =
            parse(&strings(&["status", "--json", "--home", "/tmp/gw"]))
                .expect("status should parse")
        else {
            panic!("expected executable options");
        };
        assert_eq!(options.command, Command::Status);
        assert_eq!(options.home, Some(PathBuf::from("/tmp/gw")));
        assert!(parse(&strings(&["setup", "--json"])).is_err());
        assert!(parse(&strings(&["status"])).is_err());
        assert!(parse(&strings(&["status", "--json", "--json"])).is_err());
    }

    #[test]
    fn preserves_existing_flat_command_dispatch() {
        assert!(!run_if_requested([OsString::from("status")].into_iter())
            .expect("legacy dispatch should remain available"));
        assert!(!run_if_requested([OsString::from("whoami")].into_iter())
            .expect("legacy dispatch should remain available"));
    }

    #[test]
    fn validates_frames_and_request_correlation() {
        assert!(frame(b"{}\n".to_vec(), 16).is_ok());
        assert!(frame(b"{}".to_vec(), 16).is_err());
        assert!(frame(b"{}\n{}\n".to_vec(), 16).is_err());
        let value = json!({
            "protocol": RESULT_PROTOCOL,
            "requestId": "desktop/control/other-00000001",
            "outcome": "ok",
            "snapshot": disconnected(),
            "error": null,
        });
        assert!(result(&value, "desktop/control/test-00000001").is_err());
    }

    #[test]
    fn rejects_secret_shaped_results() {
        let value = json!({
            "protocol": RESULT_PROTOCOL,
            "requestId": "desktop/control/test-00000001",
            "outcome": "ok",
            "snapshot": {
                "protocol": SNAPSHOT_PROTOCOL,
                "state": "disconnected",
                "daemon": null,
                "actor": null,
                "identity": null,
                "hestiaImport": null,
                "session": null,
                "error": null,
                "observedAtUnixMs": 1,
                "credential": "gwc_private"
            },
            "error": null,
        });
        assert!(result(&value, "desktop/control/test-00000001").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn exchanges_one_correlated_socket_frame() {
        use std::{
            fs,
            io::{BufRead, BufReader, Write},
            os::unix::net::UnixListener,
            thread,
        };

        let root = env::temp_dir().join(format!(
            "greenways-cli-desktop-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let run = root.join("run");
        fs::create_dir_all(&run).expect("temporary run directory should be created");
        let socket = run.join(SOCKET_NAME);
        let listener = UnixListener::bind(&socket).expect("test socket should bind");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("client should connect");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("stream should clone"))
                .read_line(&mut request)
                .expect("request should read");
            let request: Value = serde_json::from_str(&request).expect("request should be JSON");
            let request_id = request["requestId"]
                .as_str()
                .expect("request ID should be text");
            writeln!(
                stream,
                "{}",
                json!({
                    "protocol": RESULT_PROTOCOL,
                    "requestId": request_id,
                    "outcome": "ok",
                    "snapshot": disconnected(),
                    "error": null,
                })
            )
            .expect("response should write");
        });
        execute(Options {
            command: Command::Status,
            home: Some(root.clone()),
        })
        .expect("Desktop request should succeed");
        server.join().expect("server should finish");
        fs::remove_dir_all(root).expect("temporary home should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn reports_an_unavailable_desktop_without_secrets() {
        let root = env::temp_dir().join(format!(
            "greenways-cli-desktop-missing-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let error = execute(Options {
            command: Command::Status,
            home: Some(root),
        })
        .expect_err("missing Desktop socket should fail");
        assert!(error.contains("Greenways Desktop is unavailable"));
        assert!(!error.contains("credential"));
    }
}
