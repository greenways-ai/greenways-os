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
export const MCP_PAIRING_SESSION_PROTOCOL = "greenways-mcp-pairing-session/2";
export const MCP_PAIRING_RECEIPT_PROTOCOL = "greenways-mcp-pairing-receipt/1";
export const MCP_PAIRING_ALGORITHM = "ECDSA-P256-SHA256";
export const MCP_PAIRING_SCOPE = "greenways.read";
export const MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS = 2 * 60 * 1000;

const CHALLENGE_ID = /^mcp\/challenge\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAIRING_CONNECTION_ID = /^mcp\/connection\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
const MAX_PAIRING_CLAIM_LIFETIME_MS = 5 * 60 * 1000;
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

export function normalizeMcpPairingChallengeId(value, status = 400) {
  return id(value, "MCP pairing challenge id", CHALLENGE_ID, status);
}

export function normalizeMcpPairingClaimId(value, status = 400) {
  const output = string(value, "MCP pairing claim id", 80, status);
  if (!CLAIM_ID.test(output)) fail(status, "invalid-pairing", "MCP pairing claim id is invalid");
  return output.toLowerCase();
}

export function normalizeMcpPairingConnectionId(value, status = 400) {
  const output = string(value, "MCP pairing connection id", 180, status);
  if (!PAIRING_CONNECTION_ID.test(output)) {
    fail(status, "invalid-pairing", "MCP pairing connection id is invalid");
  }
  return output.toLowerCase();
}

export function mcpConnectionIdForClaim(challengeIdValue, claimIdValue) {
  const challengeId = normalizeMcpPairingChallengeId(challengeIdValue, 500);
  const claimId = normalizeMcpPairingClaimId(claimIdValue, 500);
  return `mcp/connection/${challengeId.slice("mcp/challenge/".length).toLowerCase()}:${claimId}`;
}

export function mcpChallengeIdForConnection(connectionIdValue) {
  const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
  const match = PAIRING_CONNECTION_ID.exec(connectionId);
  return `mcp/challenge/${match[1].toLowerCase()}`;
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

export function normalizeMcpPairingChallenge(value) {
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
  let scopes;
  try {
    scopes = normalizeScopes(input.scopes);
  } catch (cause) {
    fail(500, "pairing-recovery", "Stored MCP pairing challenge scopes are invalid", { cause });
  }
  return Object.freeze({
    protocol: MCP_PAIRING_CHALLENGE_PROTOCOL,
    id: id(input.id, "MCP pairing challenge id", CHALLENGE_ID, 500),
    client: Object.freeze({
      id: id(input.client?.id, "MCP pairing client id", ID, 500),
      name: string(input.client?.name, "MCP pairing client name", 120, 500),
      uri: input.client?.uri === null ? null : string(input.client?.uri, "MCP pairing client URI", 2048, 500),
    }),
    scopes,
    tools: Object.freeze([...input.tools]),
    requestDigest,
    nonce: string(input.nonce, "MCP pairing challenge nonce", 80, 500),
    issuedAt: canonicalDate(input.issuedAt, "MCP pairing challenge issuedAt", 500),
    expiresAt: canonicalDate(input.expiresAt, "MCP pairing challenge expiresAt", 500),
    root,
  });
}

export function normalizeMcpPairingSession(value) {
  const input = closedKeys(
    value,
    new Set([
      "protocol", "id", "state", "challenge", "oauthRequest", "createdAt",
      "claimId", "claimedAt", "claimExpiresAt", "consumedAt", "connection",
    ]),
    "MCP pairing session",
    500,
  );
  if (input.protocol !== MCP_PAIRING_SESSION_PROTOCOL || !CHALLENGE_STATES.has(input.state)) {
    fail(500, "pairing-recovery", "Stored MCP pairing session is invalid");
  }
  const challenge = normalizeMcpPairingChallenge(input.challenge);
  if (input.id !== challenge.id) fail(500, "pairing-recovery", "Stored MCP pairing session identity is invalid");
  let oauthRequest;
  try {
    oauthRequest = jsonClone(input.oauthRequest, "Stored OAuth request");
  } catch (cause) {
    fail(500, "pairing-recovery", "Stored OAuth request is invalid", { cause });
  }
  let connection = null;
  if (input.connection !== null) {
    try {
      connection = normalizeConnection(input.connection);
    } catch (cause) {
      fail(500, "pairing-recovery", "Stored MCP pairing connection is invalid", { cause });
    }
  }
  const output = Object.freeze({
    protocol: MCP_PAIRING_SESSION_PROTOCOL,
    id: challenge.id,
    state: input.state,
    challenge,
    oauthRequest,
    createdAt: canonicalDate(input.createdAt, "MCP pairing session createdAt", 500),
    claimId: input.claimId === null ? null : normalizeMcpPairingClaimId(input.claimId, 500),
    claimedAt: input.claimedAt === null ? null : canonicalDate(input.claimedAt, "MCP pairing claimedAt", 500),
    claimExpiresAt: input.claimExpiresAt === null
      ? null
      : canonicalDate(input.claimExpiresAt, "MCP pairing claimExpiresAt", 500),
    consumedAt: input.consumedAt === null ? null : canonicalDate(input.consumedAt, "MCP pairing consumedAt", 500),
    connection,
  });
  if ((output.state === "open"
        && (output.claimId || output.claimedAt || output.claimExpiresAt || output.consumedAt || output.connection))
      || (output.state === "claimed"
        && (!output.claimId || !output.claimedAt || !output.claimExpiresAt || output.consumedAt || !output.connection))
      || (output.state === "consumed"
        && (!output.claimId || !output.claimedAt || !output.claimExpiresAt || !output.consumedAt || !output.connection))) {
    fail(500, "pairing-recovery", "Stored MCP pairing session state is inconsistent");
  }
  if (output.claimedAt) {
    if (Date.parse(output.claimExpiresAt) <= Date.parse(output.claimedAt)
        || Date.parse(output.claimExpiresAt) > Date.parse(challenge.expiresAt)) {
      fail(500, "pairing-recovery", "Stored MCP pairing claim lifetime is inconsistent");
    }
    const expectedConnectionId = mcpConnectionIdForClaim(challenge.id, output.claimId);
    if (output.connection.id !== expectedConnectionId
        || output.connection.client.id !== challenge.client.id
        || output.connection.client.name !== challenge.client.name
        || output.connection.tools.length !== challenge.tools.length
        || output.connection.tools.some((name, index) => name !== challenge.tools[index])) {
      fail(500, "pairing-recovery", "Stored MCP pairing connection is not bound to its claim");
    }
  }
  if (output.consumedAt && Date.parse(output.consumedAt) < Date.parse(output.claimedAt)) {
    fail(500, "pairing-recovery", "Stored MCP pairing consumption precedes its claim");
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
  const challenge = normalizeMcpPairingChallenge(challengeValue);
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

function pairingRepositoryDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(500, "pairing-recovery", "MCP pairing repository clock is invalid");
  }
  return value;
}

function clonePairingValue(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    fail(500, "pairing-recovery", `${label} must be structured-cloneable`, { cause });
  }
}

function pairingTransition(session, changed, extra = {}) {
  return Object.freeze({
    session: clonePairingValue(session, "MCP pairing transition"),
    changed,
    ...extra,
  });
}

function currentPairingSession(value) {
  return value === null || value === undefined ? null : normalizeMcpPairingSession(value);
}

export function putMcpPairingSessionState(currentValue, sessionValue) {
  if (currentPairingSession(currentValue)) {
    fail(409, "pairing-session-exists", "MCP pairing session already exists");
  }
  return pairingTransition(normalizeMcpPairingSession(sessionValue), true);
}

export function claimMcpPairingSessionState(
  currentValue,
  claimValue,
  nowValue,
  claimLifetimeMs = MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS,
) {
  const current = currentPairingSession(currentValue);
  if (!current) fail(404, "pairing-session-missing", "MCP pairing session does not exist");
  const input = closedKeys(
    claimValue,
    new Set(["id", "root", "claimId", "connection"]),
    "MCP pairing repository claim",
    500,
  );
  const idValue = normalizeMcpPairingChallengeId(input.id, 500);
  const claimId = normalizeMcpPairingClaimId(input.claimId, 500);
  if (current.id !== idValue) fail(500, "pairing-recovery", "MCP pairing repository identity changed");
  if (current.challenge.root !== input.root) fail(409, "pairing-session-changed", "MCP pairing session changed");
  const observed = pairingRepositoryDate(nowValue);
  if (Date.parse(current.challenge.expiresAt) <= observed.getTime()) {
    fail(403, "pairing-challenge-expired", "MCP pairing challenge expired");
  }
  if (current.state === "consumed") {
    fail(409, "pairing-session-used", "MCP pairing session is already in use");
  }
  if (current.state === "claimed" && Date.parse(current.claimExpiresAt) > observed.getTime()) {
    fail(409, "pairing-session-used", "MCP pairing session is already in use");
  }
  const lifetime = boundedLifetime(
    claimLifetimeMs,
    MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS,
    MAX_PAIRING_CLAIM_LIFETIME_MS,
    "MCP pairing claim lifetime",
  );
  let connection;
  try {
    connection = normalizeConnection(input.connection);
  } catch (cause) {
    fail(500, "pairing-recovery", "MCP pairing claim connection is invalid", { cause });
  }
  if (connection.id !== mcpConnectionIdForClaim(current.id, claimId)) {
    fail(500, "pairing-recovery", "MCP pairing claim connection ID is invalid");
  }
  const next = normalizeMcpPairingSession({
    ...current,
    state: "claimed",
    claimId,
    claimedAt: observed.toISOString(),
    claimExpiresAt: new Date(Math.min(
      observed.getTime() + lifetime,
      Date.parse(current.challenge.expiresAt),
    )).toISOString(),
    consumedAt: null,
    connection,
  });
  return pairingTransition(next, true);
}

export function releaseMcpPairingSessionState(currentValue, releaseValue) {
  const current = currentPairingSession(currentValue);
  if (!current) return pairingTransition(null, false, { released: false });
  const input = closedKeys(
    releaseValue,
    new Set(["id", "claimId", "connectionId"]),
    "MCP pairing repository release",
    500,
  );
  const idValue = normalizeMcpPairingChallengeId(input.id, 500);
  const claimId = normalizeMcpPairingClaimId(input.claimId, 500);
  const connectionId = normalizeMcpPairingConnectionId(input.connectionId, 500);
  if (current.id !== idValue) fail(500, "pairing-recovery", "MCP pairing repository identity changed");
  if (current.state !== "claimed"
      || current.claimId !== claimId
      || current.connection?.id !== connectionId) {
    return pairingTransition(current, false, { released: false });
  }
  const next = normalizeMcpPairingSession({
    ...current,
    state: "open",
    claimId: null,
    claimedAt: null,
    claimExpiresAt: null,
    consumedAt: null,
    connection: null,
  });
  return pairingTransition(next, true, { released: true });
}

export function consumeMcpPairingSessionState(currentValue, consumeValue, nowValue) {
  const current = currentPairingSession(currentValue);
  if (!current) fail(409, "pairing-session-changed", "MCP pairing session claim is no longer current");
  const input = closedKeys(
    consumeValue,
    new Set(["id", "claimId", "connectionId"]),
    "MCP pairing repository consumption",
    500,
  );
  const idValue = normalizeMcpPairingChallengeId(input.id, 500);
  const claimId = normalizeMcpPairingClaimId(input.claimId, 500);
  const connectionId = normalizeMcpPairingConnectionId(input.connectionId, 500);
  const observed = pairingRepositoryDate(nowValue);
  if (current.id !== idValue) fail(500, "pairing-recovery", "MCP pairing repository identity changed");
  if (current.state !== "claimed"
      || current.claimId !== claimId
      || current.connection?.id !== connectionId
      || Date.parse(current.claimExpiresAt) <= observed.getTime()) {
    fail(409, "pairing-session-changed", "MCP pairing session claim is no longer current");
  }
  const next = normalizeMcpPairingSession({
    ...current,
    state: "consumed",
    consumedAt: observed.toISOString(),
  });
  return pairingTransition(next, true);
}

export class MemoryMcpPairingRepository {
  constructor({
    now = () => new Date(),
    claimLifetimeMs = MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS,
  } = {}) {
    if (typeof now !== "function") throw new TypeError("MCP pairing repository requires a clock");
    this.sessions = new Map();
    this.now = now;
    this.claimLifetimeMs = claimLifetimeMs;
  }

  currentDate() {
    return pairingRepositoryDate(this.now());
  }

  async putSession(sessionValue) {
    const session = normalizeMcpPairingSession(sessionValue);
    const transition = putMcpPairingSessionState(this.sessions.get(session.id) ?? null, session);
    this.sessions.set(session.id, clonePairingValue(transition.session, "MCP pairing session"));
    return clonePairingValue(transition.session, "MCP pairing session");
  }

  async getSession(idValue) {
    const idValueNormalized = normalizeMcpPairingChallengeId(idValue, 500);
    const value = this.sessions.get(idValueNormalized);
    return value ? clonePairingValue(normalizeMcpPairingSession(value), "MCP pairing session") : null;
  }

  async claimSession(idValue, root, claimIdValue, connectionValue) {
    const idValueNormalized = normalizeMcpPairingChallengeId(idValue, 500);
    const transition = claimMcpPairingSessionState(
      this.sessions.get(idValueNormalized) ?? null,
      { id: idValueNormalized, root, claimId: claimIdValue, connection: connectionValue },
      this.currentDate(),
      this.claimLifetimeMs,
    );
    this.sessions.set(idValueNormalized, clonePairingValue(transition.session, "MCP pairing session"));
    return clonePairingValue(transition.session, "MCP pairing session");
  }

  async releaseSession(idValue, claimIdValue, connectionIdValue) {
    const idValueNormalized = normalizeMcpPairingChallengeId(idValue, 500);
    const transition = releaseMcpPairingSessionState(
      this.sessions.get(idValueNormalized) ?? null,
      { id: idValueNormalized, claimId: claimIdValue, connectionId: connectionIdValue },
    );
    if (transition.changed) {
      this.sessions.set(idValueNormalized, clonePairingValue(transition.session, "MCP pairing session"));
    }
    return transition.released;
  }

  async consumeSession(idValue, claimIdValue, connectionIdValue) {
    const idValueNormalized = normalizeMcpPairingChallengeId(idValue, 500);
    const transition = consumeMcpPairingSessionState(
      this.sessions.get(idValueNormalized) ?? null,
      { id: idValueNormalized, claimId: claimIdValue, connectionId: connectionIdValue },
      this.currentDate(),
    );
    this.sessions.set(idValueNormalized, clonePairingValue(transition.session, "MCP pairing session"));
    return clonePairingValue(transition.session, "MCP pairing session");
  }

  async getConnection(connectionIdValue) {
    const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
    const challengeId = mcpChallengeIdForConnection(connectionId);
    const session = this.sessions.get(challengeId);
    if (!session) return null;
    const normalized = normalizeMcpPairingSession(session);
    if (normalized.state !== "consumed" || normalized.connection?.id !== connectionId) return null;
    return clonePairingValue(normalized.connection, "MCP connection");
  }

  async get(connectionIdValue) {
    return this.getConnection(connectionIdValue);
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
        || typeof repository.getConnection !== "function") {
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
    const issued = pairingRepositoryDate(this.now());
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
      claimExpiresAt: null,
      consumedAt: null,
      connection: null,
    });
    normalizeMcpPairingSession(session);
    await this.repository.putSession(session);
    return stablePublicChallenge(challenge);
  }

  async authorize({ challengeId, assertion, completeAuthorization }) {
    if (typeof completeAuthorization !== "function") throw new TypeError("MCP pairing requires an OAuth completion function");
    const requestedId = id(challengeId, "MCP pairing challenge id", CHALLENGE_ID);
    const stored = await this.repository.getSession(requestedId);
    if (!stored) fail(404, "pairing-session-missing", "MCP pairing session does not exist");
    const session = normalizeMcpPairingSession(stored);
    const observed = pairingRepositoryDate(this.now());
    const observedAt = observed.getTime();
    if (session.state === "consumed"
        || (session.state === "claimed" && Date.parse(session.claimExpiresAt) > observedAt)) {
      fail(409, "pairing-session-used", "MCP pairing session is already in use");
    }
    if (Date.parse(session.challenge.expiresAt) <= observedAt) {
      fail(403, "pairing-challenge-expired", "MCP pairing challenge expired");
    }
    if (session.challenge.root !== await challengeRoot(session.challenge, this.cryptoProvider)) {
      fail(500, "pairing-recovery", "Stored MCP pairing challenge root is invalid");
    }
    if (session.challenge.requestDigest !== await sha256(canonical(session.oauthRequest), this.cryptoProvider)) {
      fail(500, "pairing-recovery", "Stored OAuth authorization request changed");
    }
    const verified = await verifyAssertion(assertion, session.challenge, {
      now: () => new Date(observed),
      cryptoProvider: this.cryptoProvider,
    });
    const claimId = secureUuid(this.randomUUID, "MCP pairing claim");
    const issued = pairingRepositoryDate(this.now());
    const connection = normalizeConnection({
      protocol: "greenways-mcp-connection/1",
      id: mcpConnectionIdForClaim(session.id, claimId),
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
    await this.repository.claimSession(
      session.id,
      session.challenge.root,
      claimId,
      connection,
    );

    try {
      const oauthResult = await completeAuthorization({
        oauthRequest: session.oauthRequest,
        identity: verified.identity,
        device: verified.device,
        connection,
      });
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
        pairedAt: pairingRepositoryDate(this.now()).toISOString(),
      });
      validateBoundedPublicValue(receipt, "MCP pairing receipt");
      await this.repository.consumeSession(session.id, claimId, connection.id);
      return Object.freeze({ connection, receipt, oauthResult });
    } catch (cause) {
      await this.repository.releaseSession(session.id, claimId, connection.id).catch(() => {});
      if (cause instanceof McpPairingError) throw cause;
      fail(502, "oauth-authorization-failed", "MCP OAuth authorization could not be completed", { cause });
    }
  }
}
