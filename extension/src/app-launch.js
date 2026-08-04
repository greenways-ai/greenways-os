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

export function sameManifestApproval(approved, current = getAppManifest(approved?.id)) {
  if (!approved || !current) return false;
  const approvedCapabilities = [...(approved.capabilities ?? [])].sort();
  const currentCapabilities = [...(current.capabilities ?? [])].sort();
  return approved.id === current.id
    && approved.version === current.version
    && approved.publisher?.id === current.publisher?.id
    && approved.launch?.handler === current.launch?.handler
    && approved.launch?.path === current.launch?.path
    && approved.launch?.url === current.launch?.url
    && approved.launch?.surfaceId === current.launch?.surfaceId
    && JSON.stringify(approvedCapabilities) === JSON.stringify(currentCapabilities);
}
