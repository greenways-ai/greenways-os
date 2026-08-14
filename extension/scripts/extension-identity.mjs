import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const EXTENSION_IDENTITY_PROTOCOL = "greenways-chrome-extension-identity/0-alpha";
const EXTENSION_ID = /^[a-p]{32}$/;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;
const MANIFEST_KEY = /^[A-Za-z0-9+/]+={0,2}$/;

export function extensionIdFromManifestKey(manifestKey) {
  if (typeof manifestKey !== "string" || !MANIFEST_KEY.test(manifestKey)) {
    throw new Error("Chrome extension manifest key is invalid");
  }
  const publicKey = Buffer.from(manifestKey, "base64");
  if (publicKey.length < 64 || publicKey.toString("base64") !== manifestKey) {
    throw new Error("Chrome extension manifest key is not canonical public-key DER");
  }
  const prefix = createHash("sha256").update(publicKey).digest("hex").slice(0, 32);
  return prefix.replace(/[0-9a-f]/g, (value) => "abcdefghijklmnop"[Number.parseInt(value, 16)]);
}

export async function readExtensionIdentity(extensionRoot) {
  const identity = JSON.parse(await readFile(join(extensionRoot, "extension-identity.json"), "utf8"));
  const keys = Object.keys(identity).sort();
  const expectedKeys = ["extensionId", "manifestKey", "origin", "protocol"].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("Chrome extension identity has unexpected fields");
  }
  if (identity.protocol !== EXTENSION_IDENTITY_PROTOCOL
      || !EXTENSION_ID.test(identity.extensionId)
      || !EXTENSION_ORIGIN.test(identity.origin)
      || identity.extensionId !== extensionIdFromManifestKey(identity.manifestKey)
      || identity.origin !== `chrome-extension://${identity.extensionId}/`) {
    throw new Error("Chrome extension identity is inconsistent");
  }
  return identity;
}

export async function verifyManifestIdentity(extensionRoot, manifest) {
  const identity = await readExtensionIdentity(extensionRoot);
  if (manifest?.key !== identity.manifestKey
      || extensionIdFromManifestKey(manifest.key) !== identity.extensionId) {
    throw new Error("Chrome extension manifest identity drifted");
  }
  return identity;
}
