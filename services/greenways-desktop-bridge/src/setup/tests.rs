use super::{
    decode_setup_request, encode_setup_response,
    inspect::DesktopSetupEngine,
    service::{
        expected_launch_agent_plist, LaunchAgentController, SetupPaths, DAEMON_SERVICE_LABEL,
        DESKTOP_CLIENT_LABEL,
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
