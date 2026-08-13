export const BROWSER_BRIDGE_PROTOCOL = "greenways-browser-bridge/0-alpha";
export const BROWSER_BRIDGE_RESULT_PROTOCOL = "greenways-browser-bridge-result/0-alpha";
export const BROWSER_BRIDGE_STATUS_PROTOCOL = "greenways-browser-bridge-status/0-alpha";
export const BROWSER_BRIDGE_NATIVE_HOST = "ai.greenways.browser_bridge";

const COMMANDS = new Set(["connect", "status", "disconnect"]);
const STATES = new Set([
  "connecting",
  "connected",
  "daemon-unavailable",
  "credential-unavailable",
  "authentication-rejected",
  "session-expired",
  "protocol-mismatch",
  "native-host-unavailable",
  "disconnected",
]);
const REQUEST_ID = /^bridge\/request\/[A-Za-z0-9._:-]{8,160}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_MESSAGE_BYTES = 1024 * 1024;

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function boundedText(value, maximum = 400) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/\p{C}/u.test(value);
}

function nullableObject(value) {
  return value === null || (value && typeof value === "object" && !Array.isArray(value));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validateError(value) {
  if (value === null) return null;
  if (!exactKeys(value, ["code", "message"])
      || !STATES.has(value.code)
      || !boundedText(value.message)) {
    throw new Error("Browser bridge error projection is invalid");
  }
  return Object.freeze({ code: value.code, message: value.message });
}

function validateDaemon(value) {
  if (value === null) return null;
  if (!exactKeys(value, [
    "protocol", "nodeId", "daemonVersion", "localProtocol", "generation",
    "stateRevision", "startedAtUnixMs", "observedAtUnixMs", "profileMode",
    "authorityMode",
  ])
      || value.protocol !== "greenways-daemon-status/0-alpha"
      || !boundedText(value.nodeId, 160)
      || !boundedText(value.daemonVersion, 80)
      || !boundedText(value.localProtocol, 120)
      || !positiveInteger(value.generation)
      || !Number.isSafeInteger(value.stateRevision)
      || value.stateRevision < 0
      || !positiveInteger(value.startedAtUnixMs)
      || !positiveInteger(value.observedAtUnixMs)
      || !boundedText(value.profileMode, 80)
      || !boundedText(value.authorityMode, 80)) {
    throw new Error("Browser bridge daemon projection is invalid");
  }
  return Object.freeze({
    protocol: value.protocol,
    nodeId: value.nodeId,
    daemonVersion: value.daemonVersion,
    localProtocol: value.localProtocol,
    generation: value.generation,
    stateRevision: value.stateRevision,
    startedAtUnixMs: value.startedAtUnixMs,
    observedAtUnixMs: value.observedAtUnixMs,
    profileMode: value.profileMode,
    authorityMode: value.authorityMode,
  });
}

function validateActor(value) {
  if (value === null) return null;
  if (!exactKeys(value, [
    "protocol", "id", "role", "label", "createdAtUnixMs", "revokedAtUnixMs",
  ])
      || value.protocol !== "greenways-local-client/0-alpha"
      || !boundedText(value.id, 160)
      || value.role !== "browser-bridge"
      || !boundedText(value.label, 120)
      || !positiveInteger(value.createdAtUnixMs)
      || value.revokedAtUnixMs !== null) {
    throw new Error("Browser bridge actor projection is invalid");
  }
  return Object.freeze({
    protocol: value.protocol,
    id: value.id,
    role: value.role,
    label: value.label,
    createdAtUnixMs: value.createdAtUnixMs,
    revokedAtUnixMs: null,
  });
}

function validateIdentity(value) {
  if (value === null) return null;
  if (!exactKeys(value, [
    "protocol", "id", "handle", "keyId", "algorithm", "createdAtUnixMs",
  ])
      || value.protocol !== "greenways-profile-identity/0-alpha"
      || !boundedText(value.id, 160)
      || !boundedText(value.handle, 80)
      || !DIGEST.test(value.keyId)
      || !boundedText(value.algorithm, 80)
      || !positiveInteger(value.createdAtUnixMs)) {
    throw new Error("Browser bridge identity projection is invalid");
  }
  return Object.freeze({
    protocol: value.protocol,
    id: value.id,
    handle: value.handle,
    keyId: value.keyId,
    algorithm: value.algorithm,
    createdAtUnixMs: value.createdAtUnixMs,
  });
}

function validateSession(value) {
  if (value === null) return null;
  if (!exactKeys(value, [
    "protocol", "clientId", "role", "label", "openedAtUnixMs",
    "expiresAtUnixMs", "remainingRequests",
  ])
      || value.protocol !== "greenways-local-session/0-alpha"
      || !boundedText(value.clientId, 160)
      || value.role !== "browser-bridge"
      || !boundedText(value.label, 120)
      || !positiveInteger(value.openedAtUnixMs)
      || !positiveInteger(value.expiresAtUnixMs)
      || value.expiresAtUnixMs <= value.openedAtUnixMs
      || !Number.isSafeInteger(value.remainingRequests)
      || value.remainingRequests < 0
      || value.remainingRequests > 1024) {
    throw new Error("Browser bridge session projection is invalid");
  }
  return Object.freeze({
    protocol: value.protocol,
    clientId: value.clientId,
    role: value.role,
    label: value.label,
    openedAtUnixMs: value.openedAtUnixMs,
    expiresAtUnixMs: value.expiresAtUnixMs,
    remainingRequests: value.remainingRequests,
  });
}

export function validateBridgeStatus(value) {
  if (!exactKeys(value, [
    "protocol", "state", "daemon", "actor", "identity", "session", "error",
    "observedAtUnixMs",
  ])
      || value.protocol !== BROWSER_BRIDGE_STATUS_PROTOCOL
      || !STATES.has(value.state)
      || !positiveInteger(value.observedAtUnixMs)) {
    throw new Error("Browser bridge status is invalid");
  }
  const status = Object.freeze({
    protocol: value.protocol,
    state: value.state,
    daemon: validateDaemon(value.daemon),
    actor: validateActor(value.actor),
    identity: validateIdentity(value.identity),
    session: validateSession(value.session),
    error: validateError(value.error),
    observedAtUnixMs: value.observedAtUnixMs,
  });
  if (status.state === "connected"
      && (!status.daemon || !status.actor || !status.session || status.error)) {
    throw new Error("Connected browser bridge status is incomplete");
  }
  if (status.state !== "connected"
      && (status.daemon || status.actor || status.identity || status.session)) {
    throw new Error("Disconnected browser bridge status projects stale authority");
  }
  return status;
}

function emptyStatus(state = "disconnected", error = null) {
  return Object.freeze({
    protocol: BROWSER_BRIDGE_STATUS_PROTOCOL,
    state,
    daemon: null,
    actor: null,
    identity: null,
    session: null,
    error,
    observedAtUnixMs: Date.now(),
  });
}

export function classifyNativeDisconnect(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("native messaging host not found")
    || text.includes("specified native messaging host not found")
    || text.includes("host is not registered")
    ? "native-host-unavailable"
    : "disconnected";
}

function requestId(random = globalThis.crypto) {
  if (typeof random?.randomUUID !== "function") {
    throw new Error("Secure request identity is unavailable");
  }
  return `bridge/request/${random.randomUUID().replaceAll("-", "")}`;
}

function encodedSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export class DaemonNativeBridge {
  constructor({
    runtime = globalThis.chrome?.runtime,
    host = BROWSER_BRIDGE_NATIVE_HOST,
    random = globalThis.crypto,
    requestTimeoutMs = 10_000,
  } = {}) {
    if (!runtime || typeof runtime.connectNative !== "function") {
      throw new TypeError("Daemon bridge requires chrome.runtime.connectNative");
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 60_000) {
      throw new TypeError("Daemon bridge request timeout is invalid");
    }
    this.runtime = runtime;
    this.host = host;
    this.random = random;
    this.requestTimeoutMs = requestTimeoutMs;
    this.port = null;
    this.pending = new Map();
    this.listeners = new Set();
    this.statusValue = emptyStatus();
  }

  snapshot() {
    return this.statusValue;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Connection listener must be a function");
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  setStatus(status) {
    this.statusValue = status;
    for (const listener of this.listeners) listener(status);
    return status;
  }

  ensurePort() {
    if (this.port) return this.port;
    let port;
    try {
      port = this.runtime.connectNative(this.host);
    } catch (error) {
      const state = classifyNativeDisconnect(error?.message);
      this.setStatus(emptyStatus(state, Object.freeze({
        code: state,
        message: error?.message || "The Greenways browser bridge host is unavailable.",
      })));
      throw error;
    }
    if (!port?.onMessage?.addListener
        || !port?.onDisconnect?.addListener
        || typeof port.postMessage !== "function"
        || typeof port.disconnect !== "function") {
      throw new Error("Native browser bridge returned an invalid port");
    }
    this.port = port;
    port.onMessage.addListener((message) => this.onMessage(message));
    port.onDisconnect.addListener(() => this.onDisconnect());
    return port;
  }

  request(command) {
    if (!COMMANDS.has(command)) throw new TypeError("Daemon bridge command is not supported");
    const id = requestId(this.random);
    const message = {
      protocol: BROWSER_BRIDGE_PROTOCOL,
      type: "request",
      id,
      command,
    };
    if (encodedSize(message) > MAX_MESSAGE_BYTES) throw new Error("Daemon bridge request is oversized");
    const port = this.ensurePort();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Greenways browser bridge request timed out"));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        port.postMessage(message);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async connect() {
    this.setStatus(emptyStatus("connecting"));
    return this.request("connect");
  }

  async refresh() {
    return this.request("status");
  }

  async disconnect() {
    if (!this.port) return this.setStatus(emptyStatus());
    try {
      await this.request("disconnect");
    } finally {
      const port = this.port;
      this.port = null;
      port?.disconnect();
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Greenways browser bridge disconnected"));
      }
      this.pending.clear();
      this.setStatus(emptyStatus());
    }
    return this.snapshot();
  }

  onMessage(message) {
    let oversized = false;
    try { oversized = encodedSize(message) > MAX_MESSAGE_BYTES; } catch { oversized = true; }
    if (oversized
        || !exactKeys(message, ["protocol", "type", "id", "ok", "status", "error"])
        || message.protocol !== BROWSER_BRIDGE_RESULT_PROTOCOL
        || message.type !== "response"
        || !REQUEST_ID.test(message.id)
        || typeof message.ok !== "boolean") {
      const error = new Error("The Native Messaging host returned an invalid response.");
      if (REQUEST_ID.test(message?.id ?? "")) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending.reject(error);
        }
      }
      this.setStatus(emptyStatus("protocol-mismatch", Object.freeze({
        code: "protocol-mismatch",
        message: error.message,
      })));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    try {
      const status = validateBridgeStatus(message.status);
      this.setStatus(status);
      if (message.ok) pending.resolve(status);
      else pending.reject(Object.assign(
        new Error(message.error?.message || "Greenways browser bridge request failed"),
        { code: message.error?.code || "protocol-mismatch" },
      ));
    } catch (error) {
      const status = emptyStatus("protocol-mismatch", Object.freeze({
        code: "protocol-mismatch",
        message: error?.message || "The Native Messaging response is invalid.",
      }));
      this.setStatus(status);
      pending.reject(error);
    }
  }

  onDisconnect() {
    const message = this.runtime.lastError?.message;
    const state = classifyNativeDisconnect(message);
    this.port = null;
    for (const pending of this.pending.values()) {
      pending.reject(new Error(message || "Greenways browser bridge disconnected"));
    }
    this.pending.clear();
    this.setStatus(emptyStatus(state, state === "native-host-unavailable"
      ? Object.freeze({ code: state, message: "Install the Greenways browser bridge for this extension." })
      : null));
  }
}
