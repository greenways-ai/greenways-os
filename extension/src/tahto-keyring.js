import { canonical, sha256 } from "./protocol.js";
import { normalizeTahtoOrigin } from "./tahto-client.js";
import { store, withOriginLock } from "./storage.js";

export const TAHTO_DEVICE_KEY_PROTOCOL = "greenways-tahto-device-key/0-alpha";
export const TAHTO_DEVICE_REQUEST_PROTOCOL = "tahto.device-request/0-alpha";
export const TAHTO_SIGNATURE_PROTOCOL = "tahto-signature/0-alpha";
export const TAHTO_KEY_ALGORITHM = "p256-sha256";
export const TAHTO_PAIRING_INTENT_PROTOCOL = "tahto.pairing-intent/0-alpha";

const IDENTIFIER = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const OPERATION = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const FORBIDDEN_KEY = /^(?:__proto__|constructor|prototype|secret|password|token|api[-_]?key|private[-_]?key|authorization|bearer)$/i;
const MAXIMUM_PAYLOAD_BYTES = 1024 * 1024;

function webCrypto(value = globalThis.crypto) {
  if (!value?.subtle || !value?.getRandomValues) throw new Error("Web Crypto is unavailable");
  return value;
}

function requiredString(value, label, maximum = 240) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function identifier(value, label) {
  const output = requiredString(value, label, 120);
  if (!IDENTIFIER.test(output)) throw new Error(`${label} must be a lowercase identifier`);
  return output;
}

function operation(value) {
  const output = requiredString(value, "Tahto operation", 80);
  if (!OPERATION.test(output)) throw new Error("Tahto operation must use the dotted operation vocabulary");
  return output;
}

function timestamp(value, label) {
  const output = requiredString(value, label, 80);
  const parsed = Date.parse(output);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== output) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function plainPortable(value, label, depth = 0) {
  if (depth > 16) throw new Error(`${label} exceeds the maximum depth`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${label} numbers must be safe integers`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new Error(`${label} contains too many entries`);
    return Object.freeze(value.map((entry, index) => plainPortable(entry, `${label}[${index}]`, depth + 1)));
  }
  if (!value || typeof value !== "object") throw new TypeError(`${label} must be portable JSON data`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be plain portable data`);
  const entries = Object.entries(value);
  if (entries.length > 4096) throw new Error(`${label} contains too many fields`);
  const output = {};
  for (const [key, child] of entries) {
    if (!key || key.length > 120 || FORBIDDEN_KEY.test(key)) throw new Error(`${label} contains forbidden field ${key}`);
    output[key] = plainPortable(child, `${label}.${key}`, depth + 1);
  }
  return Object.freeze(output);
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value, label) {
  const input = requiredString(value, label, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error(`${label} is not canonical base64url`);
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function canonicalPublicJwk(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Tahto public JWK must be an object");
  const keys = Object.keys(value);
  if (keys.some((key) => !["kty", "crv", "x", "y", "key_ops", "ext"].includes(key))) {
    throw new Error("Tahto public JWK contains unsupported fields");
  }
  if (value.kty !== "EC" || value.crv !== "P-256") throw new Error("Tahto device keys must use P-256");
  if (value.ext !== true || !Array.isArray(value.key_ops) || value.key_ops.join(",") !== "verify") {
    throw new Error("Tahto public JWK must be an extractable verification key");
  }
  const x = encodeBase64Url(decodeBase64Url(value.x, "Tahto public JWK.x"));
  const y = encodeBase64Url(decodeBase64Url(value.y, "Tahto public JWK.y"));
  if (decodeBase64Url(x, "Tahto public JWK.x").length !== 32 || decodeBase64Url(y, "Tahto public JWK.y").length !== 32) {
    throw new Error("Tahto public JWK coordinates must contain 32 bytes");
  }
  return Object.freeze({ crv: "P-256", ext: true, key_ops: Object.freeze(["verify"]), kty: "EC", x, y });
}

export function publicJwkToSec1(value) {
  const jwk = canonicalPublicJwk(value);
  return Uint8Array.from([4, ...decodeBase64Url(jwk.x, "Tahto public JWK.x"), ...decodeBase64Url(jwk.y, "Tahto public JWK.y")]);
}

export function encodeTahtoPublicKey(value) {
  return `p256:${encodeBase64Url(new TextEncoder().encode(canonical(canonicalPublicJwk(value))))}`;
}

function randomToken(random, bytes = 16) {
  return encodeBase64Url(random.getRandomValues(new Uint8Array(bytes)));
}

function publicRecord(record) {
  return Object.freeze({
    protocol: TAHTO_DEVICE_KEY_PROTOCOL,
    origin: record.origin,
    algorithm: record.algorithm,
    publicKey: record.publicKey,
    publicKeyJwk: record.publicKeyJwk,
    keyId: record.keyId,
    deviceId: record.deviceId,
    nodeId: record.nodeId,
    createdAt: record.createdAt,
    privateKeyExtractable: false,
  });
}

function validateStoredKey(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Stored Tahto device key is invalid");
  if (record.protocol !== TAHTO_DEVICE_KEY_PROTOCOL) throw new Error("Stored Tahto device key uses an unsupported protocol");
  const origin = normalizeTahtoOrigin(record.origin);
  if (record.algorithm !== TAHTO_KEY_ALGORITHM) throw new Error("Stored Tahto device key uses an unsupported algorithm");
  const publicKeyJwk = canonicalPublicJwk(record.publicKeyJwk);
  const publicKey = encodeTahtoPublicKey(publicKeyJwk);
  if (record.publicKey !== publicKey) throw new Error("Stored Tahto public key does not match its JWK");
  if (typeof record.keyId !== "string" || !DIGEST.test(record.keyId)) throw new Error("Stored Tahto key id is invalid");
  if (!record.privateKey || record.privateKey.type !== "private" || record.privateKey.extractable !== false) {
    throw new Error("Stored Tahto private key must be non-extractable");
  }
  return Object.freeze({
    protocol: TAHTO_DEVICE_KEY_PROTOCOL,
    origin,
    algorithm: TAHTO_KEY_ALGORITHM,
    publicKey,
    publicKeyJwk,
    keyId: record.keyId,
    privateKey: record.privateKey,
    deviceId: record.deviceId === null ? null : identifier(record.deviceId, "Tahto device id"),
    nodeId: record.nodeId === null ? null : identifier(record.nodeId, "Tahto node id"),
    createdAt: timestamp(record.createdAt, "Tahto key creation time"),
  });
}

export class TahtoKeyring {
  constructor({
    repository = store,
    crypto = globalThis.crypto,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!repository || typeof repository.get !== "function" || typeof repository.put !== "function" || typeof repository.delete !== "function") {
      throw new TypeError("Tahto Keyring requires a durable repository");
    }
    if (typeof now !== "function") throw new TypeError("Tahto Keyring clock must be a function");
    this.repository = repository;
    this.crypto = webCrypto(crypto);
    this.now = now;
  }

  storageKey(origin) {
    return `tahto:${normalizeTahtoOrigin(origin)}`;
  }

  async get(origin) {
    const value = await this.repository.get("identity", this.storageKey(origin));
    return value ? validateStoredKey(value) : null;
  }

  async create(originValue) {
    const origin = normalizeTahtoOrigin(originValue);
    return withOriginLock(`tahto-key:${origin}`, async () => {
      if (await this.get(origin)) throw new Error("A Tahto device key already exists for this node");
      const pair = await this.crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const publicKeyJwk = canonicalPublicJwk(await this.crypto.subtle.exportKey("jwk", pair.publicKey));
      const publicKey = encodeTahtoPublicKey(publicKeyJwk);
      const record = validateStoredKey({
        protocol: TAHTO_DEVICE_KEY_PROTOCOL,
        origin,
        algorithm: TAHTO_KEY_ALGORITHM,
        publicKey,
        publicKeyJwk,
        keyId: await sha256(publicKey),
        privateKey: pair.privateKey,
        deviceId: null,
        nodeId: null,
        createdAt: this.now(),
      });
      await this.repository.put("identity", this.storageKey(origin), record);
      return publicRecord(record);
    });
  }

  async bind(originValue, { deviceId, nodeId }) {
    const origin = normalizeTahtoOrigin(originValue);
    return withOriginLock(`tahto-key:${origin}`, async () => {
      const record = await this.get(origin);
      if (!record) throw new Error("Tahto device key does not exist");
      const next = validateStoredKey({ ...record, deviceId, nodeId });
      await this.repository.put("identity", this.storageKey(origin), next);
      return publicRecord(next);
    });
  }

  async status(origin) {
    const record = await this.get(origin);
    return record ? publicRecord(record) : null;
  }

  async remove(originValue) {
    const origin = normalizeTahtoOrigin(originValue);
    return withOriginLock(`tahto-key:${origin}`, async () => {
      const record = await this.get(origin);
      if (!record) return Object.freeze({ removed: false, origin });
      await this.repository.delete("identity", this.storageKey(origin));
      return Object.freeze({ removed: true, origin, keyId: record.keyId, deviceId: record.deviceId });
    });
  }

  async signPairingIntent(originValue, intentValue, intentDigestValue) {
    const origin = normalizeTahtoOrigin(originValue);
    const key = await this.get(origin);
    if (!key) throw new Error("Tahto device key does not exist");
    if (key.deviceId || key.nodeId) throw new Error("Tahto device key is already paired with this node");
    const intent = plainPortable(intentValue, "Tahto pairing intent");
    if (intent.protocol !== TAHTO_PAIRING_INTENT_PROTOCOL) throw new Error("Unsupported Tahto pairing intent protocol");
    if (intent["public-key"] !== key.publicKey || intent.algorithm !== key.algorithm) {
      throw new Error("Tahto pairing intent does not bind this device key");
    }
    const intentDigest = requiredString(intentDigestValue, "Tahto pairing intent digest", 71);
    if (!DIGEST.test(intentDigest)) throw new Error("Tahto pairing intent digest is invalid");
    if (await sha256(canonical(intent)) !== intentDigest) throw new Error("Tahto pairing intent digest does not match the exact intent");
    const signature = new Uint8Array(await this.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(`${TAHTO_PAIRING_INTENT_PROTOCOL}\n${intentDigest}`),
    ));
    if (signature.byteLength !== 64) throw new Error("Tahto P-256 signature must use the 64-byte P1363 profile");
    return Object.freeze({
      profile: TAHTO_SIGNATURE_PROTOCOL,
      algorithm: TAHTO_KEY_ALGORITHM,
      keyId: key.keyId,
      value: encodeBase64Url(signature),
    });
  }

  async signRequest(originValue, requestValue, {
    nonce,
    idempotencyKey,
    now = this.now,
  } = {}) {
    const origin = normalizeTahtoOrigin(originValue);
    const key = await this.get(origin);
    if (!key?.deviceId || !key?.nodeId) throw new Error("Tahto device key is not paired with this node");
    const request = plainPortable(requestValue, "Tahto request");
    const payload = plainPortable(request.payload, "Tahto request.payload");
    const requestTimestamp = timestamp(now(), "Tahto request.timestamp");
    const unsigned = Object.freeze({
      protocol: TAHTO_DEVICE_REQUEST_PROTOCOL,
      device: key.deviceId,
      publicKey: key.publicKey,
      algorithm: TAHTO_KEY_ALGORITHM,
      operation: operation(request.operation),
      application: identifier(request.application, "Tahto request.application"),
      namespace: identifier(request.namespace, "Tahto request.namespace"),
      collection: identifier(request.collection, "Tahto request.collection"),
      timestamp: requestTimestamp,
      timestampSeconds: Math.floor(Date.parse(requestTimestamp) / 1000),
      nonce: requiredString(nonce || randomToken(this.crypto), "Tahto request.nonce", 512),
      idempotencyKey: requiredString(idempotencyKey || randomToken(this.crypto), "Tahto request.idempotencyKey", 512),
      payload,
    });
    const bytes = new TextEncoder().encode(canonical(unsigned));
    if (bytes.byteLength > MAXIMUM_PAYLOAD_BYTES) throw new Error("Tahto request exceeds the 1 MiB signing limit");
    const requestDigest = await sha256(canonical(unsigned));
    const message = new TextEncoder().encode(`${TAHTO_DEVICE_REQUEST_PROTOCOL}\n${requestDigest}`);
    const signature = new Uint8Array(await this.crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      message,
    ));
    if (signature.byteLength !== 64) throw new Error("Tahto P-256 signature must use the 64-byte P1363 profile");
    return Object.freeze({
      ...unsigned,
      requestDigest,
      signature: Object.freeze({
        profile: TAHTO_SIGNATURE_PROTOCOL,
        algorithm: TAHTO_KEY_ALGORITHM,
        keyId: key.keyId,
        value: encodeBase64Url(signature),
      }),
    });
  }
}
