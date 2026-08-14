#!/usr/bin/env python3

import argparse
import base64
import gzip
import hashlib
from pathlib import Path

PAYLOAD_LENGTH = 11840
PAYLOAD_SHA256 = "1210f5894b9e5d8108c5212f82b47f1df1fec58241805162faf6f055c638d3eb"
ARCHIVE_LENGTH = 8879
ARCHIVE_SHA256 = "ac9131af60e3e8b5c61563b6e6ab097727d7c9ff4bff05a6a575db05aff8f109"
PATCH_LENGTH = 40331
PATCH_SHA256 = "73e285b503dbe3d12f243714c00b12f7abd475ac166ee0771934d8e4589e7083"
PATCH_PATH = Path("/tmp/desktop-client-enrollment-108.patch")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def reconstruct() -> None:
    encoded = b"".join(
        b"".join(
            Path(f".github/agent/desktop-client-enrollment-108.part-{index:02d}")
            .read_bytes()
            .split()
        )
        for index in range(2)
    )
    assert len(encoded) == PAYLOAD_LENGTH
    assert sha256(encoded) == PAYLOAD_SHA256

    archive = base64.b64decode(encoded, validate=True)
    assert len(archive) == ARCHIVE_LENGTH
    assert sha256(archive) == ARCHIVE_SHA256

    patch = gzip.decompress(archive)
    assert len(patch) == PATCH_LENGTH
    assert sha256(patch) == PATCH_SHA256
    PATCH_PATH.write_bytes(patch)


def replace_once(path: str, old: str, new: str) -> None:
    source = Path(path)
    text = source.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"{path}: expected one reviewed merge anchor")
    source.write_text(text.replace(old, new, 1))


def resolve() -> None:
    replace_once(
        "services/greenways-desktop-bridge/src/setup/inspect.rs",
        '''            OwnedPathState::Ready => match read_credential_file(&credential_path) {
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
            },''',
        '''            OwnedPathState::Ready => {
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
            }''',
    )

    replace_once(
        "services/greenways-desktop-bridge/src/setup/service.rs",
        '''pub trait LaunchAgentController {
    fn restart(
        &mut self,
        launch_agent: &Path,
        label: &str,
        uid: u32,
    ) -> Result<(), DesktopSetupError>;
}''',
        '''pub trait LaunchAgentController {
    fn stop(&mut self, label: &str, uid: u32) -> Result<(), DesktopSetupError>;

    fn restart(
        &mut self,
        launch_agent: &Path,
        label: &str,
        uid: u32,
    ) -> Result<(), DesktopSetupError>;
}''',
    )

    replace_once(
        "services/greenways-desktop-bridge/src/setup/tests.rs",
        '''    service::{
        expected_launch_agent_plist, LaunchAgentController, SetupPaths, DAEMON_SERVICE_LABEL,
    },
    DesktopSetupBackend, DesktopSetupComponentKind, DesktopSetupError, DesktopSetupHost,
    DesktopSetupOperation, DesktopSetupRequest, DesktopSetupState, DESKTOP_SETUP_PROTOCOL,
    DESKTOP_SETUP_RESULT_PROTOCOL,
};
use std::{''',
        '''    service::{
        expected_launch_agent_plist, LaunchAgentController, SetupPaths, DAEMON_SERVICE_LABEL,
        DESKTOP_CLIENT_LABEL,
    },
    DesktopSetupBackend, DesktopSetupComponentKind, DesktopSetupError, DesktopSetupHost,
    DesktopSetupOperation, DesktopSetupRequest, DesktopSetupState, DESKTOP_SETUP_PROTOCOL,
    DESKTOP_SETUP_RESULT_PROTOCOL,
};
use greenways_authority::{read_credential_file, LocalClientRegistry, LocalClientRole};
use std::{''',
    )

    for pattern in ("*.orig", "*.rej"):
        for path in Path(".").rglob(pattern):
            path.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("reconstruct", "resolve"))
    args = parser.parse_args()
    if args.command == "reconstruct":
        reconstruct()
    else:
        resolve()
