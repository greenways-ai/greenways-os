use super::DesktopSetupError;
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
use std::process::Output;

pub const DAEMON_SERVICE_LABEL: &str = "ai.greenways.greenwaysd";
const MAX_DAEMON_BINARY_BYTES: u64 = 128 * 1024 * 1024;
const MAX_VERSION_OUTPUT_BYTES: usize = 256;

#[derive(Debug, Clone)]
pub struct SetupPaths {
    pub greenways_home: PathBuf,
    pub state_dir: PathBuf,
    pub run_dir: PathBuf,
    pub clients_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub application_support_dir: PathBuf,
    pub installed_daemon: PathBuf,
    pub packaged_daemon: PathBuf,
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
        let logs_dir = greenways_home.join("log");
        Self {
            state_dir: greenways_home.join("state"),
            run_dir: greenways_home.join("run"),
            clients_dir: greenways_home.join("clients"),
            stdout_log: logs_dir.join("greenwaysd.stdout.log"),
            stderr_log: logs_dir.join("greenwaysd.stderr.log"),
            logs_dir,
            application_support_dir: application_support.clone(),
            installed_daemon: application_support.join("bin").join("greenwaysd"),
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
            let bootout = fixed_command(
                "/bin/launchctl",
                [OsStr::new("bootout"), OsStr::new(&service)],
            )?;
            if !bootout.status.success() && !known_missing_service(&bootout) {
                return Err(DesktopSetupError::InstallationFailed(
                    "The existing Greenways daemon service could not be unloaded.".to_owned(),
                ));
            }
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

pub struct DaemonServiceInstaller<C> {
    pub paths: SetupPaths,
    controller: C,
}

impl<C: LaunchAgentController> DaemonServiceInstaller<C> {
    pub fn new(paths: SetupPaths, controller: C) -> Self {
        Self { paths, controller }
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
        Ok(())
    }

    fn ensure_greenways_directories(&self, create_missing: bool) -> Result<(), DesktopSetupError> {
        for directory in self.paths.greenways_directories() {
            ensure_owned_directory(directory, self.paths.uid, 0o700, create_missing)?;
        }
        Ok(())
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
    let metadata = safe_file_metadata(path, expected_uid)?;
    if metadata.len() == 0 || metadata.len() > MAX_DAEMON_BINARY_BYTES {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The Greenways daemon binary size is invalid.".to_owned(),
        ));
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The Greenways daemon binary is not executable.".to_owned(),
        ));
    }
    let digest = digest_file(path)?;
    let output = Command::new(path).arg("--version").output().map_err(|_| {
        DesktopSetupError::UnsafeInstallation(
            "The Greenways daemon binary identity could not be read.".to_owned(),
        )
    })?;
    if !output.status.success()
        || output.stdout.len() > MAX_VERSION_OUTPUT_BYTES
        || !output.stderr.is_empty()
    {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The Greenways daemon binary returned an invalid identity.".to_owned(),
        ));
    }
    let version = String::from_utf8(output.stdout)
        .map_err(|_| {
            DesktopSetupError::UnsafeInstallation(
                "The Greenways daemon version is not text.".to_owned(),
            )
        })?
        .trim()
        .to_owned();
    let expected = format!("greenwaysd {}", env!("CARGO_PKG_VERSION"));
    if version != expected {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The Greenways daemon version does not match this Desktop build.".to_owned(),
        ));
    }
    Ok(BinaryIdentity { version, digest })
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
) -> Result<fs::Metadata, DesktopSetupError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        DesktopSetupError::UnsafeInstallation(
            "The fixed Greenways daemon binary is unavailable.".to_owned(),
        )
    })?;
    #[cfg(unix)]
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || expected_uid.is_some_and(|uid| metadata.uid() != uid)
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The fixed Greenways daemon binary is not safe to execute.".to_owned(),
        ));
    }
    #[cfg(not(unix))]
    if !metadata.is_file() {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The fixed Greenways daemon binary is not safe to execute.".to_owned(),
        ));
    }
    Ok(metadata)
}

fn digest_file(path: &Path) -> Result<String, DesktopSetupError> {
    let mut file = File::open(path).map_err(|_| {
        DesktopSetupError::InspectionFailed(
            "The Greenways daemon binary could not be read.".to_owned(),
        )
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|_| {
            DesktopSetupError::InspectionFailed(
                "The Greenways daemon binary could not be read.".to_owned(),
            )
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
            "The existing Greenways daemon binary is unsafe to replace.".to_owned(),
        ));
    }
    let mut input = File::open(source).map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The packaged Greenways daemon could not be opened.".to_owned(),
        )
    })?;
    let temporary = temporary_path(destination)?;
    let mut output = private_new_file(&temporary, mode)?;
    std::io::copy(&mut input, &mut output).map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The Greenways daemon could not be copied.".to_owned(),
        )
    })?;
    output.sync_all().map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The Greenways daemon copy could not be committed.".to_owned(),
        )
    })?;
    fs::rename(&temporary, destination).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        DesktopSetupError::InstallationFailed(
            "The Greenways daemon could not be installed atomically.".to_owned(),
        )
    })?;
    Ok(())
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
            "The existing Greenways LaunchAgent is unsafe to replace.".to_owned(),
        ));
    }
    let temporary = temporary_path(destination)?;
    let mut file = private_new_file(&temporary, mode)?;
    file.write_all(bytes).map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The Greenways LaunchAgent could not be written.".to_owned(),
        )
    })?;
    file.sync_all().map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The Greenways LaunchAgent could not be committed.".to_owned(),
        )
    })?;
    fs::rename(&temporary, destination).map_err(|_| {
        let _ = fs::remove_file(&temporary);
        DesktopSetupError::InstallationFailed(
            "The Greenways LaunchAgent could not be installed atomically.".to_owned(),
        )
    })?;
    Ok(())
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
