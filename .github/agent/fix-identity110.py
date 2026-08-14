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

path = Path("apps/greenways_desktop/test/desktop_shell_test.dart")
replace_once(
    path,
    "    await tester.enterText(\n"
    "      find.byKey(const Key('identity-handle-field')),\n"
    "      'river/studio',\n"
    "    );\n"
    "    await tester.tap(find.text('Create public identity'));\n"
    "    await tester.pumpAndSettle();\n",
    "    await tester.ensureVisible(\n"
    "      find.byKey(const Key('identity-handle-field')),\n"
    "    );\n"
    "    await tester.enterText(\n"
    "      find.byKey(const Key('identity-handle-field')),\n"
    "      'river/studio',\n"
    "    );\n"
    "    await tester.ensureVisible(\n"
    "      find.byKey(const Key('identity-create-action')),\n"
    "    );\n"
    "    await tester.pumpAndSettle();\n"
    "    await tester.tap(find.byKey(const Key('identity-create-action')));\n"
    "    await tester.pumpAndSettle();\n",
    "identity validation interaction",
)
replace_once(
    path,
    "    await tester.tap(find.text('Continue without identity'));\n"
    "    await tester.pumpAndSettle();\n",
    "    await tester.ensureVisible(\n"
    "      find.byKey(const Key('identity-continue-action')),\n"
    "    );\n"
    "    await tester.pumpAndSettle();\n"
    "    await tester.tap(find.byKey(const Key('identity-continue-action')));\n"
    "    await tester.pumpAndSettle();\n",
    "identity defer interaction",
)
