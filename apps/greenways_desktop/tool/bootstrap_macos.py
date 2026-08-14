#!/usr/bin/env python3
"""Generate and configure the Greenways Desktop macOS host deterministically."""

from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import shutil
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = ROOT.parents[1]
TEMPLATES = ROOT / "tool" / "templates"
VERSION_FILE = ROOT / "FLUTTER_VERSION.txt"
DESKTOP_RESOURCE_BINARIES = (
    "greenways-desktop-bridge",
    "greenways-browser-bridge-host",
    "greenwaysd",
)
EXTENSION_IDENTITY_PROTOCOL = "greenways-chrome-extension-identity/0-alpha"
CHROME_EXTENSION_ID = "iignnnidjioameihobbmbeimdgampooj"
CHROME_EXTENSION_ORIGIN = f"chrome-extension://{CHROME_EXTENSION_ID}/"


def replace_once(path: pathlib.Path, old: str, new: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one configuration anchor, found {count}")
    path.write_text(text.replace(old, new))


def verify_extension_identity() -> None:
    extension_root = REPOSITORY_ROOT / "extension"
    identity = json.loads((extension_root / "extension-identity.json").read_text())
    manifest = json.loads((extension_root / "manifest.json").read_text())
    if set(identity) != {"protocol", "extensionId", "manifestKey", "origin"}:
        raise SystemExit("Chrome extension identity has unexpected fields")
    try:
        public_key = base64.b64decode(identity["manifestKey"], validate=True)
    except (ValueError, TypeError) as error:
        raise SystemExit("Chrome extension public identity is invalid") from error
    if len(public_key) < 64:
        raise SystemExit("Chrome extension public identity is too short")
    digest_prefix = hashlib.sha256(public_key).hexdigest()[:32]
    derived_id = "".join("abcdefghijklmnop"[int(value, 16)] for value in digest_prefix)
    if (
        identity["protocol"] != EXTENSION_IDENTITY_PROTOCOL
        or identity["extensionId"] != CHROME_EXTENSION_ID
        or identity["origin"] != CHROME_EXTENSION_ORIGIN
        or identity["manifestKey"] != manifest.get("key")
        or derived_id != CHROME_EXTENSION_ID
    ):
        raise SystemExit("Chrome extension public identity drifted")


def verify_flutter_toolchain() -> None:
    lines = [line.strip() for line in VERSION_FILE.read_text().splitlines() if line.strip()]
    if len(lines) != 2:
        raise SystemExit("FLUTTER_VERSION.txt must contain version and revision")
    expected_version, expected_revision = lines
    result = subprocess.run(
        ("flutter", "--version", "--machine"),
        check=True,
        capture_output=True,
        text=True,
    )
    metadata = json.loads(result.stdout)
    actual_version = metadata.get("frameworkVersion") or metadata.get("flutterVersion")
    actual_revision = metadata.get("frameworkRevision")
    if actual_version != expected_version or actual_revision != expected_revision:
        raise SystemExit(
            "Greenways Desktop requires Flutter "
            f"{expected_version} at {expected_revision}; found "
            f"{actual_version} at {actual_revision}"
        )


def main() -> None:
    verify_extension_identity()
    verify_flutter_toolchain()
    # Flutter owns the generated platform shell. Generate it out-of-tree so
    # `flutter create` can never overwrite reviewed Dart, tests, or pubspec data.
    with tempfile.TemporaryDirectory(prefix="greenways-desktop-") as temporary:
        scaffold = pathlib.Path(temporary) / "greenways_desktop"
        subprocess.run(
            (
                "flutter",
                "create",
                "--platforms=macos",
                "--org",
                "ai.greenways",
                "--project-name",
                "greenways_desktop",
                "--description",
                "Greenways Desktop local daemon connection shell.",
                str(scaffold),
            ),
            check=True,
        )
        macos = ROOT / "macos"
        if macos.exists():
            shutil.rmtree(macos)
        shutil.copytree(scaffold / "macos", macos)

    runner = ROOT / "macos" / "Runner"
    shutil.copyfile(TEMPLATES / "AppDelegate.swift", runner / "AppDelegate.swift")
    shutil.copyfile(
        TEMPLATES / "MainFlutterWindow.swift", runner / "MainFlutterWindow.swift"
    )
    shutil.copyfile(
        TEMPLATES / "build_desktop_bridge.sh",
        ROOT / "macos" / "build_desktop_bridge.sh",
    )
    (ROOT / "macos" / "build_desktop_bridge.sh").chmod(0o755)
    build_script = (ROOT / "macos" / "build_desktop_bridge.sh").read_text()
    missing_resources = [
        binary for binary in DESKTOP_RESOURCE_BINARIES if binary not in build_script
    ]
    if missing_resources:
        raise SystemExit(
            "Desktop resource build template omits reviewed binaries: "
            + ", ".join(missing_resources)
        )

    app_info = runner / "Configs" / "AppInfo.xcconfig"
    replace_once(app_info, "PRODUCT_NAME = greenways_desktop", "PRODUCT_NAME = Greenways Desktop")
    replace_once(
        app_info,
        "PRODUCT_BUNDLE_IDENTIFIER = ai.greenways.greenwaysDesktop",
        "PRODUCT_BUNDLE_IDENTIFIER = ai.greenways.desktop",
    )
    replace_once(
        app_info,
        "PRODUCT_COPYRIGHT = Copyright © 2026 ai.greenways. All rights reserved.",
        "PRODUCT_COPYRIGHT = Copyright © 2026 Greenways AI. All rights reserved.",
    )

    (runner / "DebugProfile.entitlements").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.cs.allow-jit</key>
	<true/>
</dict>
</plist>
"""
    )
    (runner / "Release.entitlements").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
"""
    )

    project = ROOT / "macos" / "Runner.xcodeproj" / "project.pbxproj"
    text = project.read_text()
    text = text.replace(
        "\t\t\t\t3399D490228B24CF009A79C7 /* ShellScript */,\n",
        "\t\t\t\t3399D490228B24CF009A79C7 /* ShellScript */,\n"
        "\t\t\t\tA18400012026D81300A18401 /* Bundle Desktop Bridge */,\n",
        1,
    )
    sandbox = """\t\t\t\t\t\tSystemCapabilities = {\n\t\t\t\t\t\t\tcom.apple.Sandbox = {\n\t\t\t\t\t\t\t\tenabled = 1;\n\t\t\t\t\t\t\t};\n\t\t\t\t\t\t};\n"""
    if text.count(sandbox) != 1:
        raise SystemExit("Xcode sandbox capability anchor changed")
    text = text.replace(sandbox, "", 1)
    phase_anchor = "/* Begin PBXShellScriptBuildPhase section */\n"
    phase = """\t\tA18400012026D81300A18401 /* Bundle Desktop Bridge */ = {\n\t\t\tisa = PBXShellScriptBuildPhase;\n\t\t\talwaysOutOfDate = 1;\n\t\t\tbuildActionMask = 2147483647;\n\t\t\tfiles = (\n\t\t\t);\n\t\t\tinputFileListPaths = (\n\t\t\t);\n\t\t\tinputPaths = (\n\t\t\t);\n\t\t\tname = \"Bundle Desktop Bridge\";\n\t\t\toutputFileListPaths = (\n\t\t\t);\n\t\t\toutputPaths = (\n\t\t\t);\n\t\t\trunOnlyForDeploymentPostprocessing = 0;\n\t\t\tshellPath = /bin/bash;\n\t\t\tshellScript = \"\\\"$PROJECT_DIR\\\"/build_desktop_bridge.sh\\n\";\n\t\t};\n"""
    if text.count(phase_anchor) != 1:
        raise SystemExit("Xcode shell phase anchor changed")
    text = text.replace(phase_anchor, phase_anchor + phase, 1)
    project.write_text(text)


if __name__ == "__main__":
    main()
