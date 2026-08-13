import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import net from "node:net";
import { createInterface } from "node:readline";

export const LOCAL_PROTOCOL = "greenways-local/0-alpha";
export const LOCAL_RESULT_PROTOCOL = "greenways-local-result/0-alpha";
export const LOCAL_CREDENTIAL_PROTOCOL = "greenways-local-client-credential/0-alpha";
export const LOCAL_SESSION_PROTOCOL = "greenways-local-session/0-alpha";
export const LOCAL_CLIENT_PROTOCOL = "greenways-local-client/0-alpha";
export const DAEMON_STATUS_PROTOCOL = "greenways-daemon-status/0-alpha";
export const SIGNED_IDENTITY_PROTOCOL = "greenways-signed-profile-identity/0-alpha";
export const PROFILE_IDENTITY_PROTOCOL = "greenways-profile-identity/0-alpha";

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CLIENT_ID = /^local\/client\/[0-9a-f]{32}$/;
const TOKEN = /^gwc_[A-Za-z0-9_-]{43}$/;
const REQUEST_ID = /^local\/request\/[A-Za-z0-9._:-]{8,160}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class DaemonBridgeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "DaemonBridgeError";
    this.code = code;
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function boundedText(value, maximum) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/\p{C}/u.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function publicError(response) {
  const code = response?.error?.code;
  const message = response?.error?.message;
  if (code === "authentication-rejected") {
    return new DaemonBridgeError("authentication-rejected", "The browser bridge credential was rejected.");
  }
  if (code === "session-expired" || code === "session-unavailable") {
    return new DaemonBridgeError("session-expired", "The browser bridge session expired.");
  }
  if (code === "identity-unconfigured") {
    return new DaemonBridgeError(
      "identity-unconfigured",
      "No Greenways profile identity is configured yet.",
    );
  }
  return new DaemonBridgeError(
    "protocol-mismatch",
    boundedText(message, 400) ? message : "The daemon returned an unexpected error.",
  );
}

export function validateBrowserCredential(value) {
  if (!exactKeys(value, ["protocol", "clientId", "role", "token", "issuedAtUnixMs"])
      || value.protocol !== LOCAL_CREDENTIAL_PROTOCOL
      || !CLIENT_ID.test(value.clientId)
      || value.role !== "browser-bridge"
      || !TOKEN.test(value.token)
      || !positiveInteger(value.issuedAtUnixMs)) {
    throw new DaemonBridgeError(
      "authentication-rejected",
      "The configured credential is not an exact browser-bridge credential.",
    );
  }
  return value;
}

export async function readBrowserCredential(path) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    throw new DaemonBridgeError(
      "credential-unavailable",
      "The browser bridge credential file is unavailable.",
      { cause: error },
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DaemonBridgeError(
      "credential-unavailable",
      "The browser bridge credential must be a private regular file.",
    );
  }
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new DaemonBridgeError(
      "credential-unavailable",
      "The browser bridge credential is readable by another user or group.",
    );
  }
  if (metadata.size < 2 || metadata.size > MAX_CREDENTIAL_BYTES) {
    throw new DaemonBridgeError(
      "credential-unavailable",
      "The browser bridge credential file has an invalid size.",
    );
  }

  const bytes = await readFile(path);
  try {
    if (bytes.length > MAX_CREDENTIAL_BYTES) throw new Error("credential too large");
    return validateBrowserCredential(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof DaemonBridgeError) throw error;
    throw new DaemonBridgeError(
      "authentication-rejected",
      "The browser bridge credential is malformed.",
      { cause: error },
    );
  } finally {
    bytes.fill(0);
  }
}

function newRequestId() {
  return `local/request/${randomUUID().replaceAll("-", "")}`;
}

function localRequest(operation, argumentsValue = {}) {
  return {
    protocol: LOCAL_PROTOCOL,
    requestId: newRequestId(),
    operation,
    arguments: argumentsValue,
  };
}

function validateResponse(response, requestId) {
  if (!exactKeys(response, ["protocol", "requestId", "outcome", "value", "error"])
      || response.protocol !== LOCAL_RESULT_PROTOCOL
      || response.requestId !== requestId
      || !REQUEST_ID.test(response.requestId)
      || !["ok", "error"].includes(response.outcome)
      || (response.outcome === "ok" && (response.value === null || response.error !== null))
      || (response.outcome === "error" && (response.value !== null || !response.error))) {
    throw new DaemonBridgeError("protocol-mismatch", "The daemon response is not an exact local result.");
  }
  if (response.outcome === "error") throw publicError(response);
  return response.value;
}

function validateSession(value, credential) {
  if (!exactKeys(value, [
    "protocol", "id", "clientId", "role", "label", "openedAtUnixMs",
    "expiresAtUnixMs", "remainingRequests",
  ])
      || value.protocol !== LOCAL_SESSION_PROTOCOL
      || typeof value.id !== "string"
      || value.clientId !== credential.clientId
      || value.role !== "browser-bridge"
      || !boundedText(value.label, 120)
      || !positiveInteger(value.openedAtUnixMs)
      || !positiveInteger(value.expiresAtUnixMs)
      || value.expiresAtUnixMs <= value.openedAtUnixMs
      || !Number.isSafeInteger(value.remainingRequests)
      || value.remainingRequests < 1
      || value.remainingRequests > 1024) {
    throw new DaemonBridgeError("protocol-mismatch", "The daemon returned an invalid browser session.");
  }
  return value;
}

function projectDaemon(value) {
  if (!value || value.protocol !== DAEMON_STATUS_PROTOCOL
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
    throw new DaemonBridgeError("protocol-mismatch", "The daemon status projection is invalid.");
  }
  return {
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
  };
}

function projectActor(value) {
  if (!value || value.protocol !== LOCAL_CLIENT_PROTOCOL
      || !CLIENT_ID.test(value.id)
      || value.role !== "browser-bridge"
      || !boundedText(value.label, 120)
      || !positiveInteger(value.createdAtUnixMs)
      || (value.revokedAtUnixMs !== null && !positiveInteger(value.revokedAtUnixMs))) {
    throw new DaemonBridgeError("protocol-mismatch", "The local actor projection is invalid.");
  }
  if (value.revokedAtUnixMs !== null) {
    throw new DaemonBridgeError("authentication-rejected", "The browser bridge client is revoked.");
  }
  return {
    protocol: value.protocol,
    id: value.id,
    role: value.role,
    label: value.label,
    createdAtUnixMs: value.createdAtUnixMs,
    revokedAtUnixMs: null,
  };
}

function projectIdentity(value) {
  if (value === null) return null;
  const subject = value?.protocol === SIGNED_IDENTITY_PROTOCOL ? value.subject : value;
  if (!subject || subject.protocol !== PROFILE_IDENTITY_PROTOCOL
      || !boundedText(subject.id, 160)
      || !boundedText(subject.handle, 80)
      || !DIGEST.test(subject.keyId)
      || !boundedText(subject.algorithm, 80)
      || !positiveInteger(subject.createdAtUnixMs)) {
    throw new DaemonBridgeError("protocol-mismatch", "The public identity projection is invalid.");
  }
  return {
    protocol: subject.protocol,
    id: subject.id,
    handle: subject.handle,
    keyId: subject.keyId,
    algorithm: subject.algorithm,
    createdAtUnixMs: subject.createdAtUnixMs,
  };
}

class JsonLineTransport {
  constructor(socket, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
  }

  async request(request) {
    const encoded = `${JSON.stringify(request)}\n`;
    await new Promise((resolve, reject) => {
      this.socket.write(encoded, (error) => error ? reject(error) : resolve());
    });
    let timeout;
    const line = await Promise.race([
      this.lines.next(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new DaemonBridgeError("daemon-unavailable", "The daemon did not respond in time.")),
          this.timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timeout));
    if (line.done || Buffer.byteLength(line.value, "utf8") > MAX_RESPONSE_BYTES) {
      throw new DaemonBridgeError("protocol-mismatch", "The daemon response was missing or oversized.");
    }
    let response;
    try {
      response = JSON.parse(line.value);
    } catch (error) {
      throw new DaemonBridgeError("protocol-mismatch", "The daemon returned malformed JSON.", { cause: error });
    }
    return validateResponse(response, request.requestId);
  }

  close() {
    this.socket.end();
    this.socket.destroy();
  }
}

function openUnixSocket(path, createConnection = net.createConnection) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = createConnection({ path });
    } catch (error) {
      reject(new DaemonBridgeError("daemon-unavailable", "The local daemon socket is unavailable.", { cause: error }));
      return;
    }
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => { cleanup(); resolve(socket); };
    const onError = (error) => {
      cleanup();
      reject(new DaemonBridgeError("daemon-unavailable", "The local daemon socket is unavailable.", { cause: error }));
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

export class DaemonBrowserConnection {
  constructor({ transport, credential, session, now = Date.now }) {
    this.transport = transport;
    this.credential = { clientId: credential.clientId, role: credential.role };
    this.session = session;
    this.now = now;
    this.authenticatedRequests = 0;
  }

  static async connect({ socketPath, credentialPath, createConnection, now = Date.now } = {}) {
    const credential = await readBrowserCredential(credentialPath);
    const socket = await openUnixSocket(socketPath, createConnection);
    const transport = new JsonLineTransport(socket);
    try {
      const sessionRequest = localRequest("client.session.open", {
        protocol: credential.protocol,
        clientId: credential.clientId,
        role: credential.role,
        token: credential.token,
        issuedAtUnixMs: credential.issuedAtUnixMs,
      });
      const session = validateSession(await transport.request(sessionRequest), credential);
      credential.token = "";
      const connection = new DaemonBrowserConnection({ transport, credential, session, now });
      return { connection, snapshot: await connection.snapshot() };
    } catch (error) {
      credential.token = "";
      transport.close();
      throw error;
    }
  }

  async authenticatedRequest(operation) {
    if (this.now() >= this.session.expiresAtUnixMs
        || this.authenticatedRequests >= this.session.remainingRequests) {
      throw new DaemonBridgeError("session-expired", "The browser bridge session expired.");
    }
    const value = await this.transport.request(localRequest(operation));
    this.authenticatedRequests += 1;
    return value;
  }

  async snapshot() {
    const daemon = projectDaemon(await this.authenticatedRequest("status"));
    const actor = projectActor(await this.authenticatedRequest("client.whoami"));
    let identity = null;
    try {
      identity = projectIdentity(await this.authenticatedRequest("identity.public-card"));
    } catch (error) {
      if (error.code !== "identity-unconfigured") throw error;
      identity = null;
    }
    return {
      daemon,
      actor,
      identity,
      session: {
        protocol: this.session.protocol,
        clientId: this.session.clientId,
        role: this.session.role,
        label: this.session.label,
        openedAtUnixMs: this.session.openedAtUnixMs,
        expiresAtUnixMs: this.session.expiresAtUnixMs,
        remainingRequests: Math.max(
          0,
          this.session.remainingRequests - this.authenticatedRequests,
        ),
      },
    };
  }

  close() {
    this.transport.close();
  }
}
