use super::{
    browser::{BROWSER_CLIENT_LABEL, BROWSER_HOST_NAME, CHROME_EXTENSION_ORIGIN},
    decode_setup_request, encode_setup_response,
    inspect::DesktopSetupEngine,
    service::{
        expected_launch_agent_plist, BrowserInstallStage, LaunchAgentController, SetupPaths,
        BROWSER_MANIFEST_FILE, DAEMON_SERVICE_LABEL, DESKTOP_CLIENT_LABEL,
    },
    DesktopSetupBackend, DesktopSetupComponentKind, DesktopSetupError, DesktopSetupHost,
    DesktopSetupOperation, DesktopSetupRequest, DesktopSetupState, DESKTOP_SETUP_PROTOCOL,
    DESKTOP_SETUP_RESULT_PROTOCOL,
};
use greenways_authority::{read_credential_file, LocalClientRegistry, LocalClientRole};
use greenways_identity::{IdentityError, ProfileIdentityVault};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    process,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard,
    },
};

#[cfg(unix)]
use std::os::unix::{
    fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    net::UnixListener,
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
static TEMP_SETUP_SERIAL: Mutex<()> = Mutex::new(());
static BROWSER_RACE_DESTINATION: Mutex<Option<PathBuf>> = Mutex::new(None);

struct TempSetup {
    _serial: MutexGuard<'static, ()>,
    root: PathBuf,
    paths: SetupPaths,
}

impl TempSetup {
    fn new(label: &str) -> Self {
        let serial = TEMP_SETUP_SERIAL
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let root = PathBuf::from(format!(
            "/tmp/gwds-{label}-{}-{}",
            process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let home = root.join("home");
        fs::create_dir_all(&home).expect("temp home");
        #[cfg(unix)]
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).expect("home mode");
        let package_dir = root.join("package");
        fs::create_dir_all(&package_dir).expect("package dir");
        let packaged_daemon = package_dir.join("greenwaysd");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o755);
        let mut file = options.open(&packaged_daemon).expect("packaged daemon");
        writeln!(file, "#!/bin/sh").expect("script");
        writeln!(file, "if [ \"${{1:-}}\" = \"--version\" ]; then").expect("script");
        writeln!(file, "  echo 'greenwaysd {}'", env!("CARGO_PKG_VERSION")).expect("script");
        writeln!(file, "  exit 0").expect("script");
        writeln!(file, "fi").expect("script");
        writeln!(file, "exit 0").expect("script");
        file.sync_all().expect("script sync");
        drop(file);
        #[cfg(unix)]
        fs::set_permissions(&packaged_daemon, fs::Permissions::from_mode(0o755))
            .expect("script mode");
        let packaged_browser_host = package_dir.join("greenways-browser-bridge-host");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o755);
        let mut file = options
            .open(&packaged_browser_host)
            .expect("packaged browser host");
        writeln!(file, "#!/bin/sh").expect("browser script");
        writeln!(file, "if [ \"${{1:-}}\" = \"--version\" ]; then").expect("browser script");
        writeln!(
            file,
            "  echo 'greenways-browser-bridge-host {}'",
            env!("CARGO_PKG_VERSION")
        )
        .expect("browser script");
        writeln!(file, "  exit 0").expect("browser script");
        writeln!(file, "fi").expect("browser script");
        writeln!(file, "exit 0").expect("browser script");
        file.sync_all().expect("browser script sync");
        drop(file);
        #[cfg(unix)]
        fs::set_permissions(&packaged_browser_host, fs::Permissions::from_mode(0o755))
            .expect("browser script mode");
        #[cfg(unix)]
        let uid = fs::symlink_metadata(&home).expect("home metadata").uid();
        #[cfg(not(unix))]
        let uid = 0;
        let paths = SetupPaths::from_home_and_package(home, packaged_daemon, uid);
        Self {
            _serial: serial,
            root,
            paths,
        }
    }
}

impl Drop for TempSetup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Debug, Clone)]
struct FakeLaunchAgentController {
    socket: PathBuf,
    restart_calls: Arc<AtomicUsize>,
    stop_calls: Arc<AtomicUsize>,
}

impl FakeLaunchAgentController {
    fn new(socket: PathBuf) -> Self {
        Self {
            socket,
            restart_calls: Arc::new(AtomicUsize::new(0)),
            stop_calls: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn restart_calls(&self) -> usize {
        self.restart_calls.load(Ordering::Relaxed)
    }

    fn stop_calls(&self) -> usize {
        self.stop_calls.load(Ordering::Relaxed)
    }
}

impl LaunchAgentController for FakeLaunchAgentController {
    fn stop(&mut self, label: &str, uid: u32) -> Result<(), DesktopSetupError> {
        self.stop_calls.fetch_add(1, Ordering::Relaxed);
        assert_eq!(label, DAEMON_SERVICE_LABEL);
        assert!(uid > 0 || cfg!(not(unix)));
        if self.socket.exists() {
            fs::remove_file(&self.socket).expect("remove fake daemon socket");
        }
        Ok(())
    }

    fn restart(
        &mut self,
        launch_agent: &Path,
        label: &str,
        uid: u32,
    ) -> Result<(), DesktopSetupError> {
        self.restart_calls.fetch_add(1, Ordering::Relaxed);
        assert_eq!(label, DAEMON_SERVICE_LABEL);
        assert_eq!(
            launch_agent.file_name().and_then(|value| value.to_str()),
            Some("ai.greenways.greenwaysd.plist")
        );
        assert!(uid > 0 || cfg!(not(unix)));
        #[cfg(unix)]
        {
            if self.socket.exists() {
                fs::remove_file(&self.socket).expect("remove stale socket");
            }
            let listener = UnixListener::bind(&self.socket).expect("bind fake daemon socket");
            drop(listener);
        }
        Ok(())
    }
}

fn request(operation: DesktopSetupOperation) -> DesktopSetupRequest {
    DesktopSetupRequest {
        protocol: DESKTOP_SETUP_PROTOCOL.to_owned(),
        request_id: "desktop/request/setup0001".to_owned(),
        operation,
        handle: None,
    }
}

fn identity_request(handle: &str) -> DesktopSetupRequest {
    DesktopSetupRequest {
        handle: Some(handle.to_owned()),
        ..request(DesktopSetupOperation::CreateIdentity)
    }
}

fn open_test_identity_vault(path: PathBuf) -> Result<ProfileIdentityVault, IdentityError> {
    ProfileIdentityVault::open_test(path)
}

fn unavailable_identity_vault(_: PathBuf) -> Result<ProfileIdentityVault, IdentityError> {
    Err(IdentityError::KeyStoreUnavailable)
}

#[test]
fn setup_request_is_closed_and_rejects_unknown_inputs() {
    let decoded = decode_setup_request(
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"inspect","handle":null}"#,
    )
    .expect("closed setup request");
    assert_eq!(decoded.operation, DesktopSetupOperation::Inspect);
    assert!(decode_setup_request(
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"inspect"}"#,
    )
    .is_err());
    assert!(decode_setup_request(
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"inspect","handle":null,"path":"/tmp/daemon"}"#,
    )
    .is_err());
    assert!(decode_setup_request(
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"run-command","handle":null}"#,
    )
    .is_err());
    let browser = decode_setup_request(
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"install-browser-bridge","handle":null}"#,
    )
    .expect("closed browser request");
    assert_eq!(
        browser.operation,
        DesktopSetupOperation::InstallBrowserBridge
    );
    for invalid in [
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"install-browser-bridge","handle":"chrome"}"#.as_slice(),
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"install-browser-bridge","handle":null,"browser":"chrome"}"#.as_slice(),
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"install-browser-bridge","handle":null,"extensionId":"caller-selected"}"#.as_slice(),
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"install-browser-bridge","handle":null,"origin":"chrome-extension://caller/"}"#.as_slice(),
    ] {
        assert!(decode_setup_request(invalid).is_err());
    }

    let identity = decode_setup_request(
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"create-identity","handle":"river.studio"}"#,
    )
    .expect("closed identity request");
    assert_eq!(identity.handle.as_deref(), Some("river.studio"));
    for invalid in [
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"create-identity","handle":null}"#.as_slice(),
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"create-identity","handle":"River.Studio"}"#.as_slice(),
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"create-identity","handle":"river/studio"}"#.as_slice(),
        br#"{"protocol":"greenways-desktop-setup/0-alpha","requestId":"desktop/request/setup0001","operation":"inspect","handle":"river.studio"}"#.as_slice(),
    ] {
        assert!(decode_setup_request(invalid).is_err());
    }
}

#[test]
fn inspection_exposes_actions_without_paths_or_secrets() {
    let temp = TempSetup::new("inspection");
    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let mut backend = DesktopSetupEngine::new(temp.paths.clone(), controller);
    let snapshot = backend.inspect().expect("inspect");
    assert_eq!(snapshot.state, DesktopSetupState::InstallRequired);
    assert_eq!(
        snapshot.permitted_actions,
        vec![
            DesktopSetupOperation::InstallDaemon,
            DesktopSetupOperation::Inspect,
        ]
    );
    let value = serde_json::to_string(&snapshot).expect("snapshot json");
    assert!(!value.contains(".greenways"));
    assert!(!value.contains("desktop.json"));
    assert!(!value.contains("token"));
    assert!(!value.contains("session"));
}

#[test]
fn daemon_installation_is_fixed_atomic_and_idempotent() {
    let temp = TempSetup::new("install");
    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let mut backend = DesktopSetupEngine::new(temp.paths.clone(), controller);

    let installed = backend.install_daemon().expect("install daemon");
    assert_eq!(installed.state, DesktopSetupState::CredentialRequired);
    let daemon = installed
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::Daemon)
        .expect("daemon component");
    assert_eq!(daemon.state, DesktopSetupState::Ready);
    assert_eq!(daemon.public_id.as_deref(), Some(DAEMON_SERVICE_LABEL));
    assert!(daemon
        .digest
        .as_deref()
        .is_some_and(|value| value.starts_with("sha256:")));
    assert!(temp.paths.installed_daemon.is_file());
    assert!(temp.paths.launch_agent.is_file());

    let second = backend.install_daemon();
    assert!(matches!(
        second,
        Err(DesktopSetupError::OperationUnavailable(_))
    ));
}

#[test]
fn desktop_client_enrollment_is_fixed_private_and_verified() {
    let temp = TempSetup::new("desktop-client");
    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let mut backend = DesktopSetupEngine::new(temp.paths.clone(), controller);
    let installed = backend.install_daemon().expect("install daemon");
    assert_eq!(installed.state, DesktopSetupState::CredentialRequired);
    assert_eq!(
        installed.permitted_actions,
        vec![
            DesktopSetupOperation::IssueDesktopClient,
            DesktopSetupOperation::Inspect,
        ]
    );

    let enrolled = backend
        .issue_desktop_client()
        .expect("issue fixed Desktop client");
    assert_eq!(enrolled.state, DesktopSetupState::IdentityOptional);
    let component = enrolled
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::DesktopClient)
        .expect("Desktop client component");
    assert_eq!(component.state, DesktopSetupState::Ready);
    let client_id = component.public_id.as_deref().expect("public client id");
    assert!(client_id.starts_with("local/client/"));

    let credential =
        read_credential_file(temp.paths.desktop_credential()).expect("private Desktop credential");
    assert_eq!(credential.role, LocalClientRole::Desktop);
    let registry = LocalClientRegistry::open(temp.paths.local_client_registry())
        .expect("private local-client registry");
    let verified = registry
        .verify_credential(&credential)
        .expect("credential verifies");
    assert_eq!(verified.id, client_id);
    assert_eq!(verified.label, DESKTOP_CLIENT_LABEL);

    #[cfg(unix)]
    {
        assert_eq!(
            fs::metadata(temp.paths.desktop_credential())
                .expect("credential metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(temp.paths.local_client_registry())
                .expect("registry metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    let serialized = serde_json::to_string(&enrolled).expect("setup snapshot");
    assert!(!serialized.contains("gwc_"));
    assert!(!serialized.contains("desktop.json"));
    assert!(!serialized.contains("local-clients.json"));
    assert!(matches!(
        backend.issue_desktop_client(),
        Err(DesktopSetupError::OperationUnavailable(_))
    ));
}

#[test]
fn missing_credential_for_an_active_desktop_client_requires_manual_recovery() {
    let temp = TempSetup::new("orphan-client");
    fs::create_dir_all(&temp.paths.state_dir).expect("state directory");
    fs::create_dir_all(&temp.paths.clients_dir).expect("clients directory");
    #[cfg(unix)]
    {
        fs::set_permissions(&temp.paths.state_dir, fs::Permissions::from_mode(0o700))
            .expect("state mode");
        fs::set_permissions(&temp.paths.clients_dir, fs::Permissions::from_mode(0o700))
            .expect("clients mode");
    }
    let orphan_credential = temp.paths.clients_dir.join("orphan.json");
    let mut registry =
        LocalClientRegistry::open(temp.paths.local_client_registry()).expect("registry");
    registry
        .issue_to_file(
            LocalClientRole::Desktop,
            DESKTOP_CLIENT_LABEL,
            &orphan_credential,
            1,
        )
        .expect("orphan client");
    fs::remove_file(orphan_credential).expect("remove orphan credential");

    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let mut backend = DesktopSetupEngine::new(temp.paths.clone(), controller);
    let snapshot = backend.inspect().expect("inspect orphan client");
    let component = snapshot
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::DesktopClient)
        .expect("Desktop client component");
    assert_eq!(component.state, DesktopSetupState::ManualRecoveryRequired);
    assert!(!snapshot
        .permitted_actions
        .contains(&DesktopSetupOperation::IssueDesktopClient));
}

#[test]
fn public_identity_creation_is_fixed_private_verified_and_create_once() {
    let temp = TempSetup::new("identity");
    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let controller_probe = controller.clone();
    let mut backend = DesktopSetupEngine::new_with_identity_vault_opener(
        temp.paths.clone(),
        controller,
        open_test_identity_vault,
    );
    backend.install_daemon().expect("install daemon");
    let enrolled = backend
        .issue_desktop_client()
        .expect("issue fixed Desktop client");
    assert_eq!(enrolled.state, DesktopSetupState::IdentityOptional);
    assert_eq!(
        enrolled.permitted_actions,
        vec![
            DesktopSetupOperation::CreateIdentity,
            DesktopSetupOperation::Inspect,
        ]
    );

    let stop_calls_before = controller_probe.stop_calls();
    let restart_calls_before = controller_probe.restart_calls();
    let created = backend
        .create_identity("river.studio")
        .expect("create public identity");
    assert_eq!(created.state, DesktopSetupState::BrowserCompanionOptional);
    assert_eq!(controller_probe.stop_calls(), stop_calls_before + 1);
    assert_eq!(controller_probe.restart_calls(), restart_calls_before + 1);
    let component = created
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::Identity)
        .expect("identity component");
    assert_eq!(component.state, DesktopSetupState::Ready);
    let identity_id = component.public_id.as_deref().expect("public identity id");
    assert!(identity_id.starts_with("identity/"));

    let vault =
        ProfileIdentityVault::open_test(temp.paths.identity_metadata()).expect("identity metadata");
    let public = vault.public_identity().expect("public identity");
    assert_eq!(public.subject.id, identity_id);
    assert_eq!(public.subject.handle, "river.studio");
    assert!(!vault.status().private_key_projection);

    #[cfg(unix)]
    assert_eq!(
        fs::metadata(temp.paths.identity_metadata())
            .expect("identity metadata mode")
            .permissions()
            .mode()
            & 0o777,
        0o600
    );

    let serialized = serde_json::to_string(&created).expect("setup snapshot");
    assert!(!serialized.contains("profile-key-"));
    assert!(!serialized.contains("privateKey"));
    assert!(!serialized.contains("subjectRoot"));
    assert!(!serialized.contains("signature"));
    assert!(!serialized.contains("profile-identity.json"));
    assert!(matches!(
        backend.create_identity("another.identity"),
        Err(DesktopSetupError::OperationUnavailable(_))
    ));
}

#[test]
fn identity_creation_failure_restores_the_daemon_service() {
    let temp = TempSetup::new("identity-restore");
    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let mut preparation = DesktopSetupEngine::new_with_identity_vault_opener(
        temp.paths.clone(),
        controller,
        open_test_identity_vault,
    );
    preparation.install_daemon().expect("install daemon");
    preparation
        .issue_desktop_client()
        .expect("issue fixed Desktop client");

    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let controller_probe = controller.clone();
    let mut backend = DesktopSetupEngine::new_with_identity_vault_opener(
        temp.paths.clone(),
        controller,
        unavailable_identity_vault,
    );
    let stop_calls_before = controller_probe.stop_calls();
    let restart_calls_before = controller_probe.restart_calls();
    assert!(matches!(
        backend.create_identity("restore.identity"),
        Err(DesktopSetupError::InstallationFailed(_))
    ));
    assert_eq!(controller_probe.stop_calls(), stop_calls_before + 1);
    assert_eq!(controller_probe.restart_calls(), restart_calls_before + 1);
    assert!(!temp.paths.identity_metadata().exists());
}

#[test]
fn host_routes_only_the_closed_identity_request() {
    let temp = TempSetup::new("identity-host");
    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let mut preparation = DesktopSetupEngine::new_with_identity_vault_opener(
        temp.paths.clone(),
        controller,
        open_test_identity_vault,
    );
    preparation.install_daemon().expect("install daemon");
    preparation
        .issue_desktop_client()
        .expect("issue fixed Desktop client");

    let backend = DesktopSetupEngine::new_with_identity_vault_opener(
        temp.paths.clone(),
        FakeLaunchAgentController::new(temp.paths.socket_file()),
        open_test_identity_vault,
    );
    let mut host = DesktopSetupHost::new(backend, 1);
    let response = host
        .handle(identity_request("host.identity"))
        .expect("closed identity response");
    assert_eq!(
        response.snapshot.state,
        DesktopSetupState::BrowserCompanionOptional
    );
    assert!(response
        .snapshot
        .components
        .iter()
        .any(
            |component| component.kind == DesktopSetupComponentKind::Identity
                && component.state == DesktopSetupState::Ready
        ));
}

#[test]
fn launch_agent_has_only_fixed_non_secret_arguments() {
    let temp = TempSetup::new("plist");
    let bytes = expected_launch_agent_plist(&temp.paths).expect("plist");
    let text = String::from_utf8(bytes).expect("plist text");
    assert!(text.contains("ai.greenways.greenwaysd"));
    assert!(text.contains("<string>--home</string>"));
    assert!(text.contains("<key>KeepAlive</key>"));
    assert!(!text.contains("credential"));
    assert!(!text.contains("token"));
    assert!(!text.contains("session"));
    assert!(!text.contains("provider"));
}

#[test]
fn permission_repair_is_bounded_to_fixed_owned_files() {
    let temp = TempSetup::new("permissions");
    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let mut backend = DesktopSetupEngine::new(temp.paths.clone(), controller);
    backend.install_daemon().expect("install daemon");
    #[cfg(unix)]
    fs::set_permissions(&temp.paths.state_dir, fs::Permissions::from_mode(0o755))
        .expect("break state mode");

    let broken = backend.inspect().expect("inspect broken");
    assert_eq!(broken.state, DesktopSetupState::PermissionRepairRequired);
    assert_eq!(
        broken.permitted_actions,
        vec![
            DesktopSetupOperation::RepairPermissions,
            DesktopSetupOperation::Inspect,
        ]
    );
    let repaired = backend.repair_permissions().expect("repair permissions");
    assert_eq!(repaired.state, DesktopSetupState::CredentialRequired);
}

#[test]
fn host_returns_closed_failed_state_for_unavailable_authority() {
    let temp = TempSetup::new("host");
    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let backend = DesktopSetupEngine::new(temp.paths.clone(), controller);
    let mut host = DesktopSetupHost::new(backend, 1);
    let response = host
        .handle(request(DesktopSetupOperation::InstallBrowserBridge))
        .expect("bounded unavailable response");
    assert_eq!(response.protocol, DESKTOP_SETUP_RESULT_PROTOCOL);
    assert_eq!(response.snapshot.state, DesktopSetupState::Failed);
    assert_eq!(
        response
            .snapshot
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("setup-operation-unavailable")
    );
    let bytes = encode_setup_response(&response).expect("response");
    let text = String::from_utf8(bytes).expect("response text");
    assert!(!text.contains(".greenways"));
    assert!(!text.contains("gwc_"));
}

fn prepared_browser_backend(
    temp: &TempSetup,
) -> (
    DesktopSetupEngine<FakeLaunchAgentController>,
    FakeLaunchAgentController,
) {
    let controller = FakeLaunchAgentController::new(temp.paths.socket_file());
    let probe = controller.clone();
    let mut backend = DesktopSetupEngine::new_with_identity_vault_opener(
        temp.paths.clone(),
        controller,
        open_test_identity_vault,
    );
    backend.install_daemon().expect("install daemon");
    backend
        .issue_desktop_client()
        .expect("issue fixed Desktop client");
    let optional = backend
        .create_identity("browser.fixture")
        .expect("create fixture identity");
    assert_eq!(optional.state, DesktopSetupState::BrowserCompanionOptional);
    assert_eq!(
        optional.permitted_actions,
        vec![
            DesktopSetupOperation::InstallBrowserBridge,
            DesktopSetupOperation::Inspect,
        ]
    );
    (backend, probe)
}

fn fail_after_browser_host(stage: BrowserInstallStage) -> Result<(), DesktopSetupError> {
    if stage == BrowserInstallStage::HostInstalled {
        Err(DesktopSetupError::InstallationFailed(
            "Injected browser host installation failure.".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn inject_browser_host_destination(stage: BrowserInstallStage) -> Result<(), DesktopSetupError> {
    if stage != BrowserInstallStage::Enrolled {
        return Ok(());
    }
    let destination = BROWSER_RACE_DESTINATION
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
        .expect("browser race destination");
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o755);
    let mut file = options.open(destination).expect("race browser host");
    writeln!(file, "#!/bin/sh").expect("race browser host");
    writeln!(file, "echo 'changed destination'").expect("race browser host");
    file.sync_all().expect("race browser host");
    Ok(())
}

#[test]
fn browser_companion_installation_is_exact_private_and_create_once() {
    let temp = TempSetup::new("browser-install");
    let (mut backend, controller_probe) = prepared_browser_backend(&temp);
    let stop_calls_before = controller_probe.stop_calls();
    let restart_calls_before = controller_probe.restart_calls();

    let installed = backend
        .install_browser_bridge()
        .expect("install exact browser companion");
    assert_eq!(installed.state, DesktopSetupState::VerificationRequired);
    assert_eq!(
        installed.permitted_actions,
        vec![DesktopSetupOperation::Inspect]
    );
    assert_eq!(controller_probe.stop_calls(), stop_calls_before + 1);
    assert_eq!(controller_probe.restart_calls(), restart_calls_before + 1);

    let component = installed
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::BrowserCompanion)
        .expect("browser component");
    assert_eq!(component.state, DesktopSetupState::Ready);
    assert_eq!(component.public_id.as_deref(), Some(BROWSER_HOST_NAME));
    assert_eq!(
        component.version.as_deref(),
        Some(env!("CARGO_PKG_VERSION"))
    );
    assert!(component
        .digest
        .as_deref()
        .is_some_and(|digest| digest.starts_with("sha256:")));

    let browser_credential =
        read_credential_file(temp.paths.browser_credential()).expect("browser credential");
    let desktop_credential =
        read_credential_file(temp.paths.desktop_credential()).expect("desktop credential");
    assert_eq!(browser_credential.role, LocalClientRole::BrowserBridge);
    assert_ne!(browser_credential.client_id, desktop_credential.client_id);
    let registry =
        LocalClientRegistry::open(temp.paths.local_client_registry()).expect("client registry");
    let browser_client = registry
        .verify_credential(&browser_credential)
        .expect("verified browser credential");
    assert_eq!(browser_client.label, BROWSER_CLIENT_LABEL);
    assert_eq!(
        registry
            .clients()
            .iter()
            .filter(|client| {
                client.role == LocalClientRole::BrowserBridge && client.revoked_at_unix_ms.is_none()
            })
            .count(),
        1
    );

    let manifest_bytes = fs::read(&temp.paths.browser_manifest).expect("browser manifest");
    let manifest: serde_json::Value =
        serde_json::from_slice(&manifest_bytes).expect("browser manifest json");
    assert_eq!(
        temp.paths
            .browser_manifest
            .file_name()
            .and_then(|name| name.to_str()),
        Some(BROWSER_MANIFEST_FILE)
    );
    assert_eq!(manifest["name"], BROWSER_HOST_NAME);
    assert_eq!(manifest["type"], "stdio");
    assert_eq!(
        manifest["path"],
        temp.paths
            .installed_browser_host
            .to_str()
            .expect("fixed host path")
    );
    assert_eq!(
        manifest["allowed_origins"].as_array().map(Vec::len),
        Some(1)
    );
    assert_eq!(manifest["allowed_origins"][0], CHROME_EXTENSION_ORIGIN);

    #[cfg(unix)]
    {
        assert_eq!(
            fs::metadata(temp.paths.browser_credential())
                .expect("credential mode")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&temp.paths.installed_browser_host)
                .expect("host mode")
                .permissions()
                .mode()
                & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(&temp.paths.browser_manifest)
                .expect("manifest mode")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    let serialized = serde_json::to_string(&installed).expect("bounded setup projection");
    for forbidden in [
        "/.greenways",
        "browser-bridge.json",
        "NativeMessagingHosts",
        CHROME_EXTENSION_ORIGIN,
        "gwc_",
        "sessionId",
        browser_client.id.as_str(),
    ] {
        assert!(!serialized.contains(forbidden), "leaked {forbidden}");
    }
    assert!(matches!(
        backend.install_browser_bridge(),
        Err(DesktopSetupError::OperationUnavailable(_))
    ));
    let registry =
        LocalClientRegistry::open(temp.paths.local_client_registry()).expect("client registry");
    assert_eq!(
        registry
            .clients()
            .iter()
            .filter(|client| {
                client.role == LocalClientRole::BrowserBridge && client.revoked_at_unix_ms.is_none()
            })
            .count(),
        1
    );
}

#[test]
fn browser_partial_install_rolls_back_and_restores_the_daemon() {
    let temp = TempSetup::new("browser-rollback");
    let (mut backend, controller_probe) = prepared_browser_backend(&temp);
    backend.set_browser_install_hook(fail_after_browser_host);
    let stop_calls_before = controller_probe.stop_calls();
    let restart_calls_before = controller_probe.restart_calls();

    assert!(matches!(
        backend.install_browser_bridge(),
        Err(DesktopSetupError::InstallationFailed(_))
    ));
    assert_eq!(controller_probe.stop_calls(), stop_calls_before + 1);
    assert_eq!(controller_probe.restart_calls(), restart_calls_before + 1);
    assert!(temp.paths.socket_file().exists());
    assert!(!temp.paths.browser_credential().exists());
    assert!(!temp.paths.installed_browser_host.exists());
    assert!(!temp.paths.browser_manifest.exists());

    let registry =
        LocalClientRegistry::open(temp.paths.local_client_registry()).expect("client registry");
    assert_eq!(
        registry
            .clients()
            .iter()
            .filter(|client| {
                client.role == LocalClientRole::BrowserBridge && client.revoked_at_unix_ms.is_none()
            })
            .count(),
        0
    );
    let inspected = backend.inspect().expect("inspect after rollback");
    assert_eq!(inspected.state, DesktopSetupState::BrowserCompanionOptional);
}

#[test]
fn browser_install_never_overwrites_a_destination_changed_after_prepare() {
    let temp = TempSetup::new("browser-race");
    let (mut backend, controller_probe) = prepared_browser_backend(&temp);
    *BROWSER_RACE_DESTINATION
        .lock()
        .unwrap_or_else(|error| error.into_inner()) =
        Some(temp.paths.installed_browser_host.clone());
    backend.set_browser_install_hook(inject_browser_host_destination);
    let stop_calls_before = controller_probe.stop_calls();
    let restart_calls_before = controller_probe.restart_calls();

    let recovery = backend
        .install_browser_bridge()
        .expect("bounded browser manual-recovery snapshot");
    assert_eq!(recovery.state, DesktopSetupState::ManualRecoveryRequired);
    assert_eq!(controller_probe.stop_calls(), stop_calls_before + 1);
    assert_eq!(controller_probe.restart_calls(), restart_calls_before + 1);
    assert!(temp.paths.socket_file().exists());
    assert_eq!(
        fs::read_to_string(&temp.paths.installed_browser_host)
            .expect("changed browser destination"),
        "#!/bin/sh\necho 'changed destination'\n"
    );
    let inspected = backend
        .inspect()
        .expect("inspect changed browser destination");
    assert_eq!(inspected.state, DesktopSetupState::ManualRecoveryRequired);
    assert!(!inspected
        .permitted_actions
        .contains(&DesktopSetupOperation::InstallBrowserBridge));
    *BROWSER_RACE_DESTINATION
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = None;
}

#[test]
fn browser_inspection_fails_closed_for_drift_unsafe_manifest_and_partial_files() {
    let temp = TempSetup::new("browser-drift");
    let (mut backend, _) = prepared_browser_backend(&temp);
    backend
        .install_browser_bridge()
        .expect("install exact browser companion");

    let execution_marker = temp.root.join("drifted-browser-host-executed");
    fs::write(
        &temp.paths.installed_browser_host,
        format!(
            "#!/bin/sh\ntouch '{}'\necho 'changed host'\n",
            execution_marker.display()
        ),
    )
    .expect("drift installed host");
    #[cfg(unix)]
    fs::set_permissions(
        &temp.paths.installed_browser_host,
        fs::Permissions::from_mode(0o755),
    )
    .expect("drift host mode");
    let drifted = backend.inspect().expect("inspect host drift");
    let browser = drifted
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::BrowserCompanion)
        .expect("browser component");
    assert_eq!(browser.state, DesktopSetupState::UpgradeRequired);
    assert!(
        !execution_marker.exists(),
        "inspection must not execute a drifted browser host"
    );

    fs::copy(
        &temp.paths.packaged_browser_host,
        &temp.paths.installed_browser_host,
    )
    .expect("restore exact host");
    #[cfg(unix)]
    fs::set_permissions(
        &temp.paths.installed_browser_host,
        fs::Permissions::from_mode(0o755),
    )
    .expect("restore host mode");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&temp.paths.browser_manifest).expect("manifest"))
            .expect("manifest json");
    manifest["allowed_origins"] = serde_json::json!(["chrome-extension://caller-selected/"]);
    let mut bytes = serde_json::to_vec_pretty(&manifest).expect("unsafe manifest");
    bytes.push(b'\n');
    fs::write(&temp.paths.browser_manifest, bytes).expect("write unsafe manifest");
    #[cfg(unix)]
    fs::set_permissions(
        &temp.paths.browser_manifest,
        fs::Permissions::from_mode(0o600),
    )
    .expect("manifest mode");
    let unsafe_snapshot = backend.inspect().expect("inspect unsafe manifest");
    let browser = unsafe_snapshot
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::BrowserCompanion)
        .expect("browser component");
    assert_eq!(browser.state, DesktopSetupState::ManualRecoveryRequired);
    drop(backend);
    drop(temp);

    let temp = TempSetup::new("browser-partial");
    let (mut backend, _) = prepared_browser_backend(&temp);
    fs::create_dir_all(temp.paths.browser_bin_dir()).expect("browser bin");
    #[cfg(unix)]
    fs::set_permissions(
        temp.paths.browser_bin_dir(),
        fs::Permissions::from_mode(0o700),
    )
    .expect("browser bin mode");
    fs::copy(
        &temp.paths.packaged_browser_host,
        &temp.paths.installed_browser_host,
    )
    .expect("partial host");
    #[cfg(unix)]
    fs::set_permissions(
        &temp.paths.installed_browser_host,
        fs::Permissions::from_mode(0o755),
    )
    .expect("partial host mode");
    let partial = backend.inspect().expect("inspect partial browser install");
    let browser = partial
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::BrowserCompanion)
        .expect("browser component");
    assert_eq!(browser.state, DesktopSetupState::ManualRecoveryRequired);
    drop(backend);
    drop(temp);

    let temp = TempSetup::new("browser-container-unsafe");
    let (mut backend, _) = prepared_browser_backend(&temp);
    let google_path = temp
        .paths
        .user_home
        .join("Library")
        .join("Application Support")
        .join("Google");
    fs::write(&google_path, b"not a directory").expect("unsafe Chrome container");
    let unsafe_container = backend.inspect().expect("inspect unsafe Chrome container");
    let browser = unsafe_container
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::BrowserCompanion)
        .expect("browser component");
    assert_eq!(browser.state, DesktopSetupState::ManualRecoveryRequired);
    assert!(!unsafe_container
        .permitted_actions
        .contains(&DesktopSetupOperation::InstallBrowserBridge));
}

#[test]
fn browser_wrong_modes_are_repairable_and_orphaned_clients_are_not_reissued() {
    let temp = TempSetup::new("browser-mode");
    let (mut backend, _) = prepared_browser_backend(&temp);
    backend
        .install_browser_bridge()
        .expect("install exact browser companion");
    #[cfg(unix)]
    fs::set_permissions(
        &temp.paths.installed_browser_host,
        fs::Permissions::from_mode(0o700),
    )
    .expect("break host mode");
    let broken = backend.inspect().expect("inspect wrong browser mode");
    assert_eq!(broken.state, DesktopSetupState::PermissionRepairRequired);
    let repaired = backend
        .repair_permissions()
        .expect("repair browser permissions");
    assert_eq!(repaired.state, DesktopSetupState::VerificationRequired);
    drop(backend);
    drop(temp);

    let temp = TempSetup::new("browser-orphan");
    let (mut backend, _) = prepared_browser_backend(&temp);
    let orphan = temp.paths.clients_dir.join("orphan-browser.json");
    let mut registry =
        LocalClientRegistry::open(temp.paths.local_client_registry()).expect("registry");
    registry
        .issue_to_file(
            LocalClientRole::BrowserBridge,
            BROWSER_CLIENT_LABEL,
            &orphan,
            9,
        )
        .expect("orphan browser client");
    fs::remove_file(orphan).expect("remove orphan credential");
    let orphaned = backend.inspect().expect("inspect orphan browser client");
    let browser = orphaned
        .components
        .iter()
        .find(|component| component.kind == DesktopSetupComponentKind::BrowserCompanion)
        .expect("browser component");
    assert_eq!(browser.state, DesktopSetupState::ManualRecoveryRequired);
    assert!(!orphaned
        .permitted_actions
        .contains(&DesktopSetupOperation::InstallBrowserBridge));
}

#[test]
fn host_routes_the_closed_browser_install_request() {
    let temp = TempSetup::new("browser-host-route");
    let (backend, _) = prepared_browser_backend(&temp);
    let mut host = DesktopSetupHost::new(backend, 1);
    let response = host
        .handle(request(DesktopSetupOperation::InstallBrowserBridge))
        .expect("closed browser install response");
    assert_eq!(
        response.snapshot.state,
        DesktopSetupState::VerificationRequired
    );
    let serialized = serde_json::to_string(&response).expect("response json");
    assert!(!serialized.contains(CHROME_EXTENSION_ORIGIN));
    assert!(!serialized.contains("browser-bridge.json"));
    assert!(!serialized.contains("gwc_"));
}
