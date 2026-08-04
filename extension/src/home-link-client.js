import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonical,
  randomId,
  sha256,
} from "./protocol.js";

export const HOME_DISCOVERY_PROTOCOL = "greenways-home/1";
export const HOME_PAIR_PROTOCOL = "greenways-home-pair/1";
export const HOME_PAIR_RECEIPT_PROTOCOL = "greenways-home-paired/1";
export const HOME_AUTH_PROTOCOL = "greenways-home-auth/1";
export const HOME_STATUS_PROTOCOL = "greenways-home-status/1";
export const HOME_UNPAIR_PROTOCOL = "greenways-home-unpaired/1";
export const HOME_LINK_PROTOCOL = "greenways-home-link/1";
export const HOME_LINK_SETTINGS_KEY = "home-link";
export const HOME_NODE_ALGORITHM = "ECDSA-P256-SHA256";

const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{4}-?[A-HJ-NP-Z2-9]{4}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const encoder = new TextEncoder();

function privateRequestOptions(options = {}) {
  const request = {
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    ...options,
  };
  if (!request.signal && globalThis.AbortSignal?.timeout) {
    request.signal = AbortSignal.timeout(15_000);
  }
  return request;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function nonEmptyString(value, label, maximum = 160) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function identifier(value, label) {
  const output = nonEmptyString(value, label, 80).toLowerCase();
  if (!IDENTIFIER.test(output)) throw new Error(`${label} must be a lowercase identifier`);
  return output;
}

function sha256Identifier(value, label) {
  const output = nonEmptyString(value, label, 72);
  if (!SHA256.test(output)) throw new Error(`${label} must be a SHA-256 identifier`);
  return output;
}

function stringList(value, label, maximum = 32) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} cannot contain more than ${maximum} entries`);
  const output = value.map((entry, index) => identifier(entry, `${label}[${index}]`));
  if (new Set(output).size !== output.length) throw new Error(`${label} cannot contain duplicates`);
  return Object.freeze(output);
}

function isoTimestamp(value, label) {
  const output = nonEmptyString(value, label, 80);
  const instant = new Date(output);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== output) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return output;
}

function normalizePublicKey(value, label = "device.publicKey") {
  const key = plainObject(value, label);
  if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") {
    throw new Error(`${label} must be a P-256 public JWK`);
  }
  if (key.d !== undefined) throw new Error(`${label} cannot contain private key material`);
  return Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: key.x,
    y: key.y,
    ...(key.ext === undefined ? {} : { ext: Boolean(key.ext) }),
    ...(key.key_ops === undefined ? {} : { key_ops: [...key.key_ops] }),
  });
}

export function normalizeHomeOrigin(value) {
  const input = nonEmptyString(value, "Home server origin", 2048);
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("A home server must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new Error("Home server origins cannot contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter only the home server origin, without a path, query, or fragment");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Remote home servers must use HTTPS");
  }
  return url.origin;
}

export function normalizePairingCode(value) {
  const code = nonEmptyString(value, "Pairing code", 12).toUpperCase().replace(/\s+/g, "");
  if (!PAIRING_CODE.test(code)) {
    throw new Error("Pairing code must contain eight unambiguous letters or numbers");
  }
  const compact = code.replaceAll("-", "");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function normalizeServiceDescriptor(value, label = "service") {
  const input = plainObject(value, label);
  const allowed = new Set(["id", "name", "kind", "version", "capabilities", "status"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  const output = {
    id: identifier(input.id, `${label}.id`),
    name: nonEmptyString(input.name, `${label}.name`, 80),
    kind: identifier(input.kind, `${label}.kind`),
    capabilities: stringList(input.capabilities ?? [], `${label}.capabilities`),
    status: input.status === undefined ? "available" : identifier(input.status, `${label}.status`),
  };
  if (input.version !== undefined) output.version = nonEmptyString(input.version, `${label}.version`, 80);
  return Object.freeze(output);
}

function normalizeServices(value, label = "services") {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > 32) throw new Error(`${label} cannot contain more than 32 entries`);
  const services = value.map((entry, index) => normalizeServiceDescriptor(entry, `${label}[${index}]`));
  const ids = services.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate service ids`);
  return Object.freeze(services);
}

function normalizeNode(value, label = "node") {
  const input = plainObject(value, label);
  const allowed = new Set(["id", "name", "keyId", "algorithm", "publicKey"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  if (input.algorithm !== HOME_NODE_ALGORITHM) throw new Error(`${label}.algorithm is not supported`);
  return Object.freeze({
    id: identifier(input.id, `${label}.id`),
    name: nonEmptyString(input.name, `${label}.name`, 80),
    keyId: sha256Identifier(input.keyId, `${label}.keyId`),
    algorithm: HOME_NODE_ALGORITHM,
    publicKey: normalizePublicKey(input.publicKey, `${label}.publicKey`),
  });
}

function normalizeSignature(value, label) {
  return nonEmptyString(value, label, 512);
}

export function normalizeHomeDiscovery(value) {
  const input = plainObject(value, "Home discovery");
  if (input.protocol !== HOME_DISCOVERY_PROTOCOL) throw new Error("Unsupported Greenways home server");
  const allowed = new Set(["protocol", "node", "pairing", "services", "issuedAt", "signature"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Home discovery contains unsupported field ${key}`);
  }
  const pairing = plainObject(input.pairing, "Home discovery pairing");
  if (pairing.available !== true && pairing.available !== false) {
    throw new Error("Home discovery pairing.available must be boolean");
  }
  return Object.freeze({
    protocol: HOME_DISCOVERY_PROTOCOL,
    node: normalizeNode(input.node),
    pairing: Object.freeze({ available: pairing.available }),
    services: normalizeServices(input.services ?? []),
    issuedAt: isoTimestamp(input.issuedAt, "Home discovery issuedAt"),
    signature: normalizeSignature(input.signature, "Home discovery signature"),
  });
}

export function normalizeHomePairReceipt(value, device) {
  const input = plainObject(value, "Home pair receipt");
  if (input.protocol !== HOME_PAIR_RECEIPT_PROTOCOL) throw new Error("Invalid home pair receipt");
  const allowed = new Set(["protocol", "node", "device", "scopes", "services", "issuedAt", "signature"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Home pair receipt contains unsupported field ${key}`);
  }
  const pairedDevice = plainObject(input.device, "Home pair receipt device");
  if (pairedDevice.id !== device.id) throw new Error("Home server paired a different browser device");
  return Object.freeze({
    protocol: HOME_PAIR_RECEIPT_PROTOCOL,
    node: normalizeNode(input.node, "Home pair receipt node"),
    device: Object.freeze({
      id: identifier(pairedDevice.id, "Home pair receipt device.id"),
      name: nonEmptyString(pairedDevice.name, "Home pair receipt device.name", 80),
      pairedAt: isoTimestamp(pairedDevice.pairedAt, "Home pair receipt device.pairedAt"),
    }),
    scopes: stringList(input.scopes ?? [], "Home pair receipt scopes"),
    services: normalizeServices(input.services ?? [], "Home pair receipt services"),
    issuedAt: isoTimestamp(input.issuedAt, "Home pair receipt issuedAt"),
    signature: normalizeSignature(input.signature, "Home pair receipt signature"),
  });
}

function normalizeBrowser(value, label) {
  const input = plainObject(value, label);
  return Object.freeze({
    id: identifier(input.id, `${label}.id`),
    name: nonEmptyString(input.name, `${label}.name`, 80),
    pairedAt: isoTimestamp(input.pairedAt, `${label}.pairedAt`),
    lastSeenAt: isoTimestamp(input.lastSeenAt, `${label}.lastSeenAt`),
    current: Boolean(input.current),
  });
}

export function normalizeHomeStatus(value) {
  const input = plainObject(value, "Home status");
  if (input.protocol !== HOME_STATUS_PROTOCOL) throw new Error("Invalid home status response");
  const allowed = new Set(["protocol", "node", "browsers", "services", "serverTime", "signature"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Home status contains unsupported field ${key}`);
  }
  if (!Array.isArray(input.browsers)) throw new TypeError("Home status browsers must be an array");
  return Object.freeze({
    protocol: HOME_STATUS_PROTOCOL,
    node: normalizeNode(input.node, "Home status node"),
    browsers: Object.freeze(input.browsers.map((entry, index) => normalizeBrowser(entry, `Home status browsers[${index}]`))),
    services: normalizeServices(input.services ?? [], "Home status services"),
    serverTime: isoTimestamp(input.serverTime, "Home status serverTime"),
    signature: normalizeSignature(input.signature, "Home status signature"),
  });
}

function normalizeHomeUnpair(value, deviceId) {
  const input = plainObject(value, "Home unpair response");
  if (input.protocol !== HOME_UNPAIR_PROTOCOL || input.deviceId !== deviceId) {
    throw new Error("Invalid home unpair response");
  }
  const allowed = new Set(["protocol", "node", "deviceId", "unpairedAt", "signature"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Home unpair response contains unsupported field ${key}`);
  }
  return Object.freeze({
    protocol: HOME_UNPAIR_PROTOCOL,
    node: normalizeNode(input.node, "Home unpair node"),
    deviceId: identifier(input.deviceId, "Home unpair deviceId"),
    unpairedAt: isoTimestamp(input.unpairedAt, "Home unpair unpairedAt"),
    signature: normalizeSignature(input.signature, "Home unpair signature"),
  });
}

function sameNodeIdentity(actual, expected) {
  return actual.id === expected.id
    && actual.keyId === expected.keyId
    && actual.algorithm === expected.algorithm
    && canonical(actual.publicKey) === canonical(expected.publicKey);
}

export async function verifyHomeNodeRecord(record, expectedNode = null, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) throw new Error("Web Crypto is required to verify the home node");
  if (record.node.keyId !== await sha256(canonical(record.node.publicKey))) {
    throw new Error("The home node key identifier does not match its public key");
  }
  if (expectedNode && !sameNodeIdentity(record.node, expectedNode)) {
    throw new Error("The home node identity changed");
  }
  const { signature, ...body } = record;
  const key = await cryptoProvider.subtle.importKey(
    "jwk",
    record.node.publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await cryptoProvider.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlToBytes(signature),
    encoder.encode(canonical(body)),
  );
  if (!valid) throw new Error("The home node signature is invalid");
  return record;
}

export async function requestHomeOriginAccess(origin, permissions = globalThis.chrome?.permissions) {
  const pattern = `${normalizeHomeOrigin(origin)}/*`;
  if (!permissions) return true;
  const granted = await permissions.request({ origins: [pattern] });
  if (!granted) throw new Error("Home server access was not granted");
  return true;
}

export async function revokeHomeOriginAccess(origin, permissions = globalThis.chrome?.permissions) {
  const pattern = `${normalizeHomeOrigin(origin)}/*`;
  if (!permissions) return true;
  const request = { origins: [pattern] };
  if (await permissions.remove(request)) return true;
  if (permissions.contains && !await permissions.contains(request)) return true;
  throw new Error("Home server origin access could not be revoked");
}

export async function createHomeDevice(name, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) throw new Error("Web Crypto is required to pair this browser");
  const deviceName = nonEmptyString(name, "Browser name", 80);
  const keys = await cryptoProvider.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicKey = normalizePublicKey(await cryptoProvider.subtle.exportKey("jwk", keys.publicKey));
  const idBytes = cryptoProvider.getRandomValues(new Uint8Array(16));
  const deviceId = `browser.${[...idBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return Object.freeze({
    id: deviceId,
    name: deviceName,
    kind: "browser-extension",
    algorithm: HOME_NODE_ALGORITHM,
    publicKey,
    privateKey: keys.privateKey,
  });
}

function requireExact(value, expected, label) {
  if (value !== expected) throw new Error(`${label} is not supported`);
  return expected;
}

function normalizedDeviceForPairing(device) {
  const input = plainObject(device, "Browser device");
  return Object.freeze({
    id: identifier(input.id, "Browser device.id"),
    name: nonEmptyString(input.name, "Browser device.name", 80),
    kind: requireExact(input.kind, "browser-extension", "Browser device.kind"),
    algorithm: requireExact(input.algorithm, HOME_NODE_ALGORITHM, "Browser device.algorithm"),
    publicKey: normalizePublicKey(input.publicKey),
  });
}

export async function createSignedHomeRequest({
  device,
  method,
  path,
  body,
  now = new Date(),
  nonce = randomId("nonce"),
  cryptoProvider = globalThis.crypto,
}) {
  const input = plainObject(device, "Paired browser device");
  if (!input.privateKey) throw new Error("Paired browser device is missing its private key");
  if (!cryptoProvider?.subtle) throw new Error("Web Crypto is required to sign home requests");
  const requestMethod = nonEmptyString(method, "Home request method", 12).toUpperCase();
  const requestPath = nonEmptyString(path, "Home request path", 160);
  if (!requestPath.startsWith("/greenways/")) throw new Error("Home request path is outside the Greenways API");
  const timestamp = (now instanceof Date ? now : new Date(now)).toISOString();
  const envelope = Object.freeze({
    protocol: HOME_AUTH_PROTOCOL,
    deviceId: identifier(input.id, "Paired browser device.id"),
    method: requestMethod,
    path: requestPath,
    timestamp,
    nonce: nonEmptyString(nonce, "Home request nonce", 120),
    bodyHash: await sha256(canonical(body)),
  });
  const signature = new Uint8Array(await cryptoProvider.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    input.privateKey,
    encoder.encode(canonical(envelope)),
  ));
  return Object.freeze({
    protocol: HOME_AUTH_PROTOCOL,
    envelope,
    body,
    signature: bytesToBase64Url(signature),
  });
}

export class HomeLinkClient {
  constructor({ origin, request = fetch, cryptoProvider = globalThis.crypto }) {
    this.origin = normalizeHomeOrigin(origin);
    this.request = request;
    this.cryptoProvider = cryptoProvider;
  }

  async discover() {
    const response = await this.request(
      `${this.origin}/.well-known/greenways-home`,
      privateRequestOptions(),
    );
    if (!response.ok) throw new Error(`Home server discovery failed: ${response.status}`);
    const discovery = normalizeHomeDiscovery(await response.json());
    return verifyHomeNodeRecord(discovery, null, this.cryptoProvider);
  }

  async pair({ code, device, node }) {
    if (!node) throw new Error("Home pairing requires a verified discovery record");
    const pairedDevice = normalizedDeviceForPairing(device);
    const response = await this.request(`${this.origin}/greenways/v1/pair`, {
      ...privateRequestOptions(),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: HOME_PAIR_PROTOCOL,
        code: normalizePairingCode(code),
        device: pairedDevice,
      }),
    });
    if (!response.ok) throw new Error(`Home server pairing failed: ${response.status}`);
    const receipt = normalizeHomePairReceipt(await response.json(), pairedDevice);
    return verifyHomeNodeRecord(receipt, node, this.cryptoProvider);
  }

  async status(connection, presence = {}) {
    const payload = await createSignedHomeRequest({
      device: connection.device,
      method: "POST",
      path: "/greenways/v1/status",
      body: {
        ...presence,
        protocol: "greenways-home-presence/1",
      },
      cryptoProvider: this.cryptoProvider,
    });
    const response = await this.request(`${this.origin}/greenways/v1/status`, {
      ...privateRequestOptions(),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Home server status failed: ${response.status}`);
    const status = normalizeHomeStatus(await response.json());
    return verifyHomeNodeRecord(status, connection.node, this.cryptoProvider);
  }

  async unpair(connection) {
    const payload = await createSignedHomeRequest({
      device: connection.device,
      method: "POST",
      path: "/greenways/v1/unpair",
      body: { protocol: "greenways-home-unpair/1" },
      cryptoProvider: this.cryptoProvider,
    });
    const response = await this.request(`${this.origin}/greenways/v1/unpair`, {
      ...privateRequestOptions(),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Home server unpair failed: ${response.status}`);
    const result = normalizeHomeUnpair(await response.json(), connection.device.id);
    return verifyHomeNodeRecord(result, connection.node, this.cryptoProvider);
  }
}

export function createHomeLinkRecord({ origin, receipt, device }) {
  if (!device?.privateKey) throw new Error("Home link record requires a non-extractable browser key");
  return Object.freeze({
    protocol: HOME_LINK_PROTOCOL,
    origin: normalizeHomeOrigin(origin),
    node: receipt.node,
    device: Object.freeze({
      id: device.id,
      name: device.name,
      kind: device.kind,
      algorithm: device.algorithm,
      publicKey: device.publicKey,
      privateKey: device.privateKey,
      pairedAt: receipt.device.pairedAt,
    }),
    scopes: receipt.scopes,
    services: receipt.services,
  });
}
