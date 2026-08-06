export const DEVTOOLS_BRIDGE_PROTOCOL = "greenways-devtools-bridge/1";
export const DEVTOOLS_NATIVE_HOST = "ai.greenways.devtools";
export const DEVTOOLS_DEFAULT_PORT = 46379;

const REQUEST_ID = /^[a-z0-9][a-z0-9._:/-]{7,127}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const BRIDGE_COMMANDS = new Set(["status", "eval", "call", "modules", "services"]);
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const block = (a << 16) | (b << 8) | c;
    output += BASE64URL[(block >>> 18) & 63];
    output += BASE64URL[(block >>> 12) & 63];
    if (index + 1 < bytes.length) output += BASE64URL[(block >>> 6) & 63];
    if (index + 2 < bytes.length) output += BASE64URL[block & 63];
  }
  return output;
}

function randomToken(random = globalThis.crypto) {
  if (!random?.getRandomValues) throw new Error("Secure randomness is unavailable");
  return base64url(random.getRandomValues(new Uint8Array(32)));
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function bounded(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(`${label} must be JSON serializable`);
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_MESSAGE_BYTES) {
    throw new Error(`${label} exceeds the 1 MB bridge limit`);
  }
  return value;
}

function portNumber(value) {
  const output = value ?? DEVTOOLS_DEFAULT_PORT;
  if (!Number.isSafeInteger(output) || output < 1024 || output > 65535) {
    throw new Error("DevTools RESP port must be between 1024 and 65535");
  }
  return output;
}

function bridgeRequest(value) {
  const input = plainObject(value, "Native DevTools request");
  if (input.protocol !== DEVTOOLS_BRIDGE_PROTOCOL || input.type !== "request") {
    throw new Error("Native DevTools request uses an unsupported protocol");
  }
  if (typeof input.id !== "string" || !REQUEST_ID.test(input.id)) {
    throw new Error("Native DevTools request id is invalid");
  }
  if (typeof input.command !== "string" || !BRIDGE_COMMANDS.has(input.command)) {
    throw new Error("Native DevTools command is not allowlisted");
  }
  bounded(input, "Native DevTools request");
  return input;
}

export class DevtoolsNativeBridge {
  constructor({
    runtime = globalThis.chrome?.runtime,
    host = DEVTOOLS_NATIVE_HOST,
    handleRequest,
    random = globalThis.crypto,
    readyTimeoutMs = 5000,
  } = {}) {
    if (!runtime || typeof runtime.connectNative !== "function") {
      throw new TypeError("DevTools bridge requires chrome.runtime.connectNative");
    }
    if (typeof handleRequest !== "function") throw new TypeError("DevTools bridge requires a request handler");
    if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1 || readyTimeoutMs > 60_000) {
      throw new TypeError("DevTools bridge ready timeout is invalid");
    }
    this.runtime = runtime;
    this.host = host;
    this.handleRequest = handleRequest;
    this.random = random;
    this.readyTimeoutMs = readyTimeoutMs;
    this.nativePort = null;
    this.state = "stopped";
    this.token = null;
    this.port = null;
    this.clients = 0;
    this.error = null;
    this.ready = null;
  }

  snapshot({ revealToken = false } = {}) {
    return Object.freeze({
      protocol: DEVTOOLS_BRIDGE_PROTOCOL,
      state: this.state,
      host: this.host,
      address: this.port === null ? null : "127.0.0.1",
      port: this.port,
      clients: this.clients,
      token: revealToken && this.state === "active" ? this.token : null,
      error: this.error,
    });
  }

  async start({ port } = {}) {
    if (this.state === "active") return this.snapshot({ revealToken: true });
    if (this.state === "starting" && this.ready) return this.ready;
    this.state = "starting";
    this.error = null;
    this.port = portNumber(port);
    this.token = randomToken(this.random);

    let nativePort;
    try {
      nativePort = this.runtime.connectNative(this.host);
    } catch (error) {
      this.state = "failed";
      this.error = error?.message || String(error);
      this.token = null;
      throw error;
    }
    if (!nativePort?.onMessage?.addListener || !nativePort?.onDisconnect?.addListener
      || typeof nativePort.postMessage !== "function" || typeof nativePort.disconnect !== "function") {
      this.state = "failed";
      this.token = null;
      throw new Error("Native DevTools host returned an invalid port");
    }
    this.nativePort = nativePort;
    nativePort.onMessage.addListener((message) => this.onMessage(message));
    nativePort.onDisconnect.addListener(() => this.onDisconnect());

    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.state !== "starting") return;
        this.error = "Native DevTools host did not become ready";
        this.state = "failed";
        this.token = null;
        this.nativePort?.disconnect();
        reject(new Error(this.error));
      }, this.readyTimeoutMs);
      this.resolveReady = (value) => { clearTimeout(timeout); resolve(value); };
      this.rejectReady = (error) => { clearTimeout(timeout); reject(error); };
    }).finally(() => {
      this.ready = null;
      this.resolveReady = null;
      this.rejectReady = null;
    });

    nativePort.postMessage({
      protocol: DEVTOOLS_BRIDGE_PROTOCOL,
      type: "configure",
      address: "127.0.0.1",
      port: this.port,
      token: this.token,
    });
    return this.ready;
  }

  stop() {
    if (this.nativePort) {
      try {
        this.nativePort.postMessage({ protocol: DEVTOOLS_BRIDGE_PROTOCOL, type: "shutdown" });
      } catch {
        // The native port may already be gone.
      }
      this.nativePort.disconnect();
    }
    this.nativePort = null;
    this.state = "stopped";
    this.token = null;
    this.port = null;
    this.clients = 0;
    this.error = null;
    return this.snapshot();
  }

  async onMessage(message) {
    try {
      const input = plainObject(message, "Native DevTools message");
      if (input.protocol !== DEVTOOLS_BRIDGE_PROTOCOL) throw new Error("Native DevTools protocol is unsupported");
      if (input.type === "ready") {
        if (this.state !== "starting") return;
        if (!TOKEN.test(this.token)) throw new Error("DevTools bridge token is invalid");
        if (input.address !== "127.0.0.1" || portNumber(input.port) !== this.port) {
          throw new Error("Native DevTools host reported an unexpected listening endpoint");
        }
        this.clients = Number.isSafeInteger(input.clients) && input.clients >= 0 ? input.clients : 0;
        this.state = "active";
        this.resolveReady?.(this.snapshot({ revealToken: true }));
        return;
      }
      if (input.type === "status") {
        if (Number.isSafeInteger(input.clients) && input.clients >= 0) this.clients = input.clients;
        return;
      }
      if (input.type === "error") {
        const error = new Error(typeof input.error === "string" && input.error ? input.error : "Native DevTools host failed");
        this.error = error.message;
        this.state = "failed";
        this.token = null;
        this.rejectReady?.(error);
        this.nativePort?.disconnect();
        return;
      }
      if (input.type !== "request") throw new Error("Native DevTools message type is unsupported");
      const request = bridgeRequest(input);
      try {
        const result = bounded(await this.handleRequest(request), "DevTools response");
        this.nativePort?.postMessage({
          protocol: DEVTOOLS_BRIDGE_PROTOCOL,
          type: "response",
          id: request.id,
          ok: true,
          result,
        });
      } catch (error) {
        this.nativePort?.postMessage({
          protocol: DEVTOOLS_BRIDGE_PROTOCOL,
          type: "response",
          id: request.id,
          ok: false,
          error: error?.message || String(error),
          code: error?.code || "DEVTOOLS_FAILURE",
        });
      }
    } catch (error) {
      this.error = error?.message || String(error);
      if (this.state === "starting") {
        this.state = "failed";
        this.token = null;
        this.rejectReady?.(error instanceof Error ? error : new Error(this.error));
        this.nativePort?.disconnect();
      }
    }
  }

  onDisconnect() {
    const lastError = this.runtime.lastError?.message;
    const error = lastError || this.error || "Native DevTools host disconnected";
    this.nativePort = null;
    this.clients = 0;
    if (this.state === "starting") this.rejectReady?.(new Error(error));
    if (this.state !== "stopped") {
      this.state = "failed";
      this.error = error;
    }
    this.token = null;
  }
}
