from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if text.count(old) != 1:
        raise SystemExit(f"{label} source changed")
    return text.replace(old, new, 1)


path = Path("services/greenways-desktop-bridge/src/setup/tests.rs")
text = path.read_text()
text = replace_once(
    text,
    """    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
""",
    """    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard,
    },
""",
    "temporary fixture synchronization import",
)
text = replace_once(
    text,
    """static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

struct TempSetup {
    root: PathBuf,
""",
    """static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
static TEMP_SETUP_SERIAL: Mutex<()> = Mutex::new(());

struct TempSetup {
    _serial: MutexGuard<'static, ()>,
    root: PathBuf,
""",
    "temporary fixture serial guard",
)
text = replace_once(
    text,
    """    fn new(label: &str) -> Self {
        let root = PathBuf::from(format!(
""",
    """    fn new(label: &str) -> Self {
        let serial = TEMP_SETUP_SERIAL
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let root = PathBuf::from(format!(
""",
    "temporary fixture serial acquisition",
)
text = replace_once(
    text,
    """        file.sync_all().expect("script sync");
        #[cfg(unix)]
        fs::set_permissions(&packaged_daemon, fs::Permissions::from_mode(0o755))
""",
    """        file.sync_all().expect("script sync");
        drop(file);
        #[cfg(unix)]
        fs::set_permissions(&packaged_daemon, fs::Permissions::from_mode(0o755))
""",
    "temporary executable close",
)
text = replace_once(
    text,
    """        let paths = SetupPaths::from_home_and_package(home, packaged_daemon, uid);
        Self { root, paths }
""",
    """        let paths = SetupPaths::from_home_and_package(home, packaged_daemon, uid);
        Self {
            _serial: serial,
            root,
            paths,
        }
""",
    "temporary fixture serial retention",
)
path.write_text(text)

path = Path("crates/greenways-workspace-contracts/tests/limits.rs")
text = path.read_text()
text = replace_once(
    text,
    """    let mut limits = ResourceLimits::default();
    limits.max_page = 101;
""",
    """    let limits = ResourceLimits {
        max_page: 101,
        ..ResourceLimits::default()
    };
""",
    "workspace limit construction",
)
path.write_text(text)
