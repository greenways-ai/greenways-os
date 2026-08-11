import { canonical, sha256 } from "./protocol.js";

export const MCP_ACCESS_PROTOCOL = "greenways-mcp-access/0-alpha";
export const MCP_ACCESS_MESSAGE_TYPE = "greenways/mcp-authorization";
export const MCP_ACCESS_APP_ID = "mcp-access";
export const MCP_ACCESS_CAPABILITY = "mcp/pair";
export const MCP_ACCESS_ORIGIN = "https://mcp.greenways.ai";
export const MCP_ACCESS_ORIGINS = Object.freeze([`${MCP_ACCESS_ORIGIN}/*`]);
export const MCP_ACCESS_SCRIPT_ID = "greenways-mcp-authorization";
export const MCP_ACCESS_SCRIPT = "dist/mcp-authorization-bridge.js";
export const MCP_ACCESS_PATH = "/authorize";

export const MCP_PAIRING_CHALLENGE_PROTOCOL = "greenways-mcp-pairing-challenge/0-alpha";
export const MCP_PAIRING_ASSERTION_PROTOCOL = "greenways-mcp-pairing-assertion/0-alpha";
export const MCP_PAIRING_ALGORITHM = "ECDSA-P256-SHA256";
export const MCP_PAIRING_SCOPE = "greenways.read";

export const MCP_READ_TOOLS = Object.freeze([
  "greenways.status",
  "apps.list",
  "apps.get",
  "work.list",
  "work.get",
  "resources.search",
  "resources.read",
  "receipts.get",
  "chats.search",
]);

const CHALLENGE_ID = /^mcp\/challenge\/[A-Za-z0-9._:-]{8,160}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,200}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_CHALLENGE_BYTES = 32 * 1024;
const MAX_CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const CHALLENGE_KEYS = new Set([
  "protocol", "id", "client", "scopes", "tools", "requestDigest",
  "nonce", "issuedAt", "expiresAt", "root",
]);
const CLIENT_KEYS = new Set(["id", "name", "uri"]);
const DEVICE_KEYS = new Set(["id", "name", "kind"]);
const PUBLIC_KEY_KEYS = new Set(["kty", "crv", "x", "y", "ext", "key_ops"]);

function errorWithCode(message, code = "INVALID_REQUEST") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw errorWithCode(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw errorWithCode(`${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw errorWithCode(`${label} contains an unsupported field: ${key}`);
  }
  return input;
}

function string(value, label, maximum = 200) {
  if (typeof value !== "string") throw errorWithCode(`${label} must be a string`);
  const output = value.trim();
  if (!output || output.length > maximum) throw errorWithCode(`${label} is invalid`);
  return output;
}

function identifier(value, label, pattern = IDENTIFIER) {
  const output = string(value, label);
  if (!pattern.test(output)) throw errorWithCode(`${label} is invalid`);
  return output;
}

function canonicalTime(value, label) {
  const output = string(value, label, 80);
  if (!Number.isFinite(Date.parse(output)) || new Date(output).toISOString() !== output) {
    throw errorWithCode(`${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function normalizeClient(value) {
  const input = closedKeys(value, CLIENT_KEYS, "MCP pairing client");
  const uri = input.uri === null ? null : string(input.uri, "MCP pairing client URI", 2048);
  if (uri !== null) {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      throw errorWithCode("MCP pairing client URI is invalid");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw errorWithCode("MCP pairing client URI must use HTTPS or loopback HTTP");
    }
  }
  return Object.freeze({
    id: identifier(input.id, "MCP pairing client id"),
    name: string(input.name, "MCP pairing client name", 120),
    uri,
  });
}

function expectedList(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length
      || value.some((entry, index) => entry !== expected[index])) {
    throw errorWithCode(`${label} is not the reviewed Greenways read set`);
  }
  return Object.freeze([...value]);
}

export function normalizeMcpPublicKey(value) {
  const input = closedKeys(value, PUBLIC_KEY_KEYS, "MCP pairing public key");
  if (input.kty !== "EC" || input.crv !== "P-256"
      || typeof input.x !== "string" || !input.x
      || typeof input.y !== "string" || !input.y
      || input.ext !== true
      || !Array.isArray(input.key_ops)
      || input.key_ops.length !== 1
      || input.key_ops[0] !== "verify") {
    throw errorWithCode("MCP pairing requires a public P-256 verification key");
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

export function normalizeMcpPairingDevice(value) {
  const input = closedKeys(value, DEVICE_KEYS, "MCP pairing device");
  if (input.kind !== "browser-extension") {
    throw errorWithCode("MCP pairing requires the reviewed Greenways browser extension");
  }
  return Object.freeze({
    id: identifier(input.id, "MCP pairing device id"),
    name: string(input.name, "MCP pairing device name", 100),
    kind: "browser-extension",
  });
}

export async function normalizeMcpPairingChallenge(value, {
  now = () => new Date(),
  requireCurrent = true,
} = {}) {
  const input = closedKeys(value, CHALLENGE_KEYS, "MCP pairing challenge");
  if (input.protocol !== MCP_PAIRING_CHALLENGE_PROTOCOL) {
    throw errorWithCode("MCP pairing challenge protocol is unsupported");
  }
  const requestDigest = string(input.requestDigest, "MCP pairing request digest", 80);
  const root = string(input.root, "MCP pairing challenge root", 80);
  if (!DIGEST.test(requestDigest) || !DIGEST.test(root)) {
    throw errorWithCode("MCP pairing challenge digest is invalid");
  }
  const issuedAt = canonicalTime(input.issuedAt, "MCP pairing challenge issuedAt");
  const expiresAt = canonicalTime(input.expiresAt, "MCP pairing challenge expiresAt");
  const issuedTime = Date.parse(issuedAt);
  const expiresTime = Date.parse(expiresAt);
  const current = now();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
    throw errorWithCode("MCP pairing challenge clock is unavailable", "RUNTIME_UNAVAILABLE");
  }
  if (expiresTime <= issuedTime || expiresTime - issuedTime > MAX_CHALLENGE_LIFETIME_MS) {
    throw errorWithCode("MCP pairing challenge lifetime is invalid");
  }
  if (issuedTime > current.getTime() + MAX_CLOCK_SKEW_MS
      || (requireCurrent && expiresTime <= current.getTime())) {
    throw errorWithCode("MCP pairing challenge is outside its accepted time window", "CHALLENGE_EXPIRED");
  }
  const challenge = Object.freeze({
    protocol: MCP_PAIRING_CHALLENGE_PROTOCOL,
    id: identifier(input.id, "MCP pairing challenge id", CHALLENGE_ID),
    client: normalizeClient(input.client),
    scopes: expectedList(input.scopes, [MCP_PAIRING_SCOPE], "MCP pairing scopes"),
    tools: expectedList(input.tools, MCP_READ_TOOLS, "MCP pairing tools"),
    requestDigest,
    nonce: string(input.nonce, "MCP pairing challenge nonce", 80),
    issuedAt,
    expiresAt,
    root,
  });
  if (byteLength(challenge) > MAX_CHALLENGE_BYTES) {
    throw errorWithCode("MCP pairing challenge exceeds its byte limit", "REQUEST_TOO_LARGE");
  }
  const { root: _root, ...body } = challenge;
  if (root !== await sha256(canonical(body))) {
    throw errorWithCode("MCP pairing challenge content does not match its root", "CHALLENGE_ROOT_INVALID");
  }
  return challenge;
}

export function isApprovedMcpAuthorizationPage(value) {
  try {
    const url = new URL(value);
    return url.origin === MCP_ACCESS_ORIGIN && url.pathname === MCP_ACCESS_PATH;
  } catch {
    return false;
  }
}
