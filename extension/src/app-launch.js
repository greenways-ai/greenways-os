import { getAppManifest } from "./app-catalog.js";

function extensionPageUrl(path, runtime) {
  const normalized = String(path || "").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) throw new Error("Invalid bundled app path");
  return runtime.getURL(normalized);
}

export function resolveAppUrl(appId, runtime = globalThis.chrome?.runtime) {
  if (!runtime) throw new Error("Extension runtime is unavailable");
  const manifest = getAppManifest(appId);
  if (!manifest) throw new Error(`Unknown Greenways app: ${appId}`);

  const launch = manifest.launch || {};
  if (launch.handler === "extension-page") return extensionPageUrl(launch.path, runtime);
  if (launch.handler === "web-tab") return new URL(launch.url).href;
  if (launch.handler === "native-hybrid") {
    if (launch.path) return extensionPageUrl(launch.path, runtime);
    if (launch.url) return new URL(launch.url).href;
  }
  throw new Error(`${manifest.name} opens inside the Greenways launcher`);
}

export function appApprovalIdentity(manifest) {
  if (!manifest) return null;
  const capabilities = [...(manifest.capabilities ?? [])].sort();
  if (manifest.launch?.handler === "hal-module") {
    return Object.freeze({
      id: manifest.id,
      version: manifest.version,
      publisherId: manifest.publisher?.id,
      capabilities,
      handler: "hal-module",
      lockDigest: manifest.lockDigest,
    });
  }
  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    publisherId: manifest.publisher?.id,
    capabilities,
    handler: manifest.launch?.handler,
    path: manifest.launch?.path,
    url: manifest.launch?.url,
    surfaceId: manifest.launch?.surfaceId,
    projectDigest: manifest.project?.digest,
  });
}

export function sameManifestApproval(approved, current = getAppManifest(approved?.id)) {
  if (!approved || !current) return false;
  return JSON.stringify(appApprovalIdentity(approved)) === JSON.stringify(appApprovalIdentity(current));
}
