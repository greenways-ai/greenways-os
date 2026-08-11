import {
  MCP_READ_TOOLS,
  assertNoSecretFields,
  canonical,
  normalizeConnection,
  sha256,
  validateBoundedPublicValue,
} from "./protocol.js";

export const MCP_PAIRING_CHALLENGE_PROTOCOL = "greenways-mcp-pairing-challenge/1";
export const MCP_PAIRING_ASSERTION_PROTOCOL = "greenways-mcp-pairing-assertion/1";
export const MCP_PAIRING_SESSION_PROTOCOL = "greenways-mcp-pairing-session/1";
export const MCP_PAIRING_RECEIPT_PROTOCOL = "greenways-mcp-pairing-receipt/1";
export const MCP_PAIRING_ALGORITHM = "ECDSA-P256-SHA256";
export const MCP_PAIRING_SCOPE = "greenways.read";

const CHALLENGE_ID = /^mcp\/challenge\/[A-Za-z0-9._:-]{8,160}$/;
const CONNECTION_ID = /^mcp\/connection\/[A-Za-z0-9._:-]{8,160}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,180}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{64,200}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CHALLENGE_STATES = new Set(["open", "claimed", "consumed"]);
const MAX_OAUTH_REQUEST_BYTES = 32 * 1024;
const MAX_ASSERTION_BYTES = 24 * 1024;
const DEFAULT_CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;
const DEFAULT_ASSERTION_LIFETIME_MS = 2 * 60 * 1000;
const MAX_ASSERTION_LIFETIME_MS = 5 * 60 * 1000;
const DEFAULT_CONNECTION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CONNECTION_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;

const textEncoder = new TextEncoder();

export class McpPairingError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = "McpPairingError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message, options) {
  throw new McpPairingError(status, code, message, options);
}

function plainObject(value, label, status = 400) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(status, "invalid-pairing", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(status, "invalid-pairing", `${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label, status = 400) {
  const input = plainObject(value, label, status);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(status, "invalid-pairing", `${label} contains an unsupported field: ${key}`);
  }
  return input;
}

function string(value, label, maximum = 180, status = 400) {
  if (typeof value !== "string") fail(status, "invalid-pairing", `${label} must be a string`);
  const output = value.trim();
  if (!output || output.length > maximum) fail(status, "invalid-pairing", `${label} is invalid`);
  return output;
}

function optionalString(value, label, maximum = 180) {
  return value === undefined || value === null || value === "" ? null : string(value, label, maximum);
}

function id(value, label, pattern = ID, status = 400) {
  const output = string(value, label, 180, status);
  if (!pattern.test(output)) fail(status, "invalid-pairing", `${label} is invalid`);
  return output;
}

function boundedLifetime(value, fallback, maximum, label) {
  const output = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(output) || output < 10_000 || output > maximum) {
    throw new TypeError(`${label} must be a bounded millisecond lifetime`);
  }
  return output;
}

function canonicalDate(value, label, status = 400) {
  const output = string(value, label, 80, status);
  if (!Number.isFinite(Date.parse(output)) || new Date(output).toISOString() !== output) {
    fail(status, "invalid-pairing", `${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function secureUuid(randomUUID, label) {
  if (typeof randomUUID !== "function") throw new TypeError(`${label} requires a random UUID source`);
  const value = String(randomUUID());
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    fail(500, "pairing-runtime-unavailable", `${label} randomness is invalid`);
  }
  return value.toLowerCase();
}

function byteLength(value) {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

function jsonClone(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail(400, "invalid-oauth-request", `${label} must be JSON serializable`);
  }
  if (encoded === undefined || textEncoder.encode(encoded).byteLength > MAX_OAUTH_REQUEST_BYTES) {
    fail(400, "invalid-oauth-request", `${label} exceeds its byte limit`);
  }
  const output = JSON.parse(encoded);
  assertNoSecretFields(output, label);
  return output;
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== MCP_PAIRING_SCOPE) {
    fail(400, "unsupported-scope", `MCP authorization requires exactly ${MCP_PAIRING_SCOPE}`);
  }
  return Object.freeze([MCP_PAIRING_SCOPE]);
}

function normalizeClient(value, expectedId) {
  const input = plainObject(value, "OAuth client");
  const clientId = id(input.clientId, "OAuth client id");
  if (clientId !== expectedId) fail(400, "oauth-client-mismatch", "OAuth client metadata does not match the request");
  let clientUri = null;
  if (input.clientUri !== undefined && input.clientUri !== null && input.clientUri !== "") {
    const uri = string(input.clientUri, "OAuth client URI", 2048);
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      fail(400, "invalid-oauth-client", "OAuth client URI is invalid");
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      fail(400, "invalid-oauth-client", "OAuth client URI must use HTTPS or loopback development HTTP");
    }
    clientUri = parsed.href;
  }
  return Object.freeze({
    id: clientId,
    name: optionalString(input.clientName, "OAuth client name", 120) ?? "MCP Client",
    uri: clientUri,
  });
}

function normalizePublicKey(value) {
  const input = closedKeys(
    value,
    new Set(["kty", "crv", "x", "y", "ext", "key_ops"]),
    "Pairing identity public key",
  );
  if (input.kty !== "EC" || input.crv !== "P-256"
      || typeof input.x !== "string" || !input.x
      || typeof input.y !== "string" || !input.y
      || input.ext !== true
      || !Array.isArray(input.key_ops)
      || input.key_ops.length !== 1
      || input.key_ops[0] !== "verify") {
    fail(400, "invalid-identity-key", "Pairing identity requires a public P-256 verification key");
  }
  return Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: input.x,
    y: input.y,
    ext: true,
    key_ops: Object.freeze(["verify"]),
  });
}

function normalizeIdentity(value) {
  const input = closedKeys(
    value,
    new Set(["id", "handle", "keyId", "algorithm", "publicKey"]),
    "Pairing identity",
  );
  const keyId = string(input.keyId, "Pairing identity key id", 80);
  if (!DIGEST.test(keyId)) fail(400, "invalid-identity-key", "Pairing identity key id is invalid");
  if (input.algorithm !== MCP_PAIRING_ALGORITHM) {
    fail(400, "unsupported-identity-algorithm", "Pairing identity algorithm is unsupported");
  }
  return Object.freeze({
    id: id(input.id, "Pairing identity id"),
    handle: optionalString(input.handle, "Pairing identity handle", 80),
    keyId,
    algorithm: MCP_PAIRING_ALGORITHM,
    publicKey: normalizePublicKey(input.publicKey),
  });
}

function normalizeDevice(value) {
  const input = closedKeys(value, new Set(["id", "name", "kind"]), "Pairing device");
  if (input.kind !== "browser-extension") {
    fail(400, "unsupported-pairing-device", "MCP pairing requires the reviewed Greenways browser extension");
  }
  return Object.freeze({
    id: id(input.id, "Pairing device id"),
    name: optionalString(input.name, "Pairing device name", 100) ?? "Greenways OS",
    kind: "browser-extension",
  });
}

function normalizeChallenge(value) {
  const input = closedKeys(
    value,
    new Set([
      "protocol", "id", "client", "scopes", "tools", "requestDigest",
      "nonce", "issuedAt", "expiresAt", "root",
    ]),
    "MCP pairing challenge",
    500,
  );
  if (input.protocol !== MCP_PAIRING_CHALLENGE_PROTOCOL) {
    fail(500, "pairing-recovery", "Stored MCP pairing challenge protocol is unsupported");
  }
  if (!Array.isArray(input.tools)
      || input.tools.length !== MCP_READ_TOOLS.length
      || input.tools.some((name, index) => name !== MCP_READ_TOOLS[index].name)) {
    fail(500, "pairing-recovery", "Stored MCP pairing challenge tools are invalid");
  }
  const requestDigest = string(input.requestDigest, "MCP pairing request digest", 80, 500);
  const root = string(input.root, "MCP pairing challenge root", 80, 500);
  if (!DIGEST.test(requestDigest) || !DIGEST.test(root)) {
    fail(500, "pairing-recovery", "Stored MCP pairing challenge digest is invalid");
  }
  return Object.freeze({
    protocol: MCP_PAIRING_CHALLENGE_PROTOCOL,
    id: id(input.id, "MCP pairing challenge id", CHALLENGE_ID, 500),
    client: Object.freeze({
      id: id(input.client?.id, "MCP pairing client id", ID, 500),
      name: string(input.client?.name, "MCP pairing client name", 120, 500),
      uri: input.client?.uri === null ? null : string(input.client?.uri, "MCP pairing client URI", 2048, 500),
    }),
    scopes: normalizeScopes(input.scopes),
    tools: Object.freeze([...input.tools]),
    requestDigest,
    nonce: string(input.nonce, "MCP pairing challenge nonce", 80, 500),
    issuedAt: canonicalDate(input.issuedAt, "MCP pairing challenge issuedAt", 500),
    expiresAt: canonicalDate(input.expiresAt, "MCP pairing challenge expiresAt", 500),
    root,
  });
}

function normalizeSession(value) {
  const input = closedKeys(
    value,
    new Set([
      "protocol", "id", "state", "challenge", "oauthRequest", "createdAt",
      "claimId", "claimedAt", "consumedAt", "connectionId",
    ]),
    "MCP pairing session",
    500,
  );
  if (input.protocol !== MCP_PAIRING_SESSION_PROTOCOL || !CHALLENGE_STATES.has(input.state)) {
    fail(500, "pairing-recovery", "Stored MCP pairing session is invalid");
  }
  const challenge = normalizeChallenge(input.challenge);
  if (input.id !== challenge.id) fail(500, "pairing-recovery", "Stored MCP pairing session identity is invalid");
  const output = Object.freeze({
    protocol: MCP_PAIRING_SESSION_PROTOCOL,
    id: challenge.id,
    state: input.state,
    challenge,
    oauthRequest: jsonClone(input.oauthRequest, "Stored OAuth request"),
    createdAt: canonicalDate(input.createdAt, "MCP pairing session createdAt", 500),
    claimId: input.claimId === null ? null : string(input.claimId, "MCP pairing claim id", 80, 500),
    claimedAt: input.claimedAt === null ? null : canonicalDate(input.claimedAt, "MCP pairing claimedAt", 500),
    consumedAt: input.consumedAt === null ? null : canonicalDate(input.consumedAt, "MCP pairing consumedAt", 500),
    connectionId: input.connectionId === null ? null : id(input.connectionId, "MCP pairing connection id", CONNECTION_ID, 500),
  });
  if ((output.state === "open" && (output.claimId || output.claimedAt || output.consumedAt || output.connectionId))
      || (output.state === "claimed" && (!output.claimId || !output.claimedAt || output.consumedAt || output.connectionId))
      || (output.state === "consumed" && (!output.claimId || !output.claimedAt || !output.consumedAt || !output.connectionId))) {
    fail(500, "pairing-recovery", "Stored MCP pairing session state is inconsistent");
  }
  return output;
}

function assertionBody(value) {
  const input = closedKeys(
    value,
    new Set([
      "protocol", "challengeId", "challengeRoot", "identity", "device",
      "issuedAt", "expiresAt", "signature",
    ]),
    "MCP pairing assertion",
  );
  if (input.protocol !== MCP_PAIRING_ASSERTION_PROTOCOL) {
    fail(400, "unsupported-pairing-protocol", "MCP pairing assertion protocol is unsupported");
  }
  const signature = string(input.signature, "MCP pairing assertion signature", 240);
  if (!SIGNATURE.test(signature)) fail(400, "invalid-pairing-signature", "MCP pairing assertion signature is invalid");
  return {
    body: Object.freeze({
      protocol: MCP_PAIRING_ASSERTION_PROTOCOL,
      challengeId: id(input.challengeId, "MCP pairing assertion challenge id", CHALLENGE_ID),
      challengeRoot: string(input.challengeRoot, "MCP pairing assertion challenge root", 80),
      identity: normalizeIdentity(input.identity),
      device: normalizeDevice(input.device),
      issuedAt: canonicalDate(input.issuedAt, "MCP pairing assertion issuedAt"),
      expiresAt: canonicalDate(input.expiresAt, "MCP pairing assertion expiresAt"),
    }),
    signature,
  };
}

function base64UrlBytes(value) {
  if (!SIGNATURE.test(value)) fail(400, "invalid-pairing-signature", "MCP pairing assertion signature is invalid");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    fail(400, "invalid-pairing-signature", "MCP pairing assertion signature is invalid");
  }
}

function bytesBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function verifyAssertion(assertion, challenge, { now, cryptoProvider }) {
  if (byteLength(assertion) > MAX_ASSERTION_BYTES) fail(413, "pairing-too-large", "MCP pairing assertion exceeds its byte limit");
  const normalized = assertionBody(assertion);
  if (normalized.body.challengeId !== challenge.id || normalized.body.challengeRoot !== challenge.root) {
    fail(403, "pairing-challenge-mismatch", "MCP pairing assertion does not match this authorization challenge");
  }
  const currentTime = now().getTime();
  const issuedTime = Date.parse(normalized.body.issuedAt);
  const expiresTime = Date.parse(normalized.body.expiresAt);
  if (issuedTime > currentTime + MAX_CLOCK_SKEW_MS
      || expiresTime <= currentTime
      || expiresTime <= issuedTime
      || expiresTime - issuedTime > MAX_ASSERTION_LIFETIME_MS
      || expiresTime > Date.parse(challenge.expiresAt)) {
    fail(403, "pairing-assertion-expired", "MCP pairing assertion is outside its accepted time window");
  }
  if (normalized.body.identity.keyId !== await sha256(canonical(normalized.body.identity.publicKey), cryptoProvider)) {
    fail(403, "pairing-key-mismatch", "MCP pairing identity key does not match its key ID");
  }
  let valid = false;
  try {
    const key = await cryptoProvider.subtle.importKey(
      "jwk",
      normalized.body.identity.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    valid = await cryptoProvider.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlBytes(normalized.signature),
      textEncoder.encode(canonical(normalized.body)),
    );
  } catch {
    valid = false;
  }
  if (!valid) fail(403, "pairing-signature-invalid", "MCP pairing assertion signature was not accepted");
  return Object.freeze({ ...normalized.body, signature: normalized.signature });
}

async function challengeRoot(challenge, cryptoProvider = globalThis.crypto) {
  const { root, ...body } = challenge;
  return sha256(canonical(body), cryptoProvider);
}

function stablePublicChallenge(challenge) {
  return Object.freeze({
    protocol: challenge.protocol,
    id: challenge.id,
    client: challenge.client,
    scopes: challenge.scopes,
    tools: challenge.tools,
    requestDigest: challenge.requestDigest,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
    root: challenge.root,
  });
}

export async function createMcpPairingAssertion(challengeValue, {
  identity,
  device,
  sign,
  now = () => new Date(),
  cryptoProvider = globalThis.crypto,
  assertionLifetimeMs = DEFAULT_ASSERTION_LIFETIME_MS,
} = {}) {
  const challenge = normalizeChallenge(challengeValue);
  const issued = now();
  if (!(issued instanceof Date) || !Number.isFinite(issued.getTime())) {
    throw new TypeError("MCP pairing assertion clock is invalid");
  }
  if (challenge.root !== await challengeRoot(challenge, cryptoProvider)) {
    fail(403, "pairing-challenge-root-invalid", "MCP pairing challenge content does not match its root");
  }
  if (Date.parse(challenge.expiresAt) <= issued.getTime()) {
    fail(403, "pairing-challenge-expired", "MCP pairing challenge expired before approval");
  }
  if (typeof sign !== "function") throw new TypeError("MCP pairing assertion requires a signer");
  const lifetime = boundedLifetime(
    assertionLifetimeMs,
    DEFAULT_ASSERTION_LIFETIME_MS,
    MAX_ASSERTION_LIFETIME_MS,
    "MCP assertion lifetime",
  );
  const expiresAt = new Date(Math.min(
    issued.getTime() + lifetime,
    Date.parse(challenge.expiresAt),
  ));
  const body = Object.freeze({
    protocol: MCP_PAIRING_ASSERTION_PROTOCOL,
    challengeId: challenge.id,
    challengeRoot: challenge.root,
    identity: normalizeIdentity(identity),
    device: normalizeDevice(device),
    issuedAt: issued.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
  const signature = await sign(textEncoder.encode(canonical(body)), body);
  const encoded = signature instanceof Uint8Array ? bytesBase64Url(signature) : string(signature, "MCP pairing signature", 240);
  if (!SIGNATURE.test(encoded)) throw new Error("MCP pairing signer returned an invalid signature");
  return Object.freeze({ ...body, signature: encoded });
}

export class MemoryMcpPairingRepository {
  constructor() {
    this.sessions = new Map();
    this.connections = new Map();
  }

  async putSession(session) {
    if (this.sessions.has(session.id)) fail(409, "pairing-session-exists", "MCP pairing session already exists");
    this.sessions.set(session.id, structuredClone(session));
  }

  async getSession(idValue) {
    const value = this.sessions.get(idValue);
    return value ? structuredClone(value) : null;
  }

  async claimSession(idValue, root, claimId, claimedAt) {
    const current = this.sessions.get(idValue);
    if (!current) fail(404, "pairing-session-missing", "MCP pairing session does not exist");
    if (current.challenge?.root !== root) fail(409, "pairing-session-changed", "MCP pairing session changed");
    if (current.state !== "open") fail(409, "pairing-session-used", "MCP pairing session is already in use");
    const next = { ...current, state: "claimed", claimId, claimedAt };
    this.sessions.set(idValue, structuredClone(next));
    return structuredClone(next);
  }

  async releaseSession(idValue, claimId) {
    const current = this.sessions.get(idValue);
    if (!current || current.state !== "claimed" || current.claimId !== claimId) return false;
    this.sessions.set(idValue, structuredClone({
      ...current,
      state: "open",
      claimId: null,
      claimedAt: null,
    }));
    return true;
  }

  async consumeSession(idValue, claimId, connectionId, consumedAt) {
    const current = this.sessions.get(idValue);
    if (!current || current.state !== "claimed" || current.claimId !== claimId) {
      fail(409, "pairing-session-changed", "MCP pairing session claim is no longer current");
    }
    const next = { ...current, state: "consumed", connectionId, consumedAt };
    this.sessions.set(idValue, structuredClone(next));
    return structuredClone(next);
  }

  async putConnection(connection) {
    if (this.connections.has(connection.id)) fail(409, "connection-exists", "MCP connection already exists");
    this.connections.set(connection.id, structuredClone(connection));
  }

  async deleteConnection(connectionId) {
    return this.connections.delete(connectionId);
  }

  async getConnection(connectionId) {
    const value = this.connections.get(connectionId);
    return value ? structuredClone(value) : null;
  }
}

export class GreenwaysMcpPairingService {
  constructor({
    repository,
    now = () => new Date(),
    randomUUID = () => globalThis.crypto.randomUUID(),
    cryptoProvider = globalThis.crypto,
    challengeLifetimeMs = DEFAULT_CHALLENGE_LIFETIME_MS,
    connectionLifetimeMs = DEFAULT_CONNECTION_LIFETIME_MS,
    routeResolver = ({ identity }) => ({
      kind: "replica",
      id: `replica/${identity.id}`,
      status: "unknown",
    }),
  } = {}) {
    if (!repository
        || typeof repository.putSession !== "function"
        || typeof repository.getSession !== "function"
        || typeof repository.claimSession !== "function"
        || typeof repository.releaseSession !== "function"
        || typeof repository.consumeSession !== "function"
        || typeof repository.putConnection !== "function"
        || typeof repository.deleteConnection !== "function") {
      throw new TypeError("MCP pairing requires an atomic pairing repository");
    }
    if (!cryptoProvider?.subtle) throw new TypeError("MCP pairing requires Web Crypto");
    if (typeof routeResolver !== "function") throw new TypeError("MCP pairing requires a route resolver");
    this.repository = repository;
    this.now = now;
    this.randomUUID = randomUUID;
    this.cryptoProvider = cryptoProvider;
    this.challengeLifetimeMs = boundedLifetime(
      challengeLifetimeMs,
      DEFAULT_CHALLENGE_LIFETIME_MS,
      MAX_CHALLENGE_LIFETIME_MS,
      "MCP challenge lifetime",
    );
    this.connectionLifetimeMs = boundedLifetime(
      connectionLifetimeMs,
      DEFAULT_CONNECTION_LIFETIME_MS,
      MAX_CONNECTION_LIFETIME_MS,
      "MCP connection lifetime",
    );
    this.routeResolver = routeResolver;
  }

  async begin({ oauthRequest, clientInfo }) {
    const request = jsonClone(oauthRequest, "OAuth authorization request");
    const clientId = id(request.clientId, "OAuth authorization client id");
    const scopes = normalizeScopes(request.scope);
    const client = normalizeClient(clientInfo, clientId);
    const issued = this.now();
    const body = {
      protocol: MCP_PAIRING_CHALLENGE_PROTOCOL,
      id: `mcp/challenge/${secureUuid(this.randomUUID, "MCP pairing challenge")}`,
      client,
      scopes,
      tools: Object.freeze(MCP_READ_TOOLS.map(({ name }) => name)),
      requestDigest: await sha256(canonical(request), this.cryptoProvider),
      nonce: secureUuid(this.randomUUID, "MCP pairing nonce"),
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + this.challengeLifetimeMs).toISOString(),
    };
    const challenge = Object.freeze({ ...body, root: await sha256(canonical(body), this.cryptoProvider) });
    const session = Object.freeze({
      protocol: MCP_PAIRING_SESSION_PROTOCOL,
      id: challenge.id,
      state: "open",
      challenge,
      oauthRequest: request,
      createdAt: issued.toISOString(),
      claimId: null,
      claimedAt: null,
      consumedAt: null,
      connectionId: null,
    });
    normalizeSession(session);
    await this.repository.putSession(session);
    return stablePublicChallenge(challenge);
  }

  async authorize({ challengeId, assertion, completeAuthorization }) {
    if (typeof completeAuthorization !== "function") throw new TypeError("MCP pairing requires an OAuth completion function");
    const requestedId = id(challengeId, "MCP pairing challenge id", CHALLENGE_ID);
    const stored = await this.repository.getSession(requestedId);
    if (!stored) fail(404, "pairing-session-missing", "MCP pairing session does not exist");
    const session = normalizeSession(stored);
    if (session.state !== "open") fail(409, "pairing-session-used", "MCP pairing session is already in use");
    if (Date.parse(session.challenge.expiresAt) <= this.now().getTime()) {
      fail(403, "pairing-challenge-expired", "MCP pairing challenge expired");
    }
    if (session.challenge.root !== await challengeRoot(session.challenge, this.cryptoProvider)) {
      fail(500, "pairing-recovery", "Stored MCP pairing challenge root is invalid");
    }
    if (session.challenge.requestDigest !== await sha256(canonical(session.oauthRequest), this.cryptoProvider)) {
      fail(500, "pairing-recovery", "Stored OAuth authorization request changed");
    }
    const verified = await verifyAssertion(assertion, session.challenge, {
      now: this.now,
      cryptoProvider: this.cryptoProvider,
    });
    const claimId = secureUuid(this.randomUUID, "MCP pairing claim");
    const claimedAt = this.now().toISOString();
    await this.repository.claimSession(session.id, session.challenge.root, claimId, claimedAt);

    const issued = this.now();
    const connection = normalizeConnection({
      protocol: "greenways-mcp-connection/1",
      id: `mcp/connection/${secureUuid(this.randomUUID, "MCP connection")}`,
      identity: {
        id: verified.identity.id,
        keyId: verified.identity.keyId,
      },
      client: {
        id: session.challenge.client.id,
        name: session.challenge.client.name,
      },
      tools: session.challenge.tools,
      route: await this.routeResolver({
        identity: verified.identity,
        device: verified.device,
        challenge: session.challenge,
      }),
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + this.connectionLifetimeMs).toISOString(),
      revokedAt: null,
    });

    let connectionStored = false;
    try {
      await this.repository.putConnection(connection);
      connectionStored = true;
      const oauthResult = await completeAuthorization({
        oauthRequest: session.oauthRequest,
        identity: verified.identity,
        device: verified.device,
        connection,
      });
      await this.repository.consumeSession(
        session.id,
        claimId,
        connection.id,
        this.now().toISOString(),
      );
      const receipt = Object.freeze({
        protocol: MCP_PAIRING_RECEIPT_PROTOCOL,
        challengeId: session.id,
        connectionId: connection.id,
        identity: Object.freeze({
          id: verified.identity.id,
          handle: verified.identity.handle,
          keyId: verified.identity.keyId,
        }),
        client: connection.client,
        tools: connection.tools,
        pairedAt: this.now().toISOString(),
      });
      validateBoundedPublicValue(receipt, "MCP pairing receipt");
      return Object.freeze({ connection, receipt, oauthResult });
    } catch (cause) {
      if (connectionStored) await this.repository.deleteConnection(connection.id).catch(() => {});
      await this.repository.releaseSession(session.id, claimId).catch(() => {});
      if (cause instanceof McpPairingError) throw cause;
      fail(502, "oauth-authorization-failed", "MCP OAuth authorization could not be completed", { cause });
    }
  }
}
