from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{label} source changed")
    path.write_text(text.replace(old, new, 1))


path = Path("services/greenways-desktop-bridge/src/setup/inspect.rs")
replace_once(
    path,
    "        socket_is_safe, DaemonServiceInstaller, IdentityVaultOpener, LaunchAgentController,\n"
    "        OwnedPathState, SetupPaths, SystemLaunchAgentController, DAEMON_SERVICE_LABEL,\n",
    "        socket_is_safe, DaemonServiceInstaller, LaunchAgentController, OwnedPathState,\n"
    "        SetupPaths, SystemLaunchAgentController, DAEMON_SERVICE_LABEL,\n",
    "identity opener import",
)
replace_once(
    path,
    "use greenways_desktop_bridge::now_unix_ms;\n"
    "use std::fs;\n\n"
    "#[cfg(target_os = \"macos\")]\n",
    "use greenways_desktop_bridge::now_unix_ms;\n"
    "use std::fs;\n\n"
    "#[cfg(test)]\n"
    "use super::service::IdentityVaultOpener;\n\n"
    "#[cfg(target_os = \"macos\")]\n",
    "identity opener test import",
)
replace_once(
    path,
    "    pub(crate) fn new_with_identity_vault_opener(\n",
    "    #[cfg(test)]\n"
    "    pub(crate) fn new_with_identity_vault_opener(\n",
    "identity opener constructor",
)
