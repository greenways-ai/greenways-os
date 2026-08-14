use super::{
    browser::{
        expected_native_messaging_manifest, verify_embedded_extension_identity,
        BROWSER_CLIENT_LABEL, BROWSER_HOST_VERSION,
    },
    DesktopSetupError,
};
use greenways_authority::{
    read_credential_file, LocalClient, LocalClientRegistry, LocalClientRole,
};
use greenways_identity::{
    normalize_profile_handle, IdentityError, ProfileIdentityVault, SignedProfileIdentity,
};
use sha2::{Digest, Sha256};
use std::{
    env,
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{self, Command},
};

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};

#[cfg(target_os = "macos")]
use std::{os::unix::ffi::OsStringExt, process::Output};

pub const DAEMON_SERVICE_LABEL: &str = "ai.greenways.greenwaysd";
pub const DESKTOP_CLIENT_LABEL: &str = "Greenways Desktop";
pub const BROWSER_CREDENTIAL_FILE: &str = "browser-bridge.json";
pub const BROWSER_HOST_FILE: &str = "greenways-browser-bridge-host";
pub const BROWSER_MANIFEST_FILE: &str = "ai.greenways.browser_bridge.json";
const MAX_DAEMON_BINARY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_VERSION_OUTPUT_BYTES: usize = 256;

pub(crate) type IdentityVaultOpener = fn(PathBuf) -> Result<ProfileIdentityVault, IdentityError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IdentityRecoverySelection {
    pub package: PathBuf,
    pub recovery_key: PathBuf,
}

pub(crate) type IdentityRecoverySelector =
    fn() -> Result<Option<IdentityRecoverySelection>, DesktopSetupError>;

fn open_system_identity_vault(path: PathBuf) -> Result<ProfileIdentityVault, IdentityError> {
    ProfileIdentityVault::open_system(path)
}

fn select_system_identity_recovery() -> Result<Option<IdentityRecoverySelection>, DesktopSetupError>
{
    #[cfg(target_os = "macos")]
    {
        let package = match choose_identity_recovery_file(
            "Choose the Greenways identity recovery package",
        )? {
            Some(path) => path,
            None => return Ok(None),
        };
        let recovery_key = match choose_identity_recovery_file(
            "Choose the separate Greenways identity recovery key",
        )? {
            Some(path) => path,
            None => return Ok(None),
        };
        Ok(Some(IdentityRecoverySelection {
            package,
            recovery_key,
        }))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(DesktopSetupError::UnsupportedPlatform(
            "Native identity recovery selection is implemented only for packaged macOS Desktop."
                .to_owned(),
        ))
    }
}

#[derive(Debug, Clone)]
pub struct SetupPaths {
    pub user_home: PathBuf,
    pub greenways_home: PathBuf,
    pub state_dir: PathBuf,
    pub run_dir: PathBuf,
    pub clients_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub application_support_dir: PathBuf,
    pub installed_daemon: PathBuf,
    pub packaged_daemon: PathBuf,
    pub packaged_browser_host: PathBuf,
    pub installed_browser_host: PathBuf,
    pub chrome_native_messaging_dir: PathBuf,
    pub browser_manifest: PathBuf,
    pub launch_agent: PathBuf,
    pub stdout_log: PathBuf,
    pub stderr_log: PathBuf,
    pub uid: u32,
}

impl SetupPaths {
    pub fn resolve() -> Result<Self, DesktopSetupError> {
        let user_home = env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
            DesktopSetupError::InspectionFailed(
                "The current macOS user home is unavailable.".to_owned(),
            )
        })?;
        let current_executable = env::current_exe().map_err(|_| {
            DesktopSetupError::InspectionFailed(
                "The packaged Desktop companion location is unavailable.".to_owned(),
            )
        })?;
        let resources = current_executable.parent().ok_or_else(|| {
            DesktopSetupError::InspectionFailed(
                "The packaged Desktop resources directory is invalid.".to_owned(),
            )
        })?;
        let uid = owner_uid(&user_home)?;
        Ok(Self::from_home_and_package(
            user_home,
            resources.join("greenwaysd"),
            uid,
        ))
    }

    pub fn from_home_and_package(user_home: PathBuf, packaged_daemon: PathBuf, uid: u32) -> Self {
        let greenways_home = user_home.join(".greenways");
        let application_support = user_home
            .join("Library")
            .join("Application Support")
            .join("Greenways");
        let chrome_native_messaging_dir = user_home
            .join("Library")
            .join("Application Support")
            .join("Google")
            .join("Chrome")
            .join("NativeMessagingHosts");
        let logs_dir = greenways_home.join("log");
        let package_dir = packaged_daemon
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        Self {
            user_home: user_home.clone(),
            state_dir: greenways_home.join("state"),
            run_dir: greenways_home.join("run"),
            clients_dir: greenways_home.join("clients"),
            stdout_log: logs_dir.join("greenwaysd.stdout.log"),
            stderr_log: logs_dir.join("greenwaysd.stderr.log"),
            logs_dir,
            application_support_dir: application_support.clone(),
            installed_daemon: application_support.join("bin").join("greenwaysd"),
            packaged_browser_host: package_dir.join(BROWSER_HOST_FILE),
            installed_browser_host: greenways_home.join("bin").join(BROWSER_HOST_FILE),
            browser_manifest: chrome_native_messaging_dir.join(BROWSER_MANIFEST_FILE),
            chrome_native_messaging_dir,
            launch_agent: user_home
                .join("Library")
                .join("LaunchAgents")
                .join(format!("{DAEMON_SERVICE_LABEL}.plist")),
            packaged_daemon,
            greenways_home,
            uid,
        }
    }

    pub fn socket_file(&self) -> PathBuf {
        self.run_dir.join("greenwaysd.sock")
    }

    pub fn desktop_credential(&self) -> PathBuf {
        self.clients_dir.join("desktop.json")
    }

    pub fn browser_credential(&self) -> PathBuf {
        self.clients_dir.join(BROWSER_CREDENTIAL_FILE)
    }

    pub fn browser_bin_dir(&self) -> &Path {
        self.installed_browser_host
            .parent()
            .expect("fixed browser host has a parent")
    }

    pub fn local_client_registry(&self) -> PathBuf {
        self.state_dir.join("local-clients.json")
    }

    pub fn identity_metadata(&self) -> PathBuf {
        self.state_dir.join("profile-identity.json")
    }

    pub fn greenways_directories(&self) -> [&Path; 5] {
        [
            self.greenways_home.as_path(),
            self.state_dir.as_path(),
            self.run_dir.as_path(),
            self.clients_dir.as_path(),
            self.logs_dir.as_path(),
        ]
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryIdentity {
    pub version: String,
    pub digest: String,
}

pub trait LaunchAgentController {
    fn stop(&mut self, label: &str, uid: u32) -> Result<(), DesktopSetupError>;

    fn restart(
        &mut self,
        launch_agent: &Path,
        label: &str,
        uid: u32,
    ) -> Result<(), DesktopSetupError>;
}

#[derive(Debug, Default)]
pub struct SystemLaunchAgentController;

impl LaunchAgentController for SystemLaunchAgentController {
    fn stop(&mut self, label: &str, uid: u32) -> Result<(), DesktopSetupError> {
        #[cfg(target_os = "macos")]
        {
            let service = format!("gui/{uid}/{label}");
            let output = fixed_command(
                "/bin/launchctl",
                [OsStr::new("bootout"), OsStr::new(&service)],
            )?;
            if output.status.success() || known_missing_service(&output) {
                Ok(())
            } else {
                Err(DesktopSetupError::InstallationFailed(
                    "The Greenways daemon service could not be stopped.".to_owned(),
                ))
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (label, uid);
            Err(DesktopSetupError::UnsupportedPlatform(
                "Greenways daemon service control is available on macOS only.".to_owned(),
            ))
        }
    }

    fn restart(
        &mut self,
        launch_agent: &Path,
        label: &str,
        uid: u32,
    ) -> Result<(), DesktopSetupError> {
        #[cfg(target_os = "macos")]
        {
            let domain = format!("gui/{uid}");
            let service = format!("{domain}/{label}");
            self.stop(label, uid)?;
            require_success(
                fixed_command(
                    "/bin/launchctl",
                    [
                        OsStr::new("bootstrap"),
                        OsStr::new(&domain),
                        launch_agent.as_os_str(),
                    ],
                )?,
                "The Greenways daemon service could not be loaded.",
            )?;
            require_success(
                fixed_command(
                    "/bin/launchctl",
                    [
                        OsStr::new("kickstart"),
                        OsStr::new("-k"),
                        OsStr::new(&service),
                    ],
                )?,
                "The Greenways daemon service could not be started.",
            )?;
            Ok(())
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (launch_agent, label, uid);
            Err(DesktopSetupError::UnsupportedPlatform(
                "Greenways daemon service installation is available on macOS only.".to_owned(),
            ))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserInstallStage {
    Enrolled,
    HostInstalled,
    Complete,
}

pub(crate) type BrowserInstallHook = fn(BrowserInstallStage) -> Result<(), DesktopSetupError>;

fn continue_browser_install(_: BrowserInstallStage) -> Result<(), DesktopSetupError> {
    Ok(())
}

pub struct DaemonServiceInstaller<C> {
    pub paths: SetupPaths,
    controller: C,
    identity_vault_opener: IdentityVaultOpener,
    identity_recovery_selector: IdentityRecoverySelector,
    browser_install_hook: BrowserInstallHook,
}

impl<C: LaunchAgentController> DaemonServiceInstaller<C> {
    pub fn new(paths: SetupPaths, controller: C) -> Self {
        Self::new_with_identity_vault_opener(paths, controller, open_system_identity_vault)
    }

    pub(crate) fn new_with_identity_vault_opener(
        paths: SetupPaths,
        controller: C,
        identity_vault_opener: IdentityVaultOpener,
    ) -> Self {
        Self {
            paths,
            controller,
            identity_vault_opener,
            identity_recovery_selector: select_system_identity_recovery,
            browser_install_hook: continue_browser_install,
        }
    }

    #[cfg(test)]
    pub(crate) fn set_browser_install_hook(&mut self, hook: BrowserInstallHook) {
        self.browser_install_hook = hook;
    }

    #[cfg(test)]
    pub(crate) fn set_identity_recovery_selector(&mut self, selector: IdentityRecoverySelector) {
        self.identity_recovery_selector = selector;
    }

    pub(crate) fn open_identity_vault(
        &self,
        metadata_path: PathBuf,
    ) -> Result<ProfileIdentityVault, IdentityError> {
        (self.identity_vault_opener)(metadata_path)
    }

    pub fn install(&mut self) -> Result<(), DesktopSetupError> {
        let packaged = binary_identity(&self.paths.packaged_daemon, None)?;
        self.ensure_greenways_directories(true)?;
        ensure_owned_directory(
            &self.paths.application_support_dir,
            self.paths.uid,
            0o700,
            true,
        )?;
        let bin_dir = self.paths.installed_daemon.parent().ok_or_else(|| {
            DesktopSetupError::UnsafeInstallation(
                "The fixed Greenways daemon installation directory is invalid.".to_owned(),
            )
        })?;
        ensure_owned_directory(bin_dir, self.paths.uid, 0o700, true)?;
        let launch_agents = self.paths.launch_agent.parent().ok_or_else(|| {
            DesktopSetupError::UnsafeInstallation(
                "The fixed LaunchAgent directory is invalid.".to_owned(),
            )
        })?;
        ensure_container_directory(launch_agents, self.paths.uid)?;

        atomic_copy(
            &self.paths.packaged_daemon,
            &self.paths.installed_daemon,
            self.paths.uid,
            0o755,
        )?;
        let installed = binary_identity(&self.paths.installed_daemon, Some(self.paths.uid))?;
        if installed != packaged {
            return Err(DesktopSetupError::InstallationFailed(
                "The installed Greenways daemon did not match the packaged daemon.".to_owned(),
            ));
        }

        let plist = expected_launch_agent_plist(&self.paths)?;
        atomic_write(&self.paths.launch_agent, &plist, self.paths.uid, 0o600)?;
        self.controller.restart(
            &self.paths.launch_agent,
            DAEMON_SERVICE_LABEL,
            self.paths.uid,
        )?;
        Ok(())
    }

    pub fn repair_permissions(&mut self) -> Result<(), DesktopSetupError> {
        for directory in self.paths.greenways_directories() {
            repair_existing_owned_directory(directory, self.paths.uid, 0o700)?;
        }
        repair_existing_owned_directory(
            &self.paths.application_support_dir,
            self.paths.uid,
            0o700,
        )?;
        let bin_dir = self.paths.installed_daemon.parent().ok_or_else(|| {
            DesktopSetupError::UnsafeInstallation(
                "The fixed Greenways daemon installation directory is invalid.".to_owned(),
            )
        })?;
        repair_existing_owned_directory(bin_dir, self.paths.uid, 0o700)?;
        if self.paths.installed_daemon.exists() {
            repair_owned_file(&self.paths.installed_daemon, self.paths.uid, 0o755)?;
        }
        if self.paths.launch_agent.exists() {
            repair_owned_file(&self.paths.launch_agent, self.paths.uid, 0o600)?;
        }
        repair_existing_owned_directory(self.paths.browser_bin_dir(), self.paths.uid, 0o700)?;
        if self.paths.installed_browser_host.exists() {
            repair_owned_file(&self.paths.installed_browser_host, self.paths.uid, 0o755)?;
        }
        for private_file in [
            self.paths.local_client_registry(),
            self.paths.desktop_credential(),
            self.paths.browser_credential(),
            self.paths.identity_metadata(),
            self.paths.browser_manifest.clone(),
        ] {
            if fs::symlink_metadata(&private_file).is_ok() {
                repair_owned_file(&private_file, self.paths.uid, 0o600)?;
            }
        }
        Ok(())
    }

    pub fn issue_desktop_client(
        &mut self,
        observed_at_unix_ms: u64,
    ) -> Result<LocalClient, DesktopSetupError> {
        self.ensure_greenways_directories(true)?;
        require_missing_fixed_file(
            &self.paths.desktop_credential(),
            self.paths.uid,
            "The fixed Desktop credential already exists.",
        )?;
        match inspect_owned_file(&self.paths.local_client_registry(), self.paths.uid, 0o600)? {
            OwnedPathState::Missing | OwnedPathState::Ready => {}
            OwnedPathState::WrongMode => {
                return Err(DesktopSetupError::InstallationFailed(
                    "The local-client registry permissions require repair.".to_owned(),
                ));
            }
            OwnedPathState::Unsafe => {
                return Err(DesktopSetupError::UnsafeInstallation(
                    "The fixed local-client registry is unsafe.".to_owned(),
                ));
            }
        }

        self.controller.stop(DAEMON_SERVICE_LABEL, self.paths.uid)?;
        let issue_result = self.issue_desktop_client_while_stopped(observed_at_unix_ms);
        let restart_result = self.controller.restart(
            &self.paths.launch_agent,
            DAEMON_SERVICE_LABEL,
            self.paths.uid,
        );
        match (issue_result, restart_result) {
            (Ok(client), Ok(())) => Ok(client),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Err(_), Err(_)) => Err(DesktopSetupError::InstallationFailed(
                "Desktop access could not be established and the daemon service could not be restored."
                    .to_owned(),
            )),
        }
    }

    fn issue_desktop_client_while_stopped(
        &self,
        observed_at_unix_ms: u64,
    ) -> Result<LocalClient, DesktopSetupError> {
        let registry_path = self.paths.local_client_registry();
        let mut registry = LocalClientRegistry::open(&registry_path).map_err(|_| {
            DesktopSetupError::UnsafeInstallation(
                "The fixed local-client registry could not be opened safely.".to_owned(),
            )
        })?;
        if registry.clients().iter().any(|client| {
            client.role == LocalClientRole::Desktop && client.revoked_at_unix_ms.is_none()
        }) {
            return Err(DesktopSetupError::UnsafeInstallation(
                "An active Desktop client already exists without this installation's fixed credential."
                    .to_owned(),
            ));
        }
        let client = registry
            .issue_to_file(
                LocalClientRole::Desktop,
                DESKTOP_CLIENT_LABEL,
                self.paths.desktop_credential(),
                observed_at_unix_ms,
            )
            .map_err(|_| {
                DesktopSetupError::InstallationFailed(
                    "The fixed Desktop client could not be enrolled.".to_owned(),
                )
            })?;
        let credential = read_credential_file(self.paths.desktop_credential()).map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The enrolled Desktop credential could not be verified.".to_owned(),
            )
        })?;
        let verified = registry.verify_credential(&credential).map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The enrolled Desktop credential was rejected by the local registry.".to_owned(),
            )
        })?;
        if verified != client
            || verified.role != LocalClientRole::Desktop
            || verified.label != DESKTOP_CLIENT_LABEL
        {
            return Err(DesktopSetupError::InstallationFailed(
                "The enrolled Desktop client identity did not match the fixed setup contract."
                    .to_owned(),
            ));
        }
        Ok(client)
    }

    pub fn install_browser_bridge(
        &mut self,
        observed_at_unix_ms: u64,
    ) -> Result<LocalClient, DesktopSetupError> {
        verify_embedded_extension_identity()?;
        let packaged = browser_host_identity(&self.paths.packaged_browser_host, None)?;
        self.ensure_greenways_directories(true)?;
        ensure_owned_directory(self.paths.browser_bin_dir(), self.paths.uid, 0o700, true)?;
        ensure_container_directory_chain(
            &self.paths.user_home,
            &self.paths.chrome_native_messaging_dir,
            self.paths.uid,
        )?;
        require_missing_browser_file(
            &self.paths.browser_credential(),
            self.paths.uid,
            0o600,
            "The fixed browser credential already exists.",
        )?;
        require_missing_browser_file(
            &self.paths.installed_browser_host,
            self.paths.uid,
            0o755,
            "The fixed browser host already exists.",
        )?;
        require_missing_browser_file(
            &self.paths.browser_manifest,
            self.paths.uid,
            0o600,
            "The fixed Chrome Native Messaging manifest already exists.",
        )?;
        match inspect_owned_file(&self.paths.local_client_registry(), self.paths.uid, 0o600)? {
            OwnedPathState::Missing | OwnedPathState::Ready => {}
            OwnedPathState::WrongMode => {
                return Err(DesktopSetupError::InstallationFailed(
                    "The local-client registry permissions require repair.".to_owned(),
                ));
            }
            OwnedPathState::Unsafe => {
                return Err(DesktopSetupError::UnsafeInstallation(
                    "The fixed local-client registry is unsafe.".to_owned(),
                ));
            }
        }
        let registry =
            LocalClientRegistry::open(self.paths.local_client_registry()).map_err(|_| {
                DesktopSetupError::UnsafeInstallation(
                    "The fixed local-client registry could not be opened safely.".to_owned(),
                )
            })?;
        if registry.clients().iter().any(|client| {
            client.role == LocalClientRole::BrowserBridge && client.revoked_at_unix_ms.is_none()
        }) {
            return Err(DesktopSetupError::UnsafeInstallation(
                "An active browser bridge already exists without this installation's fixed credential."
                    .to_owned(),
            ));
        }
        drop(registry);
        let expected_manifest =
            expected_native_messaging_manifest(&self.paths.installed_browser_host)?;

        self.controller.stop(DAEMON_SERVICE_LABEL, self.paths.uid)?;
        let install_result = self.install_browser_bridge_while_stopped(
            observed_at_unix_ms,
            &packaged,
            &expected_manifest,
        );
        let restart_result = self.controller.restart(
            &self.paths.launch_agent,
            DAEMON_SERVICE_LABEL,
            self.paths.uid,
        );
        match (install_result, restart_result) {
            (Ok(client), Ok(())) => Ok(client),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Err(_), Err(_)) => Err(DesktopSetupError::InstallationFailed(
                "The Chrome companion could not be installed and the daemon service could not be restored."
                    .to_owned(),
            )),
        }
    }

    fn install_browser_bridge_while_stopped(
        &self,
        observed_at_unix_ms: u64,
        packaged: &BinaryIdentity,
        expected_manifest: &[u8],
    ) -> Result<LocalClient, DesktopSetupError> {
        let registry_path = self.paths.local_client_registry();
        let mut registry = LocalClientRegistry::open(&registry_path).map_err(|_| {
            DesktopSetupError::UnsafeInstallation(
                "The fixed local-client registry could not be opened safely.".to_owned(),
            )
        })?;
        if registry.clients().iter().any(|client| {
            client.role == LocalClientRole::BrowserBridge && client.revoked_at_unix_ms.is_none()
        }) {
            return Err(DesktopSetupError::UnsafeInstallation(
                "An active browser bridge already exists without this installation's fixed credential."
                    .to_owned(),
            ));
        }
        let client = registry
            .issue_to_file(
                LocalClientRole::BrowserBridge,
                BROWSER_CLIENT_LABEL,
                self.paths.browser_credential(),
                observed_at_unix_ms,
            )
            .map_err(|_| {
                DesktopSetupError::InstallationFailed(
                    "The fixed browser bridge client could not be enrolled.".to_owned(),
                )
            })?;

        let install_result = (|| {
            self.verify_browser_credential(&registry, &client)?;
            (self.browser_install_hook)(BrowserInstallStage::Enrolled)?;
            atomic_copy_new(
                &self.paths.packaged_browser_host,
                &self.paths.installed_browser_host,
                self.paths.uid,
                0o755,
            )?;
            let installed_digest =
                browser_host_digest(&self.paths.installed_browser_host, Some(self.paths.uid))?;
            if installed_digest != packaged.digest {
                return Err(DesktopSetupError::InstallationFailed(
                    "The installed browser host did not match the packaged host.".to_owned(),
                ));
            }
            let installed =
                browser_host_identity(&self.paths.installed_browser_host, Some(self.paths.uid))?;
            if &installed != packaged {
                return Err(DesktopSetupError::InstallationFailed(
                    "The installed browser host did not match the packaged host.".to_owned(),
                ));
            }
            (self.browser_install_hook)(BrowserInstallStage::HostInstalled)?;
            atomic_write_new(
                &self.paths.browser_manifest,
                expected_manifest,
                self.paths.uid,
                0o600,
            )?;
            self.verify_browser_manifest(expected_manifest)?;
            (self.browser_install_hook)(BrowserInstallStage::Complete)?;
            self.verify_browser_credential(&registry, &client)?;
            Ok(())
        })();

        if let Err(error) = install_result {
            if self
                .rollback_browser_install(&client, observed_at_unix_ms, packaged, expected_manifest)
                .is_err()
            {
                return Err(DesktopSetupError::UnsafeInstallation(
                    "The partial Chrome companion installation requires manual recovery."
                        .to_owned(),
                ));
            }
            return Err(error);
        }
        Ok(client)
    }

    fn verify_browser_credential(
        &self,
        registry: &LocalClientRegistry,
        expected: &LocalClient,
    ) -> Result<(), DesktopSetupError> {
        let credential = read_credential_file(self.paths.browser_credential()).map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The enrolled browser credential could not be verified.".to_owned(),
            )
        })?;
        let verified = registry.verify_credential(&credential).map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The enrolled browser credential was rejected by the local registry.".to_owned(),
            )
        })?;
        if verified != *expected
            || verified.role != LocalClientRole::BrowserBridge
            || verified.label != BROWSER_CLIENT_LABEL
        {
            return Err(DesktopSetupError::InstallationFailed(
                "The enrolled browser client did not match the fixed setup contract.".to_owned(),
            ));
        }
        Ok(())
    }

    fn verify_browser_manifest(&self, expected: &[u8]) -> Result<(), DesktopSetupError> {
        match inspect_owned_file(&self.paths.browser_manifest, self.paths.uid, 0o600)? {
            OwnedPathState::Ready => {}
            _ => {
                return Err(DesktopSetupError::InstallationFailed(
                    "The fixed Chrome Native Messaging manifest was not installed safely."
                        .to_owned(),
                ));
            }
        }
        let actual = fs::read(&self.paths.browser_manifest).map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The fixed Chrome Native Messaging manifest could not be verified.".to_owned(),
            )
        })?;
        if actual != expected {
            return Err(DesktopSetupError::InstallationFailed(
                "The fixed Chrome Native Messaging manifest did not match the reviewed contract."
                    .to_owned(),
            ));
        }
        Ok(())
    }

    fn rollback_browser_install(
        &self,
        client: &LocalClient,
        observed_at_unix_ms: u64,
        packaged: &BinaryIdentity,
        expected_manifest: &[u8],
    ) -> Result<(), DesktopSetupError> {
        remove_exact_file(
            &self.paths.browser_manifest,
            self.paths.uid,
            0o600,
            |path| {
                fs::read(path)
                    .map(|bytes| bytes == expected_manifest)
                    .unwrap_or(false)
            },
        )?;
        remove_exact_file(
            &self.paths.installed_browser_host,
            self.paths.uid,
            0o755,
            |path| {
                browser_host_digest(path, Some(self.paths.uid))
                    .map(|digest| digest == packaged.digest)
                    .unwrap_or(false)
            },
        )?;
        let registry_path = self.paths.local_client_registry();
        let mut registry = LocalClientRegistry::open(&registry_path).map_err(|_| {
            DesktopSetupError::UnsafeInstallation(
                "The browser client rollback registry is unavailable.".to_owned(),
            )
        })?;
        let current = registry.get(&client.id).map_err(|_| {
            DesktopSetupError::UnsafeInstallation(
                "The browser client rollback record is unavailable.".to_owned(),
            )
        })?;
        if current.revoked_at_unix_ms.is_none() {
            registry
                .revoke(&client.id, observed_at_unix_ms)
                .map_err(|_| {
                    DesktopSetupError::UnsafeInstallation(
                        "The partial browser client could not be revoked.".to_owned(),
                    )
                })?;
        }
        let credential_path = self.paths.browser_credential();
        let credential = read_credential_file(&credential_path).map_err(|_| {
            DesktopSetupError::UnsafeInstallation(
                "The partial browser credential could not be verified for cleanup.".to_owned(),
            )
        })?;
        if credential.client_id != client.id || credential.role != LocalClientRole::BrowserBridge {
            return Err(DesktopSetupError::UnsafeInstallation(
                "The partial browser credential did not match the rollback client.".to_owned(),
            ));
        }
        fs::remove_file(&credential_path).map_err(|_| {
            DesktopSetupError::UnsafeInstallation(
                "The partial browser credential could not be removed.".to_owned(),
            )
        })?;
        Ok(())
    }

    pub fn create_identity(
        &mut self,
        handle: &str,
        observed_at_unix_ms: u64,
    ) -> Result<SignedProfileIdentity, DesktopSetupError> {
        let normalized = normalize_profile_handle(handle).map_err(|_| {
            DesktopSetupError::ProtocolMismatch(
                "The Desktop identity handle is invalid.".to_owned(),
            )
        })?;
        if normalized != handle {
            return Err(DesktopSetupError::ProtocolMismatch(
                "The Desktop identity handle must already be normalized.".to_owned(),
            ));
        }
        self.ensure_greenways_directories(true)?;
        match inspect_owned_file(&self.paths.identity_metadata(), self.paths.uid, 0o600)? {
            OwnedPathState::Missing => {}
            OwnedPathState::Ready => {
                return Err(DesktopSetupError::OperationUnavailable(
                    "A public Greenways identity already exists.".to_owned(),
                ));
            }
            OwnedPathState::WrongMode => {
                return Err(DesktopSetupError::InstallationFailed(
                    "The public identity metadata permissions require repair.".to_owned(),
                ));
            }
            OwnedPathState::Unsafe => {
                return Err(DesktopSetupError::UnsafeInstallation(
                    "The fixed public identity metadata path is unsafe.".to_owned(),
                ));
            }
        }

        self.controller.stop(DAEMON_SERVICE_LABEL, self.paths.uid)?;
        let create_result = self.create_identity_while_stopped(handle, observed_at_unix_ms);
        let restart_result = self.controller.restart(
            &self.paths.launch_agent,
            DAEMON_SERVICE_LABEL,
            self.paths.uid,
        );
        match (create_result, restart_result) {
            (Ok(identity), Ok(())) => Ok(identity),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Err(_), Err(_)) => Err(DesktopSetupError::InstallationFailed(
                "The public identity could not be created and the daemon service could not be restored."
                    .to_owned(),
            )),
        }
    }

    fn create_identity_while_stopped(
        &self,
        handle: &str,
        observed_at_unix_ms: u64,
    ) -> Result<SignedProfileIdentity, DesktopSetupError> {
        let mut vault = self
            .open_identity_vault(self.paths.identity_metadata())
            .map_err(|error| match error {
                IdentityError::Conflict(_) => DesktopSetupError::OperationUnavailable(
                    "A public Greenways identity already exists.".to_owned(),
                ),
                _ => DesktopSetupError::InstallationFailed(
                    "The fixed public identity vault could not be opened.".to_owned(),
                ),
            })?;
        let identity = vault
            .create(handle, observed_at_unix_ms)
            .map_err(|error| match error {
                IdentityError::Conflict(_) => DesktopSetupError::OperationUnavailable(
                    "A public Greenways identity already exists.".to_owned(),
                ),
                IdentityError::Invalid(_) => DesktopSetupError::ProtocolMismatch(
                    "The Desktop identity handle is invalid.".to_owned(),
                ),
                IdentityError::KeyStoreUnavailable => DesktopSetupError::InstallationFailed(
                    "The operating-system identity key store is unavailable.".to_owned(),
                ),
                _ => DesktopSetupError::InstallationFailed(
                    "The public Greenways identity could not be created.".to_owned(),
                ),
            })?;
        if identity.subject.handle != handle {
            return Err(DesktopSetupError::InstallationFailed(
                "The public identity handle did not match the reviewed setup request.".to_owned(),
            ));
        }
        vault.verify_private_key_binding().map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The public identity key could not be verified.".to_owned(),
            )
        })?;
        Ok(identity)
    }

    pub fn recover_identity(&mut self) -> Result<Option<SignedProfileIdentity>, DesktopSetupError> {
        self.ensure_greenways_directories(true)?;
        match inspect_owned_file(&self.paths.identity_metadata(), self.paths.uid, 0o600)? {
            OwnedPathState::Missing => {}
            OwnedPathState::Ready => {
                return Err(DesktopSetupError::OperationUnavailable(
                    "A public Greenways identity already exists.".to_owned(),
                ));
            }
            OwnedPathState::WrongMode => {
                return Err(DesktopSetupError::InstallationFailed(
                    "The public identity metadata permissions require repair.".to_owned(),
                ));
            }
            OwnedPathState::Unsafe => {
                return Err(DesktopSetupError::UnsafeInstallation(
                    "The fixed public identity metadata path is unsafe.".to_owned(),
                ));
            }
        }

        let Some(selection) = (self.identity_recovery_selector)()? else {
            return Ok(None);
        };
        for path in [&selection.package, &selection.recovery_key] {
            match inspect_owned_file(path, self.paths.uid, 0o600)? {
                OwnedPathState::Ready => {}
                OwnedPathState::Missing => {
                    return Err(DesktopSetupError::InstallationFailed(
                        "A selected identity recovery file is no longer available.".to_owned(),
                    ));
                }
                OwnedPathState::WrongMode => {
                    return Err(DesktopSetupError::InstallationFailed(
                        "A selected identity recovery file is not private.".to_owned(),
                    ));
                }
                OwnedPathState::Unsafe => {
                    return Err(DesktopSetupError::UnsafeInstallation(
                        "A selected identity recovery file has unsafe ownership or type."
                            .to_owned(),
                    ));
                }
            }
        }
        let prepared = ProfileIdentityVault::prepare_recovery_from_files(
            &selection.package,
            &selection.recovery_key,
        )
        .map_err(map_identity_recovery_preparation_error)?;
        let expected_identity = prepared.public_identity().clone();
        let mut vault = self
            .open_identity_vault(self.paths.identity_metadata())
            .map_err(map_identity_recovery_open_error)?;

        self.controller.stop(DAEMON_SERVICE_LABEL, self.paths.uid)?;
        let recover_result = vault
            .recover_prepared(prepared)
            .map_err(map_identity_recovery_commit_error)
            .and_then(|identity| {
                if identity != expected_identity {
                    return Err(DesktopSetupError::InstallationFailed(
                        "The recovered public identity did not match the verified package."
                            .to_owned(),
                    ));
                }
                vault.verify_private_key_binding().map_err(|_| {
                    DesktopSetupError::InstallationFailed(
                        "The recovered public identity key could not be verified.".to_owned(),
                    )
                })?;
                Ok(identity)
            });
        let restart_result = self.controller.restart(
            &self.paths.launch_agent,
            DAEMON_SERVICE_LABEL,
            self.paths.uid,
        );
        match (recover_result, restart_result) {
            (Ok(identity), Ok(())) => Ok(Some(identity)),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Err(_), Err(_)) => Err(DesktopSetupError::InstallationFailed(
                "The identity could not be recovered and the daemon service could not be restored."
                    .to_owned(),
            )),
        }
    }

    fn ensure_greenways_directories(&self, create_missing: bool) -> Result<(), DesktopSetupError> {
        for directory in self.paths.greenways_directories() {
            ensure_owned_directory(directory, self.paths.uid, 0o700, create_missing)?;
        }
        Ok(())
    }
}

fn map_identity_recovery_preparation_error(error: IdentityError) -> DesktopSetupError {
    match error {
        IdentityError::KeyStoreUnavailable => DesktopSetupError::InstallationFailed(
            "The operating-system identity key store is unavailable.".to_owned(),
        ),
        IdentityError::Invalid(_)
        | IdentityError::Encoding(_)
        | IdentityError::CryptographyUnavailable => DesktopSetupError::InstallationFailed(
            "The selected identity recovery material could not be verified.".to_owned(),
        ),
        IdentityError::Conflict(_) => DesktopSetupError::UnsafeInstallation(
            "The selected identity recovery files conflict with the fixed recovery operation."
                .to_owned(),
        ),
        IdentityError::Io(_) => DesktopSetupError::InstallationFailed(
            "The selected identity recovery files could not be read.".to_owned(),
        ),
    }
}

fn map_identity_recovery_open_error(error: IdentityError) -> DesktopSetupError {
    match error {
        IdentityError::Conflict(_) => DesktopSetupError::OperationUnavailable(
            "A public Greenways identity already exists.".to_owned(),
        ),
        IdentityError::KeyStoreUnavailable => DesktopSetupError::InstallationFailed(
            "The operating-system identity key store is unavailable.".to_owned(),
        ),
        _ => DesktopSetupError::InstallationFailed(
            "The fixed public identity vault could not be opened.".to_owned(),
        ),
    }
}

fn map_identity_recovery_commit_error(error: IdentityError) -> DesktopSetupError {
    match error {
        IdentityError::Conflict(_) => DesktopSetupError::OperationUnavailable(
            "A public Greenways identity appeared before recovery could commit.".to_owned(),
        ),
        IdentityError::KeyStoreUnavailable => DesktopSetupError::InstallationFailed(
            "The operating-system identity key store is unavailable.".to_owned(),
        ),
        IdentityError::Invalid(_) | IdentityError::Encoding(_) => {
            DesktopSetupError::InstallationFailed(
                "The verified identity recovery material could not be committed.".to_owned(),
            )
        }
        IdentityError::CryptographyUnavailable | IdentityError::Io(_) => {
            DesktopSetupError::InstallationFailed(
                "The public Greenways identity could not be recovered.".to_owned(),
            )
        }
    }
}

fn require_missing_fixed_file(
    path: &Path,
    uid: u32,
    message: &str,
) -> Result<(), DesktopSetupError> {
    match inspect_owned_file(path, uid, 0o600)? {
        OwnedPathState::Missing => Ok(()),
        OwnedPathState::Ready => Err(DesktopSetupError::OperationUnavailable(message.to_owned())),
        OwnedPathState::WrongMode => Err(DesktopSetupError::InstallationFailed(
            "The fixed Desktop credential permissions require repair.".to_owned(),
        )),
        OwnedPathState::Unsafe => Err(DesktopSetupError::UnsafeInstallation(
            "The fixed Desktop credential path is unsafe.".to_owned(),
        )),
    }
}

fn require_missing_browser_file(
    path: &Path,
    uid: u32,
    mode: u32,
    message: &str,
) -> Result<(), DesktopSetupError> {
    match inspect_owned_file(path, uid, mode)? {
        OwnedPathState::Missing => Ok(()),
        OwnedPathState::Ready => Err(DesktopSetupError::OperationUnavailable(message.to_owned())),
        OwnedPathState::WrongMode => Err(DesktopSetupError::InstallationFailed(
            "A fixed browser companion file requires permission repair.".to_owned(),
        )),
        OwnedPathState::Unsafe => Err(DesktopSetupError::UnsafeInstallation(
            "A fixed browser companion file has unexpected ownership or type.".to_owned(),
        )),
    }
}

fn remove_exact_file<F>(
    path: &Path,
    uid: u32,
    mode: u32,
    matches_expected: F,
) -> Result<(), DesktopSetupError>
where
    F: FnOnce(&Path) -> bool,
{
    match inspect_owned_file(path, uid, mode)? {
        OwnedPathState::Missing => Ok(()),
        OwnedPathState::Ready if matches_expected(path) => fs::remove_file(path).map_err(|_| {
            DesktopSetupError::UnsafeInstallation(
                "A partial browser companion file could not be removed.".to_owned(),
            )
        }),
        _ => Err(DesktopSetupError::UnsafeInstallation(
            "A partial browser companion file changed during rollback.".to_owned(),
        )),
    }
}

pub fn expected_launch_agent_plist(paths: &SetupPaths) -> Result<Vec<u8>, DesktopSetupError> {
    let program = xml_escape(&path_text(&paths.installed_daemon)?);
    let home = xml_escape(&path_text(&paths.greenways_home)?);
    let stdout = xml_escape(&path_text(&paths.stdout_log)?);
    let stderr = xml_escape(&path_text(&paths.stderr_log)?);
    let value = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{DAEMON_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{program}</string>
    <string>--home</string>
    <string>{home}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>{stdout}</string>
  <key>StandardErrorPath</key>
  <string>{stderr}</string>
</dict>
</plist>
"#
    );
    if value.contains("credential")
        || value.contains("token")
        || value.contains("session")
        || value.contains("private-key")
    {
        return Err(DesktopSetupError::ProtocolMismatch(
            "The fixed LaunchAgent attempted to include confidential authority.".to_owned(),
        ));
    }
    Ok(value.into_bytes())
}

pub fn binary_identity(
    path: &Path,
    expected_uid: Option<u32>,
) -> Result<BinaryIdentity, DesktopSetupError> {
    executable_identity(
        path,
        expected_uid,
        &format!("greenwaysd {}", env!("CARGO_PKG_VERSION")),
        "Greenways daemon",
    )
}

pub fn browser_host_digest(
    path: &Path,
    expected_uid: Option<u32>,
) -> Result<String, DesktopSetupError> {
    executable_digest(path, expected_uid, "Greenways browser host")
}

pub fn browser_host_identity(
    path: &Path,
    expected_uid: Option<u32>,
) -> Result<BinaryIdentity, DesktopSetupError> {
    let mut identity = executable_identity(
        path,
        expected_uid,
        &format!("greenways-browser-bridge-host {BROWSER_HOST_VERSION}"),
        "Greenways browser host",
    )?;
    identity.version = BROWSER_HOST_VERSION.to_owned();
    Ok(identity)
}

fn executable_identity(
    path: &Path,
    expected_uid: Option<u32>,
    expected_version: &str,
    component: &str,
) -> Result<BinaryIdentity, DesktopSetupError> {
    let digest = executable_digest(path, expected_uid, component)?;
    let output = Command::new(path).arg("--version").output().map_err(|_| {
        DesktopSetupError::UnsafeInstallation(format!(
            "The {component} binary identity could not be read."
        ))
    })?;
    if !output.status.success()
        || output.stdout.len() > MAX_VERSION_OUTPUT_BYTES
        || !output.stderr.is_empty()
    {
        return Err(DesktopSetupError::UnsafeInstallation(format!(
            "The {component} binary returned an invalid identity."
        )));
    }
    let version = String::from_utf8(output.stdout)
        .map_err(|_| {
            DesktopSetupError::UnsafeInstallation(format!("The {component} version is not text."))
        })?
        .trim()
        .to_owned();
    if version != expected_version {
        return Err(DesktopSetupError::UnsafeInstallation(format!(
            "The {component} version does not match this Desktop build."
        )));
    }
    Ok(BinaryIdentity { version, digest })
}

fn executable_digest(
    path: &Path,
    expected_uid: Option<u32>,
    component: &str,
) -> Result<String, DesktopSetupError> {
    let metadata = safe_file_metadata(path, expected_uid, component)?;
    if metadata.len() == 0 || metadata.len() > MAX_DAEMON_BINARY_BYTES {
        return Err(DesktopSetupError::UnsafeInstallation(format!(
            "The {component} binary size is invalid."
        )));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(DesktopSetupError::UnsafeInstallation(format!(
            "The {component} binary is not executable."
        )));
    }
    digest_file(path, component)
}

pub fn inspect_owned_directory(
    path: &Path,
    uid: u32,
    mode: u32,
) -> Result<OwnedPathState, DesktopSetupError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OwnedPathState::Missing)
        }
        Err(_) => {
            return Err(DesktopSetupError::InspectionFailed(
                "A fixed Greenways directory could not be inspected.".to_owned(),
            ))
        }
    };
    #[cfg(unix)]
    {
        if metadata.file_type().is_symlink() || !metadata.is_dir() || metadata.uid() != uid {
            return Ok(OwnedPathState::Unsafe);
        }
        if metadata.permissions().mode() & 0o777 != mode {
            return Ok(OwnedPathState::WrongMode);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (uid, mode);
        if !metadata.is_dir() {
            return Ok(OwnedPathState::Unsafe);
        }
    }
    Ok(OwnedPathState::Ready)
}

pub fn inspect_owned_file(
    path: &Path,
    uid: u32,
    mode: u32,
) -> Result<OwnedPathState, DesktopSetupError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(OwnedPathState::Missing)
        }
        Err(_) => {
            return Err(DesktopSetupError::InspectionFailed(
                "A fixed Greenways file could not be inspected.".to_owned(),
            ))
        }
    };
    #[cfg(unix)]
    {
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.uid() != uid {
            return Ok(OwnedPathState::Unsafe);
        }
        if metadata.permissions().mode() & 0o777 != mode {
            return Ok(OwnedPathState::WrongMode);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (uid, mode);
        if !metadata.is_file() {
            return Ok(OwnedPathState::Unsafe);
        }
    }
    Ok(OwnedPathState::Ready)
}

pub fn socket_is_safe(path: &Path, uid: u32) -> Result<Option<bool>, DesktopSetupError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(DesktopSetupError::InspectionFailed(
                "The fixed Greenways daemon socket could not be inspected.".to_owned(),
            ))
        }
    };
    #[cfg(unix)]
    {
        Ok(Some(
            metadata.file_type().is_socket() && metadata.uid() == uid,
        ))
    }
    #[cfg(not(unix))]
    {
        let _ = uid;
        Ok(Some(false))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnedPathState {
    Missing,
    Ready,
    WrongMode,
    Unsafe,
}

fn owner_uid(path: &Path) -> Result<u32, DesktopSetupError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        DesktopSetupError::InspectionFailed(
            "The current user home could not be inspected.".to_owned(),
        )
    })?;
    #[cfg(unix)]
    {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(DesktopSetupError::UnsafeInstallation(
                "The current user home is not a safe directory.".to_owned(),
            ));
        }
        Ok(metadata.uid())
    }
    #[cfg(not(unix))]
    {
        if !metadata.is_dir() {
            return Err(DesktopSetupError::UnsafeInstallation(
                "The current user home is not a safe directory.".to_owned(),
            ));
        }
        Ok(0)
    }
}

fn safe_file_metadata(
    path: &Path,
    expected_uid: Option<u32>,
    component: &str,
) -> Result<fs::Metadata, DesktopSetupError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        DesktopSetupError::UnsafeInstallation(format!(
            "The fixed {component} binary is unavailable."
        ))
    })?;
    #[cfg(unix)]
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || expected_uid.is_some_and(|uid| metadata.uid() != uid)
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(DesktopSetupError::UnsafeInstallation(format!(
            "The fixed {component} binary is not safe to execute."
        )));
    }
    #[cfg(not(unix))]
    if !metadata.is_file() {
        return Err(DesktopSetupError::UnsafeInstallation(format!(
            "The fixed {component} binary is not safe to execute."
        )));
    }
    Ok(metadata)
}

fn digest_file(path: &Path, component: &str) -> Result<String, DesktopSetupError> {
    let mut file = File::open(path).map_err(|_| {
        DesktopSetupError::InspectionFailed(format!("The {component} binary could not be read."))
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| {
            DesktopSetupError::InspectionFailed(format!(
                "The {component} binary could not be read."
            ))
        })?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
}

fn ensure_owned_directory(
    path: &Path,
    uid: u32,
    mode: u32,
    create_missing: bool,
) -> Result<(), DesktopSetupError> {
    match inspect_owned_directory(path, uid, mode)? {
        OwnedPathState::Ready => Ok(()),
        OwnedPathState::WrongMode => set_mode(path, mode),
        OwnedPathState::Missing if create_missing => {
            if let Some(parent) = path.parent() {
                if !parent.exists() {
                    fs::create_dir_all(parent).map_err(|_| {
                        DesktopSetupError::InstallationFailed(
                            "A fixed Greenways parent directory could not be created.".to_owned(),
                        )
                    })?;
                }
            }
            fs::create_dir(path).map_err(|_| {
                DesktopSetupError::InstallationFailed(
                    "A fixed Greenways directory could not be created.".to_owned(),
                )
            })?;
            set_mode(path, mode)
        }
        OwnedPathState::Missing => Err(DesktopSetupError::InstallationFailed(
            "A fixed Greenways directory is missing.".to_owned(),
        )),
        OwnedPathState::Unsafe => Err(DesktopSetupError::UnsafeInstallation(
            "A fixed Greenways directory has unexpected ownership or type.".to_owned(),
        )),
    }
}

fn ensure_container_directory(path: &Path, uid: u32) -> Result<(), DesktopSetupError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(|_| {
                DesktopSetupError::InstallationFailed(
                    "The fixed LaunchAgent directory could not be created.".to_owned(),
                )
            })?;
            return Ok(());
        }
        Err(_) => {
            return Err(DesktopSetupError::InstallationFailed(
                "The fixed LaunchAgent directory could not be inspected.".to_owned(),
            ))
        }
    };
    #[cfg(unix)]
    if metadata.file_type().is_symlink() || !metadata.is_dir() || metadata.uid() != uid {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The fixed LaunchAgent directory has unexpected ownership or type.".to_owned(),
        ));
    }
    #[cfg(not(unix))]
    if !metadata.is_dir() {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The fixed LaunchAgent directory has unexpected type.".to_owned(),
        ));
    }
    Ok(())
}

pub fn inspect_container_directory_chain(
    root: &Path,
    destination: &Path,
    uid: u32,
) -> Result<OwnedPathState, DesktopSetupError> {
    let relative = destination.strip_prefix(root).map_err(|_| {
        DesktopSetupError::UnsafeInstallation(
            "The fixed Chrome Native Messaging directory is outside the user home.".to_owned(),
        )
    })?;
    let root_metadata = fs::symlink_metadata(root).map_err(|_| {
        DesktopSetupError::InspectionFailed(
            "The current user home could not be inspected for browser installation.".to_owned(),
        )
    })?;
    #[cfg(unix)]
    if root_metadata.file_type().is_symlink()
        || !root_metadata.is_dir()
        || root_metadata.uid() != uid
    {
        return Ok(OwnedPathState::Unsafe);
    }
    #[cfg(not(unix))]
    if !root_metadata.is_dir() {
        return Ok(OwnedPathState::Unsafe);
    }

    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(OwnedPathState::Missing)
            }
            Err(_) => {
                return Err(DesktopSetupError::InspectionFailed(
                    "The fixed Chrome Native Messaging directory could not be inspected."
                        .to_owned(),
                ))
            }
        };
        #[cfg(unix)]
        if metadata.file_type().is_symlink() || !metadata.is_dir() || metadata.uid() != uid {
            return Ok(OwnedPathState::Unsafe);
        }
        #[cfg(not(unix))]
        if !metadata.is_dir() {
            return Ok(OwnedPathState::Unsafe);
        }
    }
    Ok(OwnedPathState::Ready)
}

fn ensure_container_directory_chain(
    root: &Path,
    destination: &Path,
    uid: u32,
) -> Result<(), DesktopSetupError> {
    let relative = destination.strip_prefix(root).map_err(|_| {
        DesktopSetupError::UnsafeInstallation(
            "The fixed Chrome Native Messaging directory is outside the user home.".to_owned(),
        )
    })?;
    let root_metadata = fs::symlink_metadata(root).map_err(|_| {
        DesktopSetupError::UnsafeInstallation(
            "The current user home could not be inspected for browser installation.".to_owned(),
        )
    })?;
    #[cfg(unix)]
    if root_metadata.file_type().is_symlink()
        || !root_metadata.is_dir()
        || root_metadata.uid() != uid
    {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The current user home is unsafe for browser installation.".to_owned(),
        ));
    }
    #[cfg(not(unix))]
    if !root_metadata.is_dir() {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The current user home is unsafe for browser installation.".to_owned(),
        ));
    }

    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| {
                    DesktopSetupError::InstallationFailed(
                        "The fixed Chrome Native Messaging directory could not be created."
                            .to_owned(),
                    )
                })?;
                fs::symlink_metadata(&current).map_err(|_| {
                    DesktopSetupError::InstallationFailed(
                        "The fixed Chrome Native Messaging directory could not be verified."
                            .to_owned(),
                    )
                })?
            }
            Err(_) => {
                return Err(DesktopSetupError::InstallationFailed(
                    "The fixed Chrome Native Messaging directory could not be inspected."
                        .to_owned(),
                ));
            }
        };
        #[cfg(unix)]
        if metadata.file_type().is_symlink() || !metadata.is_dir() || metadata.uid() != uid {
            return Err(DesktopSetupError::UnsafeInstallation(
                "The fixed Chrome Native Messaging directory has unexpected ownership or type."
                    .to_owned(),
            ));
        }
        #[cfg(not(unix))]
        if !metadata.is_dir() {
            return Err(DesktopSetupError::UnsafeInstallation(
                "The fixed Chrome Native Messaging directory has unexpected type.".to_owned(),
            ));
        }
    }
    Ok(())
}

fn repair_existing_owned_directory(
    path: &Path,
    uid: u32,
    mode: u32,
) -> Result<(), DesktopSetupError> {
    match inspect_owned_directory(path, uid, mode)? {
        OwnedPathState::Ready | OwnedPathState::Missing => Ok(()),
        OwnedPathState::WrongMode => set_mode(path, mode),
        OwnedPathState::Unsafe => Err(DesktopSetupError::UnsafeInstallation(
            "A fixed Greenways directory has unexpected ownership or type.".to_owned(),
        )),
    }
}

fn repair_owned_file(path: &Path, uid: u32, mode: u32) -> Result<(), DesktopSetupError> {
    match inspect_owned_file(path, uid, mode)? {
        OwnedPathState::Ready => Ok(()),
        OwnedPathState::WrongMode => set_mode(path, mode),
        OwnedPathState::Missing => Err(DesktopSetupError::InstallationFailed(
            "A fixed Greenways file is missing.".to_owned(),
        )),
        OwnedPathState::Unsafe => Err(DesktopSetupError::UnsafeInstallation(
            "A fixed Greenways file has unexpected ownership or type.".to_owned(),
        )),
    }
}

fn atomic_copy(
    source: &Path,
    destination: &Path,
    uid: u32,
    mode: u32,
) -> Result<(), DesktopSetupError> {
    if destination.exists()
        && matches!(
            inspect_owned_file(destination, uid, mode)?,
            OwnedPathState::Unsafe
        )
    {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The existing fixed Greenways binary is unsafe to replace.".to_owned(),
        ));
    }
    let temporary = temporary_path(destination)?;
    let result = (|| {
        copy_to_temporary(source, &temporary, mode)?;
        fs::rename(&temporary, destination).map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The fixed Greenways binary could not be installed atomically.".to_owned(),
            )
        })?;
        sync_parent(destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn atomic_copy_new(
    source: &Path,
    destination: &Path,
    uid: u32,
    mode: u32,
) -> Result<(), DesktopSetupError> {
    if inspect_owned_file(destination, uid, mode)? != OwnedPathState::Missing {
        return Err(DesktopSetupError::UnsafeInstallation(
            "A fixed browser companion destination changed during installation.".to_owned(),
        ));
    }
    let temporary = temporary_path(destination)?;
    let result = (|| {
        copy_to_temporary(source, &temporary, mode)?;
        commit_new_file(&temporary, destination)?;
        sync_parent(destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn copy_to_temporary(source: &Path, temporary: &Path, mode: u32) -> Result<(), DesktopSetupError> {
    let mut input = File::open(source).map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The packaged Greenways binary could not be opened.".to_owned(),
        )
    })?;
    let mut output = private_new_file(temporary, mode)?;
    std::io::copy(&mut input, &mut output).map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The fixed Greenways binary could not be copied.".to_owned(),
        )
    })?;
    output.sync_all().map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The fixed Greenways binary copy could not be committed.".to_owned(),
        )
    })
}

fn atomic_write(
    destination: &Path,
    bytes: &[u8],
    uid: u32,
    mode: u32,
) -> Result<(), DesktopSetupError> {
    if destination.exists()
        && matches!(
            inspect_owned_file(destination, uid, mode)?,
            OwnedPathState::Unsafe
        )
    {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The existing fixed Greenways file is unsafe to replace.".to_owned(),
        ));
    }
    let temporary = temporary_path(destination)?;
    let result = (|| {
        write_temporary(&temporary, bytes, mode)?;
        fs::rename(&temporary, destination).map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The fixed Greenways file could not be installed atomically.".to_owned(),
            )
        })?;
        sync_parent(destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn atomic_write_new(
    destination: &Path,
    bytes: &[u8],
    uid: u32,
    mode: u32,
) -> Result<(), DesktopSetupError> {
    if inspect_owned_file(destination, uid, mode)? != OwnedPathState::Missing {
        return Err(DesktopSetupError::UnsafeInstallation(
            "A fixed browser companion destination changed during installation.".to_owned(),
        ));
    }
    let temporary = temporary_path(destination)?;
    let result = (|| {
        write_temporary(&temporary, bytes, mode)?;
        commit_new_file(&temporary, destination)?;
        sync_parent(destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn write_temporary(path: &Path, bytes: &[u8], mode: u32) -> Result<(), DesktopSetupError> {
    let mut file = private_new_file(path, mode)?;
    file.write_all(bytes).map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The fixed Greenways file could not be written.".to_owned(),
        )
    })?;
    file.sync_all().map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The fixed Greenways file could not be committed.".to_owned(),
        )
    })
}

fn commit_new_file(temporary: &Path, destination: &Path) -> Result<(), DesktopSetupError> {
    fs::hard_link(temporary, destination).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            DesktopSetupError::UnsafeInstallation(
                "A fixed browser companion destination changed during installation.".to_owned(),
            )
        } else {
            DesktopSetupError::InstallationFailed(
                "The fixed browser companion file could not be installed atomically.".to_owned(),
            )
        }
    })?;
    if fs::remove_file(temporary).is_err() {
        let removed_destination = fs::remove_file(destination).is_ok();
        if removed_destination {
            let _ = sync_parent(destination);
        }
        return Err(DesktopSetupError::UnsafeInstallation(
            "The browser companion transaction could not be committed safely.".to_owned(),
        ));
    }
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), DesktopSetupError> {
    let parent = path.parent().ok_or_else(|| {
        DesktopSetupError::UnsafeInstallation(
            "A fixed Greenways destination has no parent.".to_owned(),
        )
    })?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The fixed Greenways destination directory could not be committed.".to_owned(),
            )
        })
}

fn private_new_file(path: &Path, mode: u32) -> Result<File, DesktopSetupError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(mode);
    let file = options.open(path).map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "A private Greenways temporary file could not be created.".to_owned(),
        )
    })?;
    #[cfg(unix)]
    file.set_permissions(fs::Permissions::from_mode(mode))
        .map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "A private Greenways temporary file mode could not be set.".to_owned(),
            )
        })?;
    Ok(file)
}

fn temporary_path(destination: &Path) -> Result<PathBuf, DesktopSetupError> {
    let parent = destination.parent().ok_or_else(|| {
        DesktopSetupError::UnsafeInstallation(
            "A fixed Greenways destination has no parent.".to_owned(),
        )
    })?;
    let file_name = destination
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| {
            DesktopSetupError::UnsafeInstallation(
                "A fixed Greenways destination name is invalid.".to_owned(),
            )
        })?;
    let path = parent.join(format!(".{file_name}.tmp-{}", process::id()));
    if path.exists() {
        return Err(DesktopSetupError::UnsafeInstallation(
            "A stale Greenways installation transaction requires manual recovery.".to_owned(),
        ));
    }
    Ok(path)
}

fn set_mode(path: &Path, mode: u32) -> Result<(), DesktopSetupError> {
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "A fixed Greenways permission could not be repaired.".to_owned(),
        )
    })?;
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

fn path_text(path: &Path) -> Result<String, DesktopSetupError> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        DesktopSetupError::UnsafeInstallation(
            "A fixed Greenways path is not valid Unicode.".to_owned(),
        )
    })
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(target_os = "macos")]
fn choose_identity_recovery_file(prompt: &str) -> Result<Option<PathBuf>, DesktopSetupError> {
    const CANCELLED: &[u8] = b"__GREENWAYS_IDENTITY_RECOVERY_CANCELLED__";
    const MAX_SELECTED_PATH_BYTES: usize = 16 * 1024;
    let escaped_prompt = prompt.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        "try\nreturn POSIX path of (choose file with prompt \"{escaped_prompt}\")\non error number -128\nreturn \"{}\"\nend try",
        String::from_utf8_lossy(CANCELLED)
    );
    let output = fixed_command("/usr/bin/osascript", ["-e", script.as_str()])?;
    if !output.status.success() || output.stdout.len() > MAX_SELECTED_PATH_BYTES {
        return Err(DesktopSetupError::InstallationFailed(
            "The native identity recovery file selector failed.".to_owned(),
        ));
    }
    let mut bytes = output.stdout;
    while matches!(bytes.last(), Some(b'\n' | b'\r')) {
        bytes.pop();
    }
    if bytes.as_slice() == CANCELLED {
        return Ok(None);
    }
    if bytes.is_empty() || bytes.contains(&0) {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The native identity recovery selector returned an invalid path.".to_owned(),
        ));
    }
    Ok(Some(PathBuf::from(std::ffi::OsString::from_vec(bytes))))
}

#[cfg(target_os = "macos")]
fn fixed_command<I, S>(program: &str, arguments: I) -> Result<Output, DesktopSetupError>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Command::new(program).args(arguments).output().map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The fixed macOS service command could not be started.".to_owned(),
        )
    })
}

#[cfg(target_os = "macos")]
fn known_missing_service(output: &Output) -> bool {
    let stderr = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
    stderr.contains("could not find service")
        || stderr.contains("no such process")
        || stderr.contains("service not found")
}

#[cfg(target_os = "macos")]
fn require_success(output: Output, message: &str) -> Result<(), DesktopSetupError> {
    if output.status.success() {
        Ok(())
    } else {
        Err(DesktopSetupError::InstallationFailed(message.to_owned()))
    }
}
