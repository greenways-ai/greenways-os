use super::{
    browser::{
        expected_native_messaging_manifest, verify_embedded_extension_identity,
        BROWSER_CLIENT_LABEL, BROWSER_HOST_NAME,
    },
    service::{
        binary_identity, browser_host_digest, browser_host_identity, expected_launch_agent_plist,
        inspect_container_directory_chain, inspect_owned_directory, inspect_owned_file,
        socket_is_safe, DaemonServiceInstaller, LaunchAgentController, OwnedPathState, SetupPaths,
        SystemLaunchAgentController, DAEMON_SERVICE_LABEL,
    },
    DesktopSetupBackend, DesktopSetupComponent, DesktopSetupComponentKind, DesktopSetupError,
    DesktopSetupOperation, DesktopSetupSnapshot, DesktopSetupState,
};
use greenways_authority::{read_credential_file, LocalClientRegistry, LocalClientRole};
use greenways_desktop_bridge::now_unix_ms;
use std::{collections::HashSet, fs};

#[cfg(test)]
use super::service::{BrowserInstallHook, IdentityVaultOpener};

#[cfg(target_os = "macos")]
use std::{thread, time::Duration};

pub struct DesktopSetupEngine<C> {
    installer: DaemonServiceInstaller<C>,
}

pub type SystemDesktopSetupBackend = DesktopSetupEngine<SystemLaunchAgentController>;

impl SystemDesktopSetupBackend {
    pub fn resolve() -> Result<Self, DesktopSetupError> {
        Ok(Self::new(
            SetupPaths::resolve()?,
            SystemLaunchAgentController,
        ))
    }
}

impl<C: LaunchAgentController> DesktopSetupEngine<C> {
    pub fn new(paths: SetupPaths, controller: C) -> Self {
        Self {
            installer: DaemonServiceInstaller::new(paths, controller),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_with_identity_vault_opener(
        paths: SetupPaths,
        controller: C,
        identity_vault_opener: IdentityVaultOpener,
    ) -> Self {
        Self {
            installer: DaemonServiceInstaller::new_with_identity_vault_opener(
                paths,
                controller,
                identity_vault_opener,
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn set_browser_install_hook(&mut self, hook: BrowserInstallHook) {
        self.installer.set_browser_install_hook(hook);
    }

    fn inspect_components(&self) -> Result<Vec<DesktopSetupComponent>, DesktopSetupError> {
        Ok(vec![
            self.inspect_home()?,
            self.inspect_daemon()?,
            self.inspect_desktop_client()?,
            self.inspect_identity()?,
            self.inspect_browser_companion()?,
        ])
    }

    fn inspect_home(&self) -> Result<DesktopSetupComponent, DesktopSetupError> {
        let paths = &self.installer.paths;
        let mut saw_missing = false;
        let mut saw_wrong_mode = false;
        for directory in paths.greenways_directories() {
            match inspect_owned_directory(directory, paths.uid, 0o700)? {
                OwnedPathState::Ready => {}
                OwnedPathState::Missing => saw_missing = true,
                OwnedPathState::WrongMode => saw_wrong_mode = true,
                OwnedPathState::Unsafe => {
                    return Ok(DesktopSetupComponent::blocked(
                        DesktopSetupComponentKind::GreenwaysHome,
                        DesktopSetupState::ManualRecoveryRequired,
                        "home-ownership-or-type-mismatch",
                    ));
                }
            }
        }
        if saw_wrong_mode {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::GreenwaysHome,
                DesktopSetupState::PermissionRepairRequired,
                "home-permission-repair-required",
            ));
        }
        if saw_missing {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::GreenwaysHome,
                DesktopSetupState::InstallRequired,
                "home-install-required",
            ));
        }
        Ok(DesktopSetupComponent::ready(
            DesktopSetupComponentKind::GreenwaysHome,
        ))
    }

    fn inspect_daemon(&self) -> Result<DesktopSetupComponent, DesktopSetupError> {
        let paths = &self.installer.paths;
        let packaged = match binary_identity(&paths.packaged_daemon, None) {
            Ok(identity) => identity,
            Err(_) => {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::Daemon,
                    DesktopSetupState::ManualRecoveryRequired,
                    "daemon-package-invalid",
                ));
            }
        };

        let app_support_state =
            inspect_owned_directory(&paths.application_support_dir, paths.uid, 0o700)?;
        let bin_dir = paths.installed_daemon.parent().ok_or_else(|| {
            DesktopSetupError::InspectionFailed(
                "The fixed Greenways daemon installation directory is invalid.".to_owned(),
            )
        })?;
        let bin_state = inspect_owned_directory(bin_dir, paths.uid, 0o700)?;
        let binary_state = inspect_owned_file(&paths.installed_daemon, paths.uid, 0o755)?;
        let plist_state = inspect_owned_file(&paths.launch_agent, paths.uid, 0o600)?;
        if matches!(app_support_state, OwnedPathState::Unsafe)
            || matches!(bin_state, OwnedPathState::Unsafe)
            || matches!(binary_state, OwnedPathState::Unsafe)
            || matches!(plist_state, OwnedPathState::Unsafe)
        {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::Daemon,
                DesktopSetupState::ManualRecoveryRequired,
                "daemon-installation-unsafe",
            ));
        }
        if matches!(app_support_state, OwnedPathState::WrongMode)
            || matches!(bin_state, OwnedPathState::WrongMode)
            || matches!(binary_state, OwnedPathState::WrongMode)
            || matches!(plist_state, OwnedPathState::WrongMode)
        {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::Daemon,
                DesktopSetupState::PermissionRepairRequired,
                "daemon-permission-repair-required",
            ));
        }
        if matches!(app_support_state, OwnedPathState::Missing)
            || matches!(bin_state, OwnedPathState::Missing)
            || matches!(binary_state, OwnedPathState::Missing)
            || matches!(plist_state, OwnedPathState::Missing)
        {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::Daemon,
                DesktopSetupState::InstallRequired,
                "daemon-install-required",
            ));
        }

        let installed = match binary_identity(&paths.installed_daemon, Some(paths.uid)) {
            Ok(identity) => identity,
            Err(_) => {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::Daemon,
                    DesktopSetupState::UpgradeRequired,
                    "daemon-binary-mismatch",
                ));
            }
        };
        let expected_plist = expected_launch_agent_plist(paths)?;
        let actual_plist = fs::read(&paths.launch_agent).map_err(|_| {
            DesktopSetupError::InspectionFailed(
                "The fixed Greenways LaunchAgent could not be read.".to_owned(),
            )
        })?;
        if actual_plist.len() > 64 * 1024 || actual_plist != expected_plist || installed != packaged
        {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::Daemon,
                DesktopSetupState::UpgradeRequired,
                "daemon-package-mismatch",
            ));
        }

        match socket_is_safe(&paths.socket_file(), paths.uid)? {
            Some(true) => Ok(
                DesktopSetupComponent::ready(DesktopSetupComponentKind::Daemon)
                    .with_version(installed.version)
                    .with_digest(installed.digest)
                    .with_public_id(DAEMON_SERVICE_LABEL),
            ),
            Some(false) => Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::Daemon,
                DesktopSetupState::ManualRecoveryRequired,
                "daemon-socket-unsafe",
            )),
            None => Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::Daemon,
                DesktopSetupState::RestartRequired,
                "daemon-restart-required",
            )),
        }
    }

    fn inspect_desktop_client(&self) -> Result<DesktopSetupComponent, DesktopSetupError> {
        let paths = &self.installer.paths;
        let credential_path = paths.desktop_credential();
        let registry_path = paths.local_client_registry();
        let registry_state = inspect_owned_file(&registry_path, paths.uid, 0o600)?;
        if registry_state == OwnedPathState::WrongMode {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::DesktopClient,
                DesktopSetupState::PermissionRepairRequired,
                "desktop-registry-permission-repair-required",
            ));
        }
        if registry_state == OwnedPathState::Unsafe {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::DesktopClient,
                DesktopSetupState::ManualRecoveryRequired,
                "desktop-registry-unsafe",
            ));
        }

        match inspect_owned_file(&credential_path, paths.uid, 0o600)? {
            OwnedPathState::Missing => {
                if registry_state == OwnedPathState::Ready {
                    let registry = match LocalClientRegistry::open(&registry_path) {
                        Ok(registry) => registry,
                        Err(_) => {
                            return Ok(DesktopSetupComponent::blocked(
                                DesktopSetupComponentKind::DesktopClient,
                                DesktopSetupState::ManualRecoveryRequired,
                                "desktop-registry-invalid",
                            ));
                        }
                    };
                    if registry.clients().iter().any(|client| {
                        client.role == LocalClientRole::Desktop
                            && client.revoked_at_unix_ms.is_none()
                    }) {
                        return Ok(DesktopSetupComponent::blocked(
                            DesktopSetupComponentKind::DesktopClient,
                            DesktopSetupState::ManualRecoveryRequired,
                            "desktop-credential-missing-for-active-client",
                        ));
                    }
                }
                Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::DesktopClient,
                    DesktopSetupState::CredentialRequired,
                    "desktop-credential-required",
                ))
            }
            OwnedPathState::WrongMode => Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::DesktopClient,
                DesktopSetupState::PermissionRepairRequired,
                "desktop-credential-permission-repair-required",
            )),
            OwnedPathState::Unsafe => Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::DesktopClient,
                DesktopSetupState::ManualRecoveryRequired,
                "desktop-credential-unsafe",
            )),
            OwnedPathState::Ready => {
                let credential = match read_credential_file(&credential_path) {
                    Ok(credential) => credential,
                    Err(_) => {
                        return Ok(DesktopSetupComponent::blocked(
                            DesktopSetupComponentKind::DesktopClient,
                            DesktopSetupState::ManualRecoveryRequired,
                            "desktop-credential-invalid",
                        ));
                    }
                };
                if credential.role != LocalClientRole::Desktop {
                    return Ok(DesktopSetupComponent::blocked(
                        DesktopSetupComponentKind::DesktopClient,
                        DesktopSetupState::CredentialRoleMismatch,
                        "desktop-credential-role-mismatch",
                    ));
                }
                if registry_state != OwnedPathState::Ready {
                    return Ok(DesktopSetupComponent::blocked(
                        DesktopSetupComponentKind::DesktopClient,
                        DesktopSetupState::ManualRecoveryRequired,
                        "desktop-registry-required",
                    ));
                }
                let registry = match LocalClientRegistry::open(&registry_path) {
                    Ok(registry) => registry,
                    Err(_) => {
                        return Ok(DesktopSetupComponent::blocked(
                            DesktopSetupComponentKind::DesktopClient,
                            DesktopSetupState::ManualRecoveryRequired,
                            "desktop-registry-invalid",
                        ));
                    }
                };
                match registry.verify_credential(&credential) {
                    Ok(client) => Ok(DesktopSetupComponent::ready(
                        DesktopSetupComponentKind::DesktopClient,
                    )
                    .with_public_id(client.id)),
                    Err(_) => Ok(DesktopSetupComponent::blocked(
                        DesktopSetupComponentKind::DesktopClient,
                        DesktopSetupState::ManualRecoveryRequired,
                        "desktop-credential-rejected",
                    )),
                }
            }
        }
    }

    fn inspect_identity(&self) -> Result<DesktopSetupComponent, DesktopSetupError> {
        let paths = &self.installer.paths;
        let metadata_path = paths.identity_metadata();
        match inspect_owned_file(&metadata_path, paths.uid, 0o600)? {
            OwnedPathState::Missing => Ok(DesktopSetupComponent::optional(
                DesktopSetupComponentKind::Identity,
                DesktopSetupState::IdentityOptional,
            )),
            OwnedPathState::WrongMode => Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::Identity,
                DesktopSetupState::PermissionRepairRequired,
                "identity-permission-repair-required",
            )),
            OwnedPathState::Unsafe => Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::Identity,
                DesktopSetupState::ManualRecoveryRequired,
                "identity-metadata-unsafe",
            )),
            OwnedPathState::Ready => {
                let identity = self
                    .installer
                    .open_identity_vault(metadata_path)
                    .map_err(|_| {
                        DesktopSetupError::InspectionFailed(
                            "The local public identity metadata is invalid.".to_owned(),
                        )
                    })?;
                let status = identity.status();
                match status.identity_id {
                    Some(identity_id) => Ok(DesktopSetupComponent::ready(
                        DesktopSetupComponentKind::Identity,
                    )
                    .with_public_id(identity_id)),
                    None => Ok(DesktopSetupComponent::optional(
                        DesktopSetupComponentKind::Identity,
                        DesktopSetupState::IdentityOptional,
                    )),
                }
            }
        }
    }

    fn inspect_browser_companion(&self) -> Result<DesktopSetupComponent, DesktopSetupError> {
        let paths = &self.installer.paths;
        if verify_embedded_extension_identity().is_err() {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::ManualRecoveryRequired,
                "browser-package-identity-invalid",
            ));
        }
        let packaged = match browser_host_identity(&paths.packaged_browser_host, None) {
            Ok(identity) => identity,
            Err(_) => {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::BrowserCompanion,
                    DesktopSetupState::ManualRecoveryRequired,
                    "browser-package-invalid",
                ));
            }
        };

        let chrome_container_state = inspect_container_directory_chain(
            &paths.user_home,
            &paths.chrome_native_messaging_dir,
            paths.uid,
        )?;
        if chrome_container_state == OwnedPathState::Unsafe {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::ManualRecoveryRequired,
                "browser-installation-unsafe",
            ));
        }
        let registry_state = inspect_owned_file(&paths.local_client_registry(), paths.uid, 0o600)?;
        let bin_state = inspect_owned_directory(paths.browser_bin_dir(), paths.uid, 0o700)?;
        let credential_state = inspect_owned_file(&paths.browser_credential(), paths.uid, 0o600)?;
        let host_state = inspect_owned_file(&paths.installed_browser_host, paths.uid, 0o755)?;
        let manifest_state = inspect_owned_file(&paths.browser_manifest, paths.uid, 0o600)?;
        let required_states = [credential_state, host_state, manifest_state];

        if required_states.contains(&OwnedPathState::Unsafe)
            || registry_state == OwnedPathState::Unsafe
            || bin_state == OwnedPathState::Unsafe
        {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::ManualRecoveryRequired,
                "browser-installation-unsafe",
            ));
        }

        let all_missing = required_states
            .iter()
            .all(|state| *state == OwnedPathState::Missing);
        if all_missing {
            if registry_state == OwnedPathState::WrongMode || bin_state == OwnedPathState::WrongMode
            {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::BrowserCompanion,
                    DesktopSetupState::PermissionRepairRequired,
                    "browser-permission-repair-required",
                ));
            }
            if registry_state == OwnedPathState::Ready {
                let registry = match LocalClientRegistry::open(paths.local_client_registry()) {
                    Ok(registry) => registry,
                    Err(_) => {
                        return Ok(DesktopSetupComponent::blocked(
                            DesktopSetupComponentKind::BrowserCompanion,
                            DesktopSetupState::ManualRecoveryRequired,
                            "browser-registry-invalid",
                        ));
                    }
                };
                if registry.clients().iter().any(|client| {
                    client.role == LocalClientRole::BrowserBridge
                        && client.revoked_at_unix_ms.is_none()
                }) {
                    return Ok(DesktopSetupComponent::blocked(
                        DesktopSetupComponentKind::BrowserCompanion,
                        DesktopSetupState::ManualRecoveryRequired,
                        "browser-credential-missing-for-active-client",
                    ));
                }
            }
            return Ok(DesktopSetupComponent::optional(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::BrowserCompanionOptional,
            ));
        }

        if required_states
            .iter()
            .any(|state| *state == OwnedPathState::Missing)
            || registry_state == OwnedPathState::Missing
            || bin_state == OwnedPathState::Missing
            || chrome_container_state == OwnedPathState::Missing
        {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::ManualRecoveryRequired,
                "browser-partial-installation",
            ));
        }
        if required_states.contains(&OwnedPathState::WrongMode)
            || registry_state == OwnedPathState::WrongMode
            || bin_state == OwnedPathState::WrongMode
        {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::PermissionRepairRequired,
                "browser-permission-repair-required",
            ));
        }

        let registry = match LocalClientRegistry::open(paths.local_client_registry()) {
            Ok(registry) => registry,
            Err(_) => {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::BrowserCompanion,
                    DesktopSetupState::ManualRecoveryRequired,
                    "browser-registry-invalid",
                ));
            }
        };
        let credential = match read_credential_file(paths.browser_credential()) {
            Ok(credential) => credential,
            Err(_) => {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::BrowserCompanion,
                    DesktopSetupState::ManualRecoveryRequired,
                    "browser-credential-invalid",
                ));
            }
        };
        if credential.role != LocalClientRole::BrowserBridge {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::ManualRecoveryRequired,
                "browser-credential-role-mismatch",
            ));
        }
        let client = match registry.verify_credential(&credential) {
            Ok(client) => client,
            Err(_) => {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::BrowserCompanion,
                    DesktopSetupState::ManualRecoveryRequired,
                    "browser-credential-rejected",
                ));
            }
        };
        let active_browser_clients = registry
            .clients()
            .into_iter()
            .filter(|candidate| {
                candidate.role == LocalClientRole::BrowserBridge
                    && candidate.revoked_at_unix_ms.is_none()
            })
            .collect::<Vec<_>>();
        if client.role != LocalClientRole::BrowserBridge
            || client.label != BROWSER_CLIENT_LABEL
            || active_browser_clients.len() != 1
            || active_browser_clients[0].id != client.id
        {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::ManualRecoveryRequired,
                "browser-client-contract-mismatch",
            ));
        }

        let installed_digest =
            match browser_host_digest(&paths.installed_browser_host, Some(paths.uid)) {
                Ok(digest) => digest,
                Err(_) => {
                    return Ok(DesktopSetupComponent::blocked(
                        DesktopSetupComponentKind::BrowserCompanion,
                        DesktopSetupState::UpgradeRequired,
                        "browser-host-mismatch",
                    ));
                }
            };
        if installed_digest != packaged.digest {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::UpgradeRequired,
                "browser-host-mismatch",
            ));
        }
        let installed = match browser_host_identity(&paths.installed_browser_host, Some(paths.uid))
        {
            Ok(identity) => identity,
            Err(_) => {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::BrowserCompanion,
                    DesktopSetupState::UpgradeRequired,
                    "browser-host-mismatch",
                ));
            }
        };
        if installed != packaged {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::UpgradeRequired,
                "browser-host-mismatch",
            ));
        }

        let expected_manifest = expected_native_messaging_manifest(&paths.installed_browser_host)?;
        let actual_manifest = match fs::read(&paths.browser_manifest) {
            Ok(bytes) if bytes.len() <= 64 * 1024 => bytes,
            _ => {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::BrowserCompanion,
                    DesktopSetupState::ManualRecoveryRequired,
                    "browser-manifest-invalid",
                ));
            }
        };
        let expected_value: serde_json::Value = serde_json::from_slice(&expected_manifest)
            .map_err(|_| {
                DesktopSetupError::InspectionFailed(
                    "The reviewed Chrome Native Messaging manifest is invalid.".to_owned(),
                )
            })?;
        let actual_value: serde_json::Value = match serde_json::from_slice(&actual_manifest) {
            Ok(value) => value,
            Err(_) => {
                return Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::BrowserCompanion,
                    DesktopSetupState::ManualRecoveryRequired,
                    "browser-manifest-invalid",
                ));
            }
        };
        let expected_object = expected_value.as_object().ok_or_else(|| {
            DesktopSetupError::InspectionFailed(
                "The reviewed Chrome Native Messaging manifest is invalid.".to_owned(),
            )
        })?;
        let Some(actual_object) = actual_value.as_object() else {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::ManualRecoveryRequired,
                "browser-manifest-invalid",
            ));
        };
        let expected_keys = expected_object.keys().collect::<HashSet<_>>();
        let actual_keys = actual_object.keys().collect::<HashSet<_>>();
        let authority_fields = ["name", "path", "type", "allowed_origins"];
        if expected_keys != actual_keys
            || authority_fields
                .iter()
                .any(|field| actual_object.get(*field) != expected_object.get(*field))
            || !actual_object
                .get("description")
                .is_some_and(serde_json::Value::is_string)
        {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::ManualRecoveryRequired,
                "browser-manifest-unsafe",
            ));
        }
        if actual_value != expected_value || actual_manifest != expected_manifest {
            return Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::UpgradeRequired,
                "browser-manifest-drift",
            ));
        }

        Ok(
            DesktopSetupComponent::ready(DesktopSetupComponentKind::BrowserCompanion)
                .with_version(installed.version)
                .with_digest(installed.digest)
                .with_public_id(BROWSER_HOST_NAME),
        )
    }

    fn inspect_snapshot(&self) -> Result<DesktopSetupSnapshot, DesktopSetupError> {
        let observed_at_unix_ms = now_unix_ms().map_err(|_| {
            DesktopSetupError::InspectionFailed(
                "The Desktop setup clock is unavailable.".to_owned(),
            )
        })?;
        DesktopSetupSnapshot::inspected(self.inspect_components()?, observed_at_unix_ms)
    }
}

impl<C: LaunchAgentController> DesktopSetupBackend for DesktopSetupEngine<C> {
    fn inspect(&mut self) -> Result<DesktopSetupSnapshot, DesktopSetupError> {
        self.inspect_snapshot()
    }

    fn install_daemon(&mut self) -> Result<DesktopSetupSnapshot, DesktopSetupError> {
        let before = self.inspect_snapshot()?;
        if !before
            .permitted_actions
            .contains(&DesktopSetupOperation::InstallDaemon)
        {
            return Err(DesktopSetupError::OperationUnavailable(
                "Daemon installation is not permitted by the current setup state.".to_owned(),
            ));
        }
        self.installer.install()?;
        #[cfg(target_os = "macos")]
        for _ in 0..30 {
            if self.installer.paths.socket_file().exists() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        self.inspect_snapshot()
    }

    fn issue_desktop_client(&mut self) -> Result<DesktopSetupSnapshot, DesktopSetupError> {
        let before = self.inspect_snapshot()?;
        if !before
            .permitted_actions
            .contains(&DesktopSetupOperation::IssueDesktopClient)
        {
            return Err(DesktopSetupError::OperationUnavailable(
                "Desktop access enrollment is not permitted by the current setup state.".to_owned(),
            ));
        }
        let observed_at_unix_ms = now_unix_ms().map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The Desktop setup clock is unavailable.".to_owned(),
            )
        })?;
        self.installer.issue_desktop_client(observed_at_unix_ms)?;
        #[cfg(target_os = "macos")]
        for _ in 0..30 {
            if self.installer.paths.socket_file().exists() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        self.inspect_snapshot()
    }

    fn create_identity(&mut self, handle: &str) -> Result<DesktopSetupSnapshot, DesktopSetupError> {
        let before = self.inspect_snapshot()?;
        if !before
            .permitted_actions
            .contains(&DesktopSetupOperation::CreateIdentity)
        {
            return Err(DesktopSetupError::OperationUnavailable(
                "Public identity creation is not permitted by the current setup state.".to_owned(),
            ));
        }
        let observed_at_unix_ms = now_unix_ms().map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The Desktop setup clock is unavailable.".to_owned(),
            )
        })?;
        self.installer
            .create_identity(handle, observed_at_unix_ms)?;
        #[cfg(target_os = "macos")]
        for _ in 0..30 {
            if self.installer.paths.socket_file().exists() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        self.inspect_snapshot()
    }

    fn install_browser_bridge(&mut self) -> Result<DesktopSetupSnapshot, DesktopSetupError> {
        let before = self.inspect_snapshot()?;
        if !before
            .permitted_actions
            .contains(&DesktopSetupOperation::InstallBrowserBridge)
        {
            return Err(DesktopSetupError::OperationUnavailable(
                "Chrome companion installation is not permitted by the current setup state."
                    .to_owned(),
            ));
        }
        let observed_at_unix_ms = now_unix_ms().map_err(|_| {
            DesktopSetupError::InstallationFailed(
                "The Desktop setup clock is unavailable.".to_owned(),
            )
        })?;
        if let Err(error) = self.installer.install_browser_bridge(observed_at_unix_ms) {
            if let Ok(recovery) = self.inspect_snapshot() {
                if recovery.state == DesktopSetupState::ManualRecoveryRequired {
                    return Ok(recovery);
                }
            }
            return Err(error);
        }
        #[cfg(target_os = "macos")]
        for _ in 0..30 {
            if self.installer.paths.socket_file().exists() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        self.inspect_snapshot()
    }

    fn repair_permissions(&mut self) -> Result<DesktopSetupSnapshot, DesktopSetupError> {
        let before = self.inspect_snapshot()?;
        if !before
            .permitted_actions
            .contains(&DesktopSetupOperation::RepairPermissions)
        {
            return Err(DesktopSetupError::OperationUnavailable(
                "Permission repair is not permitted by the current setup state.".to_owned(),
            ));
        }
        self.installer.repair_permissions()?;
        self.inspect_snapshot()
    }
}
