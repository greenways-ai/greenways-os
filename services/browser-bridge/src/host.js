import { DaemonBrowserConnection, DaemonBridgeError } from "./daemon-client.js";

export const BROWSER_BRIDGE_PROTOCOL = "greenways-browser-bridge/0-alpha";
export const BROWSER_BRIDGE_RESULT_PROTOCOL = "greenways-browser-bridge-result/0-alpha";
export const BROWSER_BRIDGE_STATUS_PROTOCOL = "greenways-browser-bridge-status/0-alpha";

const REQUEST_ID = /^bridge\/request\/[A-Za-z0-9._:-]{8,160}$/;
const COMMANDS = new Set(["connect", "status", "disconnect"]);
const STATES = new Set([
  "connecting",
  "connected",
  "daemon-unavailable",
  "credential-unavailable",
  "authentication-rejected",
  "session-expired",
  "protocol-mismatch",
  "disconnected",
]);

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

export function validateBridgeRequest(value) {
  if (!exactKeys(value, ["protocol", "type", "id", "command"])
      || value.protocol !== BROWSER_BRIDGE_PROTOCOL
      || value.type !== "request"
      || !REQUEST_ID.test(value.id)
      || !COMMANDS.has(value.command)) {
    throw new DaemonBridgeError("protocol-mismatch", "Native bridge request is not supported.");
  }
  return value;
}

function emptyStatus(state = "disconnected", error = null, observedAtUnixMs = Date.now()) {
  return {
    protocol: BROWSER_BRIDGE_STATUS_PROTOCOL,
    state,
    daemon: null,
    actor: null,
    identity: null,
    session: null,
    error,
    observedAtUnixMs,
  };
}

function errorView(error) {
  const code = STATES.has(error?.code) ? error.code : "protocol-mismatch";
  return {
    code,
    message: boundedText(error?.message) ? error.message : "The browser bridge could not complete the request.",
  };
}

export class BrowserBridgeHost {
  constructor({
    socketPath,
    credentialPath,
    connectDaemon = DaemonBrowserConnection.connect,
    now = Date.now,
  } = {}) {
    if (!boundedText(socketPath, 4096) || !boundedText(credentialPath, 4096)) {
      throw new TypeError("Browser bridge host requires fixed daemon and credential paths");
    }
    if (typeof connectDaemon !== "function") {
      throw new TypeError("Browser bridge host requires a daemon connector");
    }
    this.socketPath = socketPath;
    this.credentialPath = credentialPath;
    this.connectDaemon = connectDaemon;
    this.now = now;
    this.connection = null;
    this.statusValue = emptyStatus("disconnected", null, now());
  }

  snapshot() {
    return structuredClone(this.statusValue);
  }

  setStatus(state, projection = {}, error = null) {
    if (!STATES.has(state)) throw new TypeError("Browser bridge state is invalid");
    this.statusValue = {
      protocol: BROWSER_BRIDGE_STATUS_PROTOCOL,
      state,
      daemon: projection.daemon ?? null,
      actor: projection.actor ?? null,
      identity: projection.identity ?? null,
      session: projection.session ?? null,
      error,
      observedAtUnixMs: this.now(),
    };
    return this.snapshot();
  }

  async connect() {
    this.connection?.close();
    this.connection = null;
    this.setStatus("connecting");
    try {
      const { connection, snapshot } = await this.connectDaemon({
        socketPath: this.socketPath,
        credentialPath: this.credentialPath,
        now: this.now,
      });
      this.connection = connection;
      return this.setStatus("connected", snapshot);
    } catch (error) {
      const view = errorView(error);
      return this.setStatus(view.code, {}, view);
    }
  }

  async refresh() {
    if (!this.connection) return this.snapshot();
    try {
      return this.setStatus("connected", await this.connection.snapshot());
    } catch (error) {
      this.connection.close();
      this.connection = null;
      const view = errorView(error);
      return this.setStatus(view.code, {}, view);
    }
  }

  disconnect() {
    this.connection?.close();
    this.connection = null;
    return this.setStatus("disconnected");
  }

  async handle(message) {
    let request;
    try {
      request = validateBridgeRequest(message);
      const status = request.command === "connect"
        ? await this.connect()
        : request.command === "status"
        ? await this.refresh()
        : this.disconnect();
      return {
        protocol: BROWSER_BRIDGE_RESULT_PROTOCOL,
        type: "response",
        id: request.id,
        ok: true,
        status,
        error: null,
      };
    } catch (error) {
      const view = errorView(error);
      return {
        protocol: BROWSER_BRIDGE_RESULT_PROTOCOL,
        type: "response",
        id: REQUEST_ID.test(message?.id ?? "") ? message.id : "bridge/request/invalid0001",
        ok: false,
        status: this.setStatus(view.code, {}, view),
        error: view,
      };
    }
  }

  close() {
    this.disconnect();
  }
}
