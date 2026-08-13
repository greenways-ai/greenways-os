use super::{
    service::{
        binary_identity, expected_launch_agent_plist, inspect_owned_directory, inspect_owned_file,
        socket_is_safe, DaemonServiceInstaller, LaunchAgentController, OwnedPathState, SetupPaths,
        SystemLaunchAgentController, DAEMON_SERVICE_LABEL,
    },
    DesktopSetupBackend, DesktopSetupComponent, DesktopSetupComponentKind, DesktopSetupError,
    DesktopSetupOperation, DesktopSetupSnapshot, DesktopSetupState,
};
use greenways_authority::{read_credential_file, LocalClientRole};
use greenways_desktop_bridge::now_unix_ms;
use greenways_identity::ProfileIdentityVault;
use std::fs;

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

    fn inspect_components(&self) -> Result<Vec<DesktopSetupComponent>, DesktopSetupError> {
        Ok(vec![
            self.inspect_home()?,
            self.inspect_daemon()?,
            self.inspect_desktop_client()?,
            self.inspect_identity()?,
            DesktopSetupComponent::optional(
                DesktopSetupComponentKind::BrowserCompanion,
                DesktopSetupState::BrowserCompanionOptional,
            ),
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
        match inspect_owned_file(&credential_path, paths.uid, 0o600)? {
            OwnedPathState::Missing => Ok(DesktopSetupComponent::blocked(
                DesktopSetupComponentKind::DesktopClient,
                DesktopSetupState::CredentialRequired,
                "desktop-credential-required",
            )),
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
            OwnedPathState::Ready => match read_credential_file(&credential_path) {
                Ok(credential) if credential.role == LocalClientRole::Desktop => Ok(
                    DesktopSetupComponent::ready(DesktopSetupComponentKind::DesktopClient),
                ),
                Ok(_) => Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::DesktopClient,
                    DesktopSetupState::CredentialRoleMismatch,
                    "desktop-credential-role-mismatch",
                )),
                Err(_) => Ok(DesktopSetupComponent::blocked(
                    DesktopSetupComponentKind::DesktopClient,
                    DesktopSetupState::ManualRecoveryRequired,
                    "desktop-credential-invalid",
                )),
            },
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
                let identity = ProfileIdentityVault::open_system(metadata_path).map_err(|_| {
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
