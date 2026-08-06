import { SYSTEM_APP_IDS, getAppManifest } from "./app-catalog.js";
import { resolveAppUrl, sameManifestApproval } from "./app-launch.js";
import {
  BrowserKernelHost,
  KERNEL_PROTOCOL,
  serializeKernelError,
} from "./kernel-host.js";
import { moduleStore, store } from "./storage.js";

export { resolveAppUrl } from "./app-launch.js";

export const KERNEL_MESSAGE_TYPES = Object.freeze({
  ATTACH: "greenways/kernel/attach",
  CALL: "greenways/kernel/call",
  DISPATCH: "greenways/kernel/dispatch",
});

const LEGACY_APP_PATHS = new Map([
  ["greenways/open-studio", "src/studio.html#home"],
  ["greenways/open-world", "src/world.html"],
]);
const SYSTEM_IDS = new Set(SYSTEM_APP_IDS);
const PAGE_ROLES = new Map([
  ["/src/launcher.html", "launcher"],
  ["/src/world.html", "world"],
  ["/src/studio.html", "home"],
  ["/src/sidepanel.html", "home"],
]);
const KERNEL_TYPES = new Set(Object.values(KERNEL_MESSAGE_TYPES));
const ALLOWED_CONTEXT_TYPES = new Set(["TAB", "SIDE_PANEL"]);

let defaultHostPromise;

export function createInstalledAppChecker(appStore = store) {
  if (!appStore || typeof appStore.get !== "function") {
    throw new TypeError("Installed app checker requires an app store");
  }
  return async (appId) => {
    const manifest = getAppManifest(appId);
    if (!manifest) return false;
    if (SYSTEM_IDS.has(manifest.id)) return true;
    const installed = await appStore.get("apps", manifest.id);
    return sameManifestApproval(installed, manifest);
  };
}

const isInstalledByDefault = createInstalledAppChecker();

function extensionPageUrl(path, runtime) {
  const normalized = String(path || "").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) throw new Error("Invalid bundled app path");
  return runtime.getURL(normalized);
}

function messageUrl(message, runtime) {
  const legacyPath = LEGACY_APP_PATHS.get(message?.type);
  if (legacyPath) return extensionPageUrl(legacyPath, runtime);
  if (message?.type === "greenways/open-app") return resolveAppUrl(message.appId, runtime);
  return null;
}

function sameExtensionUrl(value, runtime) {
  let senderUrl;
  let root;
  try {
    senderUrl = new URL(value);
    root = new URL(runtime.getURL("/"));
  } catch {
    return null;
  }
  if (senderUrl.protocol !== root.protocol || senderUrl.host !== root.host) return null;
  return senderUrl;
}

export async function principalFromSender(sender, message, runtime = globalThis.chrome?.runtime) {
  if (!runtime || sender?.id !== runtime.id) throw new Error("Kernel caller is not this extension");
  if (sender.frameId !== undefined && sender.frameId !== 0) throw new Error("Kernel calls require a top-level extension page");
  if (sender.tab?.incognito) throw new Error("Greenways OS does not share a kernel with incognito pages");
  if (typeof sender.documentId !== "string" || !sender.documentId) throw new Error("Kernel caller has no active document identity");
  const url = sameExtensionUrl(sender.url, runtime);
  const kind = url && PAGE_ROLES.get(url.pathname);
  if (!kind) throw new Error("This packaged page is not a kernel caller");
  if (runtime.getContexts) {
    const contexts = await runtime.getContexts({ documentIds: [sender.documentId] });
    const current = contexts.filter((context) => (
      context.documentId === sender.documentId
      && ALLOWED_CONTEXT_TYPES.has(context.contextType)
      && !context.incognito
    ));
    if (current.length !== 1) throw new Error("Kernel caller is not an active extension context");
  }
  if (message?.clientKind !== undefined && message.clientKind !== kind) {
    throw new Error("Kernel client role does not match its packaged page");
  }
  const clientId = `document/${sender.documentId}`;
  if (
    KERNEL_TYPES.has(message?.type)
    && message.type !== KERNEL_MESSAGE_TYPES.ATTACH
    && message.contextId !== clientId
  ) {
    throw new Error("Kernel context does not match its active browser document");
  }
  return { kind, clientId };
}

export function createKernelHost({
  runtime = globalThis.chrome?.runtime,
  tabs = globalThis.chrome?.tabs,
  modules = moduleStore,
} = {}) {
  if (!modules || typeof modules.values !== "function") {
    throw new TypeError("Kernel host requires a durable module repository");
  }
  return import("./greenways-runtime.js")
    .then(async ({ createGreenwaysInvoker, restoreGreenwaysModules }) => {
      const [invoke, records] = await Promise.all([
        createGreenwaysInvoker(),
        modules.values(),
      ]);
      const restored = await restoreGreenwaysModules(records);
      for (const failure of restored.failures) {
        console.warn(`Stored HAL module ${failure.id ?? "<unknown>"} failed boot verification`, failure.error);
      }
      return new BrowserKernelHost({ invoke, runtime, tabs });
    });
}

function defaultKernelHost(options) {
  if (!defaultHostPromise) defaultHostPromise = createKernelHost(options);
  return defaultHostPromise;
}

function kernelResponse(host, message, principal) {
  if (message.protocol !== KERNEL_PROTOCOL) throw new Error("Kernel message protocol is not supported");
  if (message.type === KERNEL_MESSAGE_TYPES.ATTACH) return host.attach(principal);
  if (message.type === KERNEL_MESSAGE_TYPES.CALL) return host.call(principal, message.method, message.args ?? []);
  if (message.type === KERNEL_MESSAGE_TYPES.DISPATCH) {
    return host.dispatch(principal, {
      requestId: message.requestId,
      method: message.method,
      args: message.args ?? [],
      expectedGlobalRevision: message.expectedGlobalRevision,
      expectedContextRevision: message.expectedContextRevision,
    });
  }
  throw new Error("Unknown kernel message type");
}

export function createMessageHandler({
  runtime = globalThis.chrome?.runtime,
  tabs = globalThis.chrome?.tabs,
  isAppInstalled = isInstalledByDefault,
  getKernelHost = () => defaultKernelHost({ runtime, tabs }),
  identify = principalFromSender,
} = {}) {
  if (typeof isAppInstalled !== "function") throw new TypeError("App installation checker must be a function");
  if (typeof getKernelHost !== "function") throw new TypeError("Kernel host resolver must be a function");
  return (message, sender, sendResponse) => {
    const kernel = KERNEL_TYPES.has(message?.type);
    const legacy = LEGACY_APP_PATHS.has(message?.type) || message?.type === "greenways/open-app";
    if (!kernel && !legacy) return false;

    Promise.resolve()
      .then(async () => {
        const principal = await identify(sender, message, runtime);
        if (kernel) {
          if (!['launcher', 'world'].includes(principal.kind)) throw new Error("This page cannot use the Hara kernel");
          return kernelResponse(await getKernelHost(), message, principal);
        }
        if (message.type === "greenways/open-app") {
          if (principal.kind !== "launcher") throw new Error("Only the launcher can open installed apps");
          const manifest = getAppManifest(message.appId);
          if (!manifest) throw new Error(`Unknown Greenways app: ${message.appId}`);
          if (!SYSTEM_IDS.has(manifest.id) && !await isAppInstalled(manifest.id)) {
            throw new Error(`${manifest.name} is not installed`);
          }
        } else if (principal.kind !== "home") {
          throw new Error("Legacy system navigation is available only to Greenways Home");
        }
        const url = messageUrl(message, runtime);
        const tab = await tabs.create({ url });
        return { ok: true, tabId: tab?.id ?? null };
      })
      .then(sendResponse)
      .catch((error) => sendResponse(kernel ? serializeKernelError(error) : {
        ok: false,
        error: error?.message || String(error),
      }));
    return true;
  };
}

if (globalThis.chrome?.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(async () => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });
}

if (globalThis.chrome?.runtime?.onMessage) {
  // Listener registration is synchronous. Hara and its bundled Wasm initialize
  // behind the first request without leaving a cold-start message gap.
  chrome.runtime.onMessage.addListener(createMessageHandler());
}
