import {
  createHash,
  generateKeyPairSync,
  sign as signBytes,
  webcrypto,
} from "node:crypto";

export const HOME_DISCOVERY_PROTOCOL = "greenways-home/1";
export const HOME_PAIR_PROTOCOL = "greenways-home-pair/1";
export const HOME_PAIR_RECEIPT_PROTOCOL = "greenways-home-paired/1";
export const HOME_AUTH_PROTOCOL = "greenways-home-auth/1";
export const HOME_STATUS_PROTOCOL = "greenways-home-status/1";
export const HOME_UNPAIR_PROTOCOL = "greenways-home-unpaired/1";
export const HOME_ERROR_PROTOCOL = "greenways-home-error/1";
export const HOME_NODE_ALGORITHM = "ECDSA-P256-SHA256";

const encoder = new TextEncoder();
const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIRING_CODE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_NONCE_AGE_MS = 10 * 60 * 1000;

export class HomeNodeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HomeNodeError";
    this.status = status;
    this.code = code;
  }
}

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(",")}}`;
}

export async function sha256(value, cryptoProvider = webcrypto) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HomeNodeError(400, "invalid-request", `${label} must be an object`);
  }
  return value;
}

function string(value, label, maximum = 160) {
  if (typeof value !== "string") {
    throw new HomeNodeError(400, "invalid-request", `${label} must be a string`);
  }
  const output = value.trim();
  if (!output || output.length > maximum) {
    throw new HomeNodeError(400, "invalid-request", `${label} is invalid`);
  }
  return output;
}

function identifier(value, label) {
  const output = string(value, label, 80).toLowerCase();
  if (!IDENTIFIER.test(output)) {
    throw new HomeNodeError(400, "invalid-request", `${label} must be a lowercase identifier`);
  }
  return output;
}

function serviceDescriptor(value, index) {
  const input = plainObject(value, `Service ${index}`);
  const output = {
    id: identifier(input.id, `Service ${index} id`),
    name: string(input.name, `Service ${index} name`, 80),
    kind: identifier(input.kind, `Service ${index} kind`),
    capabilities: Object.freeze((input.capabilities ?? []).map((entry, capabilityIndex) => (
      identifier(entry, `Service ${index} capability ${capabilityIndex}`)
    ))),
    status: input.status === undefined ? "available" : identifier(input.status, `Service ${index} status`),
  };
  if (input.version !== undefined) output.version = string(input.version, `Service ${index} version`, 80);
  return Object.freeze(output);
}

function publicDevice(value) {
  const input = plainObject(value, "Pairing device");
  const key = plainObject(input.publicKey, "Pairing device public key");
  if (input.kind !== "browser-extension" || input.algorithm !== HOME_NODE_ALGORITHM) {
    throw new HomeNodeError(400, "unsupported-device", "Only signed Greenways browser devices can pair");
  }
  if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string" || key.d !== undefined) {
    throw new HomeNodeError(400, "invalid-device-key", "Pairing requires a public P-256 JWK without private material");
  }
  return Object.freeze({
    id: identifier(input.id, "Pairing device id"),
    name: string(input.name, "Pairing device name", 80),
    kind: "browser-extension",
    algorithm: HOME_NODE_ALGORITHM,
    publicKey: Object.freeze({
      kty: "EC",
      crv: "P-256",
      x: key.x,
      y: key.y,
      ext: true,
      key_ops: ["verify"],
    }),
  });
}

function formatPairingCode(bytes) {
  const compact = [...bytes].map((byte) => PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]).join("");
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function normalizePairingCode(value) {
  const output = string(value, "Pairing code", 12).toUpperCase().replace(/\s+/g, "");
  const compact = output.replaceAll("-", "");
  const formatted = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  if (!PAIRING_CODE.test(formatted)) {
    throw new HomeNodeError(400, "invalid-pairing-code", "Pairing code is invalid");
  }
  return formatted;
}

function cloneServices(services) {
  return services.map((service) => ({
    ...service,
    capabilities: [...service.capabilities],
  }));
}

function createNodeIdentity(id, name, suppliedKeyPair = null) {
  const pair = suppliedKeyPair || generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ format: "jwk" });
  const publicJwk = Object.freeze({
    kty: "EC",
    crv: "P-256",
    x: publicKey.x,
    y: publicKey.y,
    ext: true,
    key_ops: ["verify"],
  });
  const keyId = `sha256:${createHash("sha256").update(canonical(publicJwk)).digest("hex")}`;
  return {
    public: Object.freeze({
      id: identifier(id, "Home node id"),
      name: string(name, "Home node name", 80),
      keyId,
      algorithm: HOME_NODE_ALGORITHM,
      publicKey: publicJwk,
    }),
    privateKey: pair.privateKey,
  };
}

export class GreenwaysHomeNode {
  constructor({
    id = "greenways-home",
    name = "Greenways Home",
    services = [],
    now = () => new Date(),
    cryptoProvider = webcrypto,
    nodeKeyPair = null,
    pairingLifetimeMs = 10 * 60 * 1000,
    onPairingCode = () => {},
  } = {}) {
    const identity = createNodeIdentity(id, name, nodeKeyPair);
    this.node = identity.public;
    this.nodePrivateKey = identity.privateKey;
    this.services = Object.freeze(services.map(serviceDescriptor));
    this.now = now;
    this.cryptoProvider = cryptoProvider;
    this.pairingLifetimeMs = pairingLifetimeMs;
    this.onPairingCode = onPairingCode;
    this.devices = new Map();
    this.usedNonces = new Map();
    this.pairing = null;
  }

  signRecord(record) {
    const signature = signBytes(
      "sha256",
      Buffer.from(canonical(record)),
      { key: this.nodePrivateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url");
    return Object.freeze({ ...record, signature });
  }

  issuePairingCode() {
    const bytes = this.cryptoProvider.getRandomValues(new Uint8Array(8));
    const code = formatPairingCode(bytes);
    const issuedAt = this.now();
    this.pairing = Object.freeze({
      code,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + this.pairingLifetimeMs).toISOString(),
    });
    this.onPairingCode(code, this.pairing);
    return this.pairing;
  }

  pairingAvailable() {
    return Boolean(this.pairing && new Date(this.pairing.expiresAt).getTime() >= this.now().getTime());
  }

  discovery() {
    return this.signRecord({
      protocol: HOME_DISCOVERY_PROTOCOL,
      node: this.node,
      pairing: { available: this.pairingAvailable() },
      services: cloneServices(this.services),
      issuedAt: this.now().toISOString(),
    });
  }

  pair(request) {
    const input = plainObject(request, "Pair request");
    if (input.protocol !== HOME_PAIR_PROTOCOL) {
      throw new HomeNodeError(400, "unsupported-protocol", "Unsupported home pairing protocol");
    }
    if (!this.pairingAvailable()) {
      throw new HomeNodeError(409, "pairing-unavailable", "The home node is not accepting a browser pairing");
    }
    const code = normalizePairingCode(input.code);
    if (code !== this.pairing.code) {
      throw new HomeNodeError(403, "pairing-denied", "The one-time pairing code was not accepted");
    }
    const device = publicDevice(input.device);
    if (this.devices.has(device.id)) {
      throw new HomeNodeError(409, "device-exists", "This browser device is already paired");
    }
    const pairedAt = this.now().toISOString();
    const record = {
      ...device,
      pairedAt,
      lastSeenAt: pairedAt,
    };
    this.devices.set(device.id, record);
    this.pairing = null;

    return this.signRecord({
      protocol: HOME_PAIR_RECEIPT_PROTOCOL,
      node: this.node,
      device: { id: device.id, name: device.name, pairedAt },
      scopes: ["presence.read", "services.read", "device.unpair"],
      services: cloneServices(this.services),
      issuedAt: this.now().toISOString(),
    });
  }

  pruneNonces() {
    const cutoff = this.now().getTime() - MAX_NONCE_AGE_MS;
    for (const [key, timestamp] of this.usedNonces) {
      if (timestamp < cutoff) this.usedNonces.delete(key);
    }
  }

  async authenticate(request, method, path) {
    const input = plainObject(request, "Signed home request");
    const envelope = plainObject(input.envelope, "Signed home request envelope");
    if (input.protocol !== HOME_AUTH_PROTOCOL || envelope.protocol !== HOME_AUTH_PROTOCOL) {
      throw new HomeNodeError(400, "unsupported-protocol", "Unsupported signed home request protocol");
    }
    if (envelope.method !== method || envelope.path !== path) {
      throw new HomeNodeError(401, "request-mismatch", "The signed request target does not match this endpoint");
    }
    const deviceId = identifier(envelope.deviceId, "Signed request device id");
    const device = this.devices.get(deviceId);
    if (!device) throw new HomeNodeError(401, "unknown-device", "This browser is not paired with the home node");

    const timestamp = new Date(string(envelope.timestamp, "Signed request timestamp", 80));
    if (!Number.isFinite(timestamp.getTime())) {
      throw new HomeNodeError(400, "invalid-timestamp", "Signed request timestamp is invalid");
    }
    if (Math.abs(this.now().getTime() - timestamp.getTime()) > MAX_CLOCK_SKEW_MS) {
      throw new HomeNodeError(401, "expired-request", "Signed request timestamp is outside the accepted window");
    }

    const nonce = string(envelope.nonce, "Signed request nonce", 120);
    const nonceKey = `${deviceId}:${nonce}`;
    this.pruneNonces();
    if (this.usedNonces.has(nonceKey)) {
      throw new HomeNodeError(409, "replayed-request", "This signed request nonce was already used");
    }

    if (envelope.bodyHash !== await sha256(canonical(input.body), this.cryptoProvider)) {
      throw new HomeNodeError(401, "body-modified", "The signed request body was modified");
    }
    if (typeof input.signature !== "string" || !input.signature) {
      throw new HomeNodeError(401, "missing-signature", "The signed request is missing its signature");
    }

    let valid = false;
    try {
      const key = await this.cryptoProvider.subtle.importKey(
        "jwk",
        device.publicKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      valid = await this.cryptoProvider.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        Buffer.from(input.signature, "base64url"),
        encoder.encode(canonical(envelope)),
      );
    } catch {
      valid = false;
    }
    if (!valid) throw new HomeNodeError(401, "invalid-signature", "Browser request signature is invalid");

    this.usedNonces.set(nonceKey, this.now().getTime());
    device.lastSeenAt = this.now().toISOString();
    return { device, body: input.body };
  }

  async status(request) {
    const { device, body } = await this.authenticate(request, "POST", "/greenways/v1/status");
    if (plainObject(body, "Home presence").protocol !== "greenways-home-presence/1") {
      throw new HomeNodeError(400, "unsupported-presence", "Unsupported browser presence record");
    }
    return this.signRecord({
      protocol: HOME_STATUS_PROTOCOL,
      node: this.node,
      browsers: [...this.devices.values()].map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        pairedAt: candidate.pairedAt,
        lastSeenAt: candidate.lastSeenAt,
        current: candidate.id === device.id,
      })),
      services: cloneServices(this.services),
      serverTime: this.now().toISOString(),
    });
  }

  async unpair(request) {
    const { device, body } = await this.authenticate(request, "POST", "/greenways/v1/unpair");
    if (plainObject(body, "Home unpair request").protocol !== "greenways-home-unpair/1") {
      throw new HomeNodeError(400, "unsupported-unpair", "Unsupported browser unpair record");
    }
    this.devices.delete(device.id);
    return this.signRecord({
      protocol: HOME_UNPAIR_PROTOCOL,
      node: this.node,
      deviceId: device.id,
      unpairedAt: this.now().toISOString(),
    });
  }
}
