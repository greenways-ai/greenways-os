import { HtaKeyword, HtaSymbol, HtaHandle } from "../vendor/hta.js";

/** HTA value -> JSON-safe value for chrome.runtime Port messaging. */
export function toPlain(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof HtaKeyword) return `:${value.name}`;
  if (value instanceof HtaSymbol) return value.name;
  if (value instanceof HtaHandle) return String(value);
  if (value instanceof Map) {
    const out = {};
    for (const [key, item] of value) {
      const plainKey = key instanceof HtaKeyword ? key.name : String(toPlain(key));
      out[plainKey] = toPlain(item);
    }
    return out;
  }
  if (value instanceof Set) return [...value].map(toPlain);
  if (Array.isArray(value)) return value.map(toPlain);
  if (value instanceof Uint8Array) return [...value];
  if (typeof value === "bigint") return Number(value);
  return value;
}

/** JSON value -> HTA-compatible value (objects become keyword-keyed Maps). */
export function fromPlain(value) {
  if (Array.isArray(value)) return value.map(fromPlain);
  if (value !== null && typeof value === "object") {
    return new Map(
      Object.entries(value).map(([key, item]) => [new HtaKeyword(key), fromPlain(item)]),
    );
  }
  return value;
}

/**
 * Dynamic hostCalls map: any "service/method" key becomes a function that
 * forwards the call over the extension Port and resolves with the reply.
 * Every call carries the exact panel-bound tab metadata; closed services such
 * as hara.dom consume it while the legacy chrome.* facade remains unchanged.
 */
export function createHostCalls(port, { tabId = null } = {}) {
  const pending = new Map();
  let next = 1;
  const target = { tabId: Number(tabId) };
  port.onMessage.addListener(({ id, ok, value, error, code }) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) {
      entry.resolve(fromPlain(value));
    } else {
      const cause = new Error(error ?? "host call failed");
      if (code) cause.code = code;
      entry.reject(cause);
    }
  });
  port.onDisconnect.addListener(() => {
    for (const entry of pending.values()) entry.reject(new Error("hara host disconnected"));
    pending.clear();
  });
  return new Proxy({}, {
    get: (_target, key) => {
      const text = String(key);
      const split = text.lastIndexOf("/");
      const service = text.slice(0, split);
      const method = text.slice(split + 1);
      return (...args) =>
        new Promise((resolve, reject) => {
          const id = next++;
          pending.set(id, { resolve, reject });
          port.postMessage({
            id,
            service,
            method,
            args: args.map(toPlain),
            target,
          });
        });
    },
  });
}

/**
 * Merge a concrete hostCalls map (e.g. the studio `createHostServices()`
 * output) with a dynamic fallback (e.g. the port proxy from
 * `createHostCalls`). A plain spread cannot do this — the fallback Proxy has
 * no enumerable own keys, so `{ ...services, ...portCalls }` would silently
 * drop every chrome.* call. Lookup order: primary's own keys win, anything
 * else falls through to the fallback.
 */
export function mergeHostCalls(primary, fallback) {
  return new Proxy(primary, {
    get: (target, key) => (key in target ? target[key] : fallback[key]),
  });
}
