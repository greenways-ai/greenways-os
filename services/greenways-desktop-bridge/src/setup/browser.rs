use super::DesktopSetupError;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

pub const BROWSER_HOST_NAME: &str = "ai.greenways.browser_bridge";
pub const BROWSER_HOST_DESCRIPTION: &str = "Greenways OS authenticated local daemon browser bridge";
pub const BROWSER_CLIENT_LABEL: &str = "Chrome browser bridge";
pub const BROWSER_HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CHROME_EXTENSION_ID: &str = "iignnnidjioameihobbmbeimdgampooj";
pub const CHROME_EXTENSION_ORIGIN: &str = "chrome-extension://iignnnidjioameihobbmbeimdgampooj/";
const EXTENSION_IDENTITY_PROTOCOL: &str = "greenways-chrome-extension-identity/0-alpha";
const EMBEDDED_EXTENSION_IDENTITY: &str =
    include_str!("../../../../extension/extension-identity.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExtensionIdentity {
    protocol: String,
    extension_id: String,
    manifest_key: String,
    origin: String,
}

fn extension_id_from_manifest_key(manifest_key: &str) -> Option<String> {
    if !(64..=8192).contains(&manifest_key.len())
        || !manifest_key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"+/=".contains(&byte))
    {
        return None;
    }
    let public_key = STANDARD.decode(manifest_key).ok()?;
    if public_key.len() < 64 || STANDARD.encode(&public_key) != manifest_key {
        return None;
    }
    let digest = Sha256::digest(public_key);
    let mut extension_id = String::with_capacity(32);
    for byte in &digest[..16] {
        extension_id.push(char::from(b'a' + (byte >> 4)));
        extension_id.push(char::from(b'a' + (byte & 0x0f)));
    }
    Some(extension_id)
}

pub fn verify_embedded_extension_identity() -> Result<(), DesktopSetupError> {
    let identity: ExtensionIdentity =
        serde_json::from_str(EMBEDDED_EXTENSION_IDENTITY).map_err(|_| {
            DesktopSetupError::UnsafeInstallation(
                "The packaged Chrome extension identity is invalid.".to_owned(),
            )
        })?;
    let derived_extension_id = extension_id_from_manifest_key(&identity.manifest_key);
    let id_is_valid = identity.extension_id.len() == 32
        && identity
            .extension_id
            .bytes()
            .all(|byte| (b'a'..=b'p').contains(&byte));
    if identity.protocol != EXTENSION_IDENTITY_PROTOCOL
        || identity.extension_id != CHROME_EXTENSION_ID
        || derived_extension_id.as_deref() != Some(CHROME_EXTENSION_ID)
        || identity.origin != CHROME_EXTENSION_ORIGIN
        || identity.origin != format!("chrome-extension://{}/", identity.extension_id)
        || !id_is_valid
    {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The packaged Chrome extension identity does not match the reviewed Desktop contract."
                .to_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct NativeMessagingManifest {
    name: String,
    description: String,
    path: String,
    #[serde(rename = "type")]
    host_type: String,
    allowed_origins: Vec<String>,
}

pub fn expected_native_messaging_manifest(
    installed_host: &Path,
) -> Result<Vec<u8>, DesktopSetupError> {
    verify_embedded_extension_identity()?;
    if !installed_host.is_absolute() {
        return Err(DesktopSetupError::UnsafeInstallation(
            "The fixed browser host path is not absolute.".to_owned(),
        ));
    }
    let path = installed_host.to_str().ok_or_else(|| {
        DesktopSetupError::UnsafeInstallation(
            "The fixed browser host path is not valid Unicode.".to_owned(),
        )
    })?;
    let manifest = NativeMessagingManifest {
        name: BROWSER_HOST_NAME.to_owned(),
        description: BROWSER_HOST_DESCRIPTION.to_owned(),
        path: path.to_owned(),
        host_type: "stdio".to_owned(),
        allowed_origins: vec![CHROME_EXTENSION_ORIGIN.to_owned()],
    };
    let mut bytes = serde_json::to_vec_pretty(&manifest).map_err(|_| {
        DesktopSetupError::InstallationFailed(
            "The fixed Chrome Native Messaging manifest could not be encoded.".to_owned(),
        )
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_extension_identity_and_manifest_are_exact() {
        verify_embedded_extension_identity().expect("extension identity");
        let identity: ExtensionIdentity =
            serde_json::from_str(EMBEDDED_EXTENSION_IDENTITY).expect("identity json");
        assert_eq!(
            extension_id_from_manifest_key(&identity.manifest_key).as_deref(),
            Some(CHROME_EXTENSION_ID)
        );
        let manifest = expected_native_messaging_manifest(Path::new(
            "/Users/example/.greenways/bin/greenways-browser-bridge-host",
        ))
        .expect("manifest");
        let value: serde_json::Value = serde_json::from_slice(&manifest).expect("manifest json");
        assert_eq!(value["name"], BROWSER_HOST_NAME);
        assert_eq!(value["type"], "stdio");
        assert_eq!(value["allowed_origins"].as_array().map(Vec::len), Some(1));
        assert_eq!(value["allowed_origins"][0], CHROME_EXTENSION_ORIGIN);
        assert!(!String::from_utf8(manifest).expect("text").contains("gwc_"));
    }
}
