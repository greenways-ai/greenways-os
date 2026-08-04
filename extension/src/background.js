import { SYSTEM_APP_IDS, getAppManifest } from "./app-catalog.js";
import { store } from "./storage.js";

const LEGACY_APP_PATHS = new Map([
  ["greenways/open-studio", "src/studio.html#home"],
  ["greenways/open-world", "src/world.html"],
]);
const SYSTEM_IDS = new Set(SYSTEM_APP_IDS);

export function createInstalledAppChecker(appStore = store) {
  if (!appStore || typeof appStore.get !== "function") {
    throw new TypeError("Installed app checker requires an app store");
  }
  return async (appId) => {
    const manifest = getAppManifest(appId);
    if (!manifest) return false;
    if (SYSTEM_IDS.has(manifest.id)) return true;
    const installed = await appStore.get("apps", manifest.id);
    return installed?.id === manifest.id;
  };
}

const isInstalledByDefault = createInstalledAppChecker();

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

function messageUrl(message, runtime) {
  const legacyPath = LEGACY_APP_PATHS.get(message?.type);
  if (legacyPath) return extensionPageUrl(legacyPath, runtime);
  if (message?.type === "greenways/open-app") return resolveAppUrl(message.appId, runtime);
  return null;
}

export function createMessageHandler({
  runtime = globalThis.chrome?.runtime,
  tabs = globalThis.chrome?.tabs,
  isAppInstalled = isInstalledByDefault,
} = {}) {
  if (typeof isAppInstalled !== "function") throw new TypeError("App installation checker must be a function");
  return (message, _sender, sendResponse) => {
    const handled = LEGACY_APP_PATHS.has(message?.type) || message?.type === "greenways/open-app";
    if (!handled) return false;

    Promise.resolve()
      .then(async () => {
        if (message.type === "greenways/open-app") {
          const manifest = getAppManifest(message.appId);
          if (!manifest) throw new Error(`Unknown Greenways app: ${message.appId}`);
          if (!SYSTEM_IDS.has(manifest.id) && !await isAppInstalled(manifest.id)) {
            throw new Error(`${manifest.name} is not installed`);
          }
        }
        return messageUrl(message, runtime);
      })
      .then((url) => tabs.create({ url }))
      .then((tab) => sendResponse({ ok: true, tabId: tab?.id ?? null }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  };
}

if (globalThis.chrome?.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(async () => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener(createMessageHandler());
}