import { CHATGPT_LOGIN_METHODS, createChatgptLoginService } from "./chatgpt-login-service.js";
import { createChatgptService } from "./chatgpt-service.js";
import { createDebuggerCoordinator, createDomService } from "./dom-service.js";
import { createDomExistenceProbe } from "./dom-existence-probe.js";

const debuggerEvents = new Map();
const debuggerCoordinator = createDebuggerCoordinator(chrome);
let nextPort = 1;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "hara-host") return;
  const portOwner = `hara-host-${nextPort++}`;
  const chromeDebuggerOwner = `${portOwner}:chrome-debugger`;
  const domService = createDomService({
    chromeApi: chrome,
    coordinator: debuggerCoordinator,
    owner: portOwner,
  });
  const chatgptService = createChatgptService({ domService });
  const domExistenceProbe = createDomExistenceProbe({
    coordinator: debuggerCoordinator,
    owner: portOwner,
  });
  const loginDomService = {
    dispatch: (method, args, target) => method === "query-exists"
      ? domExistenceProbe.dispatch(method, args, target)
      : domService.dispatch(method, args, target),
  };
  const chatgptLoginService = createChatgptLoginService({
    domService: loginDomService,
    chatgptService,
  });

  port.onMessage.addListener(async ({ id, service, method, args, target }) => {
    try {
      const value = await dispatch(service, method, args ?? [], target, {
        chromeDebuggerOwner,
        domService,
        chatgptService,
        chatgptLoginService,
      });
      port.postMessage({ id, ok: true, value: sanitize(value) });
    } catch (error) {
      port.postMessage({
        id,
        ok: false,
        error: String(error?.message ?? error),
        code: error?.code ?? null,
      });
    }
  });

  port.onDisconnect.addListener(() => {
    for (const entry of debuggerEvents.values()) {
      for (const waiter of entry.waiters) waiter.reject(new Error("hara host disconnected"));
      entry.waiters = [];
    }
    void Promise.allSettled([
      chatgptLoginService.close(),
      chatgptService.close(),
      domExistenceProbe.close(),
      domService.close(),
      debuggerCoordinator.releaseOwner(chromeDebuggerOwner),
    ]);
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const entry = debuggerEvents.get(source.tabId) ?? { queue: [], waiters: [] };
  const waiter = entry.waiters.shift();
  if (waiter) waiter.resolve({ method, params });
  else entry.queue.push({ method, params });
  debuggerEvents.set(source.tabId, entry);
});

chrome.debugger.onDetach.addListener((source) => {
  const entry = debuggerEvents.get(source.tabId);
  if (!entry) return;
  debuggerEvents.delete(source.tabId);
  for (const waiter of entry.waiters) waiter.reject(new Error("debugger detached"));
});

async function dispatch(service, method, args, target, context) {
  if (service === "hara" && method === "echo") return args[0] ?? null;
  if (service === "hara.dom") return context.domService.dispatch(method, args, target);
  if (service === "hara.chatgpt") {
    const owner = CHATGPT_LOGIN_METHODS.has(method)
      ? context.chatgptLoginService
      : context.chatgptService;
    return owner.dispatch(method, args, target);
  }
  if (service === "chrome.debugger") {
    return debuggerCall(method, args, context.chromeDebuggerOwner);
  }
  if (!service.startsWith("chrome.")) {
    throw new Error(`host-call-denied: ${service}`);
  }
  const owner = service
    .slice("chrome.".length)
    .split(".")
    .reduce((value, key) => value?.[key], chrome);
  const fn = owner?.[method];
  if (typeof fn !== "function") {
    throw new Error(`unknown chrome api: ${service}/${method}`);
  }
  return (await fn.apply(owner, args)) ?? null;
}

/** HTA0 has no float tag; coerce non-safe-integer numbers so results survive encoding. */
function sanitize(value) {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value)) return value;
    return Number.isFinite(value) ? Math.trunc(value) : 0;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  }
  return value;
}

async function debuggerCall(method, args, owner) {
  const [tabId, ...rest] = args;
  switch (method) {
    case "attach":
      await debuggerCoordinator.acquire(tabId, owner);
      return null;
    case "detach":
      await debuggerCoordinator.release(tabId, owner);
      return null;
    case "sendCommand": {
      const [command, params] = rest;
      return (await debuggerCoordinator.send(tabId, command, params ?? {})) ?? null;
    }
    case "next-event": {
      const entry = debuggerEvents.get(tabId) ?? { queue: [], waiters: [] };
      const queued = entry.queue.shift();
      if (queued) return queued;
      return new Promise((resolve, reject) => {
        entry.waiters.push({ resolve, reject });
        debuggerEvents.set(tabId, entry);
      });
    }
    default:
      throw new Error(`unknown chrome.debugger method: ${method}`);
  }
}
