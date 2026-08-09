import { SYSTEM_APP_IDS, getAppManifest } from "./app-catalog.js";
import { resolveAppUrl, sameManifestApproval } from "./app-launch.js";
import { getRootApp, resolveRootAppUrl } from "./root-apps.js";
import { DevtoolsNativeBridge } from "./devtools-bridge.js";
import {
  CapabilityAuthority,
  createVerifiedModuleRuntimeState,
} from "./capability-authority.js";
import {
  BrowserKernelHost,
  KERNEL_PROTOCOL,
  serializeKernelError,
} from "./kernel-host.js";
import { moduleStore, store } from "./storage.js";
import { createUserscriptsRuntime } from "./userscripts-runtime.js";
import { createChatsRuntime } from "./chats-runtime.js";

export { resolveAppUrl } from "./app-launch.js";

export const KERNEL_MESSAGE_TYPES = Object.freeze({
  ATTACH: "greenways/kernel/attach",
  CALL: "greenways/kernel/call",
  DISPATCH: "greenways/kernel/dispatch",
});

export const DEVTOOLS_BRIDGE_MESSAGE_TYPES = Object.freeze({
  STATUS: "greenways/devtools-bridge/status",
  START: "greenways/devtools-bridge/start",
  STOP: "greenways/devtools-bridge/stop",
});

export const ROOT_APP_MESSAGE_TYPE = "greenways/open-root-app";
export const CHATS_CAPTURE_MESSAGE_TYPE = "greenways/chats-observation";

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
  ["/src/devtools.html", "devtools"],
]);
const KERNEL_TYPES = new Set(Object.values(KERNEL_MESSAGE_TYPES));
const DEVTOOLS_BRIDGE_TYPES = new Set(Object.values(DEVTOOLS_BRIDGE_MESSAGE_TYPES));
const ALLOWED_CONTEXT_TYPES = new Set(["TAB", "SIDE_PANEL"]);

let defaultHostPromise;
let defaultBridge;

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
  if (message?.type === ROOT_APP_MESSAGE_TYPE) return resolveRootAppUrl(message.appId, runtime);
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
  userScripts = globalThis.chrome?.userScripts,
  scripting = globalThis.chrome?.scripting,
  modules = moduleStore,
} = {}) {
  if (!modules || typeof modules.values !== "function") {
    throw new TypeError("Kernel host requires a durable module repository");
  }
  return import("./greenways-runtime.js")
    .then(async ({
      createGreenwaysDevtoolsRuntime,
      createGreenwaysInvoker,
      restoreGreenwaysModules,
    }) => {
      const [invoke, records] = await Promise.all([
        createGreenwaysInvoker(),
        modules.values(),
      ]);
      const restored = await restoreGreenwaysModules(records);
      for (const failure of restored.failures) {
        console.warn(`Stored HAL module ${failure.id ?? "<unknown>"} failed boot verification`, failure.error);
      }
      const moduleVerification = createVerifiedModuleRuntimeState(restored.installed);
      const capabilityAuthority = new CapabilityAuthority({
        moduleRepository: modules,
        moduleVerification,
      });
      const devtools = await createGreenwaysDevtoolsRuntime();
      let host;
      const userscripts = createUserscriptsRuntime({
        userScripts,
        assertAuthority: () => host.assertUserscriptsAuthority(),
      });
      const chats = createChatsRuntime({
        scripting,
        assertAuthority: () => host.assertChatsAuthority(),
      });
      host = new BrowserKernelHost({ invoke, runtime, tabs, capabilityAuthority, devtools, userscripts, chats });
      // chrome.userScripts registrations persist across service-worker restarts,
      // but durable records are the source of truth: reconcile drift (for example
      // edits made while Chrome's user-scripts toggle was off) on first use.
      userscripts.syncRegistration().catch((error) => {
        console.warn("Userscript registration reconciliation failed", error);
      });
      return host;
    });
}

function defaultKernelHost(options) {
  if (!defaultHostPromise) defaultHostPromise = createKernelHost(options);
  return defaultHostPromise;
}

const NATIVE_DEVTOOLS_PRINCIPAL = Object.freeze({
  kind: "devtools",
  clientId: "native/devtools-bridge",
});

async function handleNativeDevtoolsRequest(getKernelHost, request) {
  const host = await getKernelHost();
  let method;
  let args;
  if (request.command === "status") {
    method = "devtools/status";
    args = [];
  } else if (request.command === "modules") {
    method = "devtools/modules";
    args = [];
  } else if (request.command === "services") {
    method = "core/services";
    args = [];
  } else if (request.command === "eval") {
    method = "devtools/eval";
    args = [request.payload ?? {}];
  } else if (request.command === "call") {
    method = "devtools/call";
    args = [request.payload?.method, request.payload?.args ?? []];
  } else {
    throw new Error(`Unsupported native DevTools command: ${request.command}`);
  }
  const response = await host.call(NATIVE_DEVTOOLS_PRINCIPAL, method, args);
  return response.value;
}

export function createDevtoolsBridge({
  runtime = globalThis.chrome?.runtime,
  getKernelHost = () => defaultKernelHost({ runtime }),
} = {}) {
  return new DevtoolsNativeBridge({
    runtime,
    handleRequest: (request) => handleNativeDevtoolsRequest(getKernelHost, request),
  });
}

function defaultDevtoolsBridge(options) {
  if (!defaultBridge) defaultBridge = createDevtoolsBridge(options);
  return defaultBridge;
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
  getDevtoolsBridge = () => defaultDevtoolsBridge({ runtime, getKernelHost }),
  identify = principalFromSender,
} = {}) {
  if (typeof isAppInstalled !== "function") throw new TypeError("App installation checker must be a function");
  if (typeof getKernelHost !== "function") throw new TypeError("Kernel host resolver must be a function");
  if (typeof getDevtoolsBridge !== "function") throw new TypeError("DevTools bridge resolver must be a function");
  return (message, sender, sendResponse) => {
    const kernel = KERNEL_TYPES.has(message?.type);
    const bridgeRequest = DEVTOOLS_BRIDGE_TYPES.has(message?.type);
    const rootNavigation = message?.type === ROOT_APP_MESSAGE_TYPE;
    const chatObservation = message?.type === CHATS_CAPTURE_MESSAGE_TYPE;
    const legacyNavigation = LEGACY_APP_PATHS.has(message?.type) || message?.type === "greenways/open-app";
    if (!kernel && !bridgeRequest && !rootNavigation && !legacyNavigation && !chatObservation) return false;

    Promise.resolve()
      .then(async () => {
        if (chatObservation) {
          const origin = new URL(sender?.url ?? "about:blank").origin;
          if (!["https://chatgpt.com", "https://www.chatgpt.com", "https://chat.openai.com"].includes(origin)) {
            throw new Error("Chats observations are accepted only from an approved ChatGPT origin");
          }
          return { ok: true, value: await (await getKernelHost()).captureChatObservation(message.observation) };
        }
        const principal = await identify(sender, message, runtime);
        if (kernel) {
          if (!["launcher", "world", "devtools"].includes(principal.kind)) {
            throw new Error("This page cannot use the Hara kernel");
          }
          return kernelResponse(await getKernelHost(), message, principal);
        }
        if (bridgeRequest) {
          if (principal.kind !== "devtools") throw new Error("Only the root DevTools app can control the RESP bridge");
          const bridge = getDevtoolsBridge();
          if (message.type === DEVTOOLS_BRIDGE_MESSAGE_TYPES.START) {
            return { ok: true, bridge: await bridge.start({ port: message.port }) };
          }
          if (message.type === DEVTOOLS_BRIDGE_MESSAGE_TYPES.STOP) {
            return { ok: true, bridge: bridge.stop() };
          }
          return { ok: true, bridge: bridge.snapshot({ revealToken: true }) };
        }
        if (rootNavigation) {
          if (principal.kind !== "launcher") throw new Error("Only the root shell can open a root app");
          const rootApp = getRootApp(message.appId);
          if (!rootApp) throw new Error(`Unknown Greenways root app: ${message.appId}`);
          const tab = await tabs.create({ url: messageUrl(message, runtime) });
          return { ok: true, tabId: tab?.id ?? null };
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
