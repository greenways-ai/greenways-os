import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
} from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  GreenwaysHomeNode,
  HOME_NODE_ALGORITHM,
  HomeNodeError,
  canonical,
} from "./home-node.js";

export const HOME_NODE_STATE_PROTOCOL = "greenways-home-state/0-alpha";

const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_DEVICES = 4096;
const MAX_NONCES = 16384;

function stateError(message, cause = undefined) {
  return new Error(message, cause === undefined ? undefined : { cause });
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw stateError(`${label} must be an object`);
  }
  return value;
}

function exactFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw stateError(`${label} contains unsupported field ${key}`);
  }
}

function nonEmptyString(value, label, maximum = 160) {
  if (typeof value !== "string") throw stateError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw stateError(`${label} cannot be empty`);
  if (output.length > maximum) throw stateError(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function identifier(value, label) {
  const output = nonEmptyString(value, label, 80).toLowerCase();
  if (!IDENTIFIER.test(output)) throw stateError(`${label} must be a lowercase identifier`);
  return output;
}

function isoTimestamp(value, label) {
  const output = nonEmptyString(value, label, 80);
  const instant = new Date(output);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== output) {
    throw stateError(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return output;
}

function normalizePublicKey(value, label) {
  const key = plainObject(value, label);
  exactFields(key, new Set(["kty", "crv", "x", "y", "ext", "key_ops"]), label);
  if (key.kty !== "EC" || key.crv !== "P-256" || typeof key.x !== "string" || typeof key.y !== "string") {
    throw stateError(`${label} must be a P-256 public JWK`);
  }
  if (key.d !== undefined) throw stateError(`${label} cannot contain private key material`);
  if (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || key.key_ops.some((entry) => entry !== "verify"))) {
    throw stateError(`${label}.key_ops may contain verify only`);
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: key.x,
    y: key.y,
    ext: key.ext === undefined ? true : Boolean(key.ext),
    key_ops: ["verify"],
  };
}

function normalizeNodeRecord(value) {
  const node = plainObject(value, "Home Node state node");
  exactFields(node, new Set(["id", "name", "keyId", "algorithm", "publicKey"]), "Home Node state node");
  const keyId = nonEmptyString(node.keyId, "Home Node state node.keyId", 72);
  if (!SHA256.test(keyId)) throw stateError("Home Node state node.keyId must be a SHA-256 identifier");
  if (node.algorithm !== HOME_NODE_ALGORITHM) throw stateError("Home Node state node.algorithm is not supported");
  return {
    id: identifier(node.id, "Home Node state node.id"),
    name: nonEmptyString(node.name, "Home Node state node.name", 80),
    keyId,
    algorithm: HOME_NODE_ALGORITHM,
    publicKey: normalizePublicKey(node.publicKey, "Home Node state node.publicKey"),
  };
}

function normalizeDeviceRecord(value, index) {
  const label = `Home Node state devices[${index}]`;
  const device = plainObject(value, label);
  exactFields(
    device,
    new Set(["id", "name", "kind", "algorithm", "publicKey", "pairedAt", "lastSeenAt"]),
    label,
  );
  if (device.kind !== "browser-extension") throw stateError(`${label}.kind is not supported`);
  if (device.algorithm !== HOME_NODE_ALGORITHM) throw stateError(`${label}.algorithm is not supported`);
  return {
    id: identifier(device.id, `${label}.id`),
    name: nonEmptyString(device.name, `${label}.name`, 80),
    kind: "browser-extension",
    algorithm: HOME_NODE_ALGORITHM,
    publicKey: normalizePublicKey(device.publicKey, `${label}.publicKey`),
    pairedAt: isoTimestamp(device.pairedAt, `${label}.pairedAt`),
    lastSeenAt: isoTimestamp(device.lastSeenAt, `${label}.lastSeenAt`),
  };
}

function normalizeNonceRecord(value, index) {
  const label = `Home Node state usedNonces[${index}]`;
  const nonce = plainObject(value, label);
  exactFields(nonce, new Set(["key", "timestamp"]), label);
  const timestamp = Number(nonce.timestamp);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw stateError(`${label}.timestamp must be a non-negative millisecond timestamp`);
  }
  return {
    key: nonEmptyString(nonce.key, `${label}.key`, 320),
    timestamp,
  };
}

function normalizeState(value) {
  const state = plainObject(value, "Home Node state");
  exactFields(
    state,
    new Set(["protocol", "savedAt", "node", "privateKeyPem", "devices", "usedNonces"]),
    "Home Node state",
  );
  if (state.protocol !== HOME_NODE_STATE_PROTOCOL) throw stateError("Unsupported Home Node state protocol");
  const devices = Array.isArray(state.devices) ? state.devices : null;
  const usedNonces = Array.isArray(state.usedNonces) ? state.usedNonces : null;
  if (!devices || devices.length > MAX_DEVICES) throw stateError(`Home Node state devices must contain at most ${MAX_DEVICES} entries`);
  if (!usedNonces || usedNonces.length > MAX_NONCES) throw stateError(`Home Node state usedNonces must contain at most ${MAX_NONCES} entries`);

  const normalizedDevices = devices.map(normalizeDeviceRecord);
  const deviceIds = normalizedDevices.map(({ id }) => id);
  if (new Set(deviceIds).size !== deviceIds.length) throw stateError("Home Node state contains duplicate browser devices");

  const normalizedNonces = usedNonces.map(normalizeNonceRecord);
  const nonceKeys = normalizedNonces.map(({ key }) => key);
  if (new Set(nonceKeys).size !== nonceKeys.length) throw stateError("Home Node state contains duplicate replay nonces");

  const privateKeyPem = nonEmptyString(state.privateKeyPem, "Home Node state privateKeyPem", 8192);
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw stateError("Home Node state private key is invalid", error);
  }
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ec") {
    throw stateError("Home Node state private key must be an EC private key");
  }
  const namedCurve = privateKey.asymmetricKeyDetails?.namedCurve;
  if (namedCurve && !["prime256v1", "P-256"].includes(namedCurve)) {
    throw stateError("Home Node state private key must use P-256");
  }

  return {
    protocol: HOME_NODE_STATE_PROTOCOL,
    savedAt: isoTimestamp(state.savedAt, "Home Node state savedAt"),
    node: normalizeNodeRecord(state.node),
    privateKeyPem,
    nodeKeyPair: {
      privateKey,
      publicKey: createPublicKey(privateKey),
    },
    devices: normalizedDevices,
    usedNonces: normalizedNonces,
  };
}

function clonePublicKey(key) {
  return {
    kty: key.kty,
    crv: key.crv,
    x: key.x,
    y: key.y,
    ext: key.ext === undefined ? true : Boolean(key.ext),
    key_ops: ["verify"],
  };
}

function cloneDevice(device) {
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    algorithm: device.algorithm,
    publicKey: clonePublicKey(device.publicKey),
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function snapshotMutableState(node) {
  return {
    pairing: node.pairing,
    devices: new Map([...node.devices].map(([id, device]) => [id, cloneDevice(device)])),
    usedNonces: new Map(node.usedNonces),
  };
}

function restoreMutableState(node, state) {
  node.pairing = state.pairing;
  node.devices = new Map([...state.devices].map(([id, device]) => [id, cloneDevice(device)]));
  node.usedNonces = new Map(state.usedNonces);
}

function mutableFingerprint(state) {
  return JSON.stringify({
    pairing: state.pairing,
    devices: [...state.devices]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, device]) => [id, device]),
    usedNonces: [...state.usedNonces].sort(([left], [right]) => left.localeCompare(right)),
  });
}

function persistenceError(cause) {
  const error = new HomeNodeError(
    503,
    "state-unavailable",
    "Home Node state could not be durably committed",
  );
  error.cause = cause;
  return error;
}

function syncDirectory(path) {
  let descriptor = null;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function defaultHomeNodeStatePath() {
  return join(homedir(), ".greenways", "home-node", "state.json");
}

export class HomeNodeStateFile {
  constructor(path = defaultHomeNodeStatePath()) {
    this.path = resolve(path);
  }

  load() {
    if (!existsSync(this.path)) return null;
    const stats = lstatSync(this.path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw stateError("Home Node state path must be a regular file, not a link or directory");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw stateError("Home Node state file permissions must not grant group or world access");
    }

    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (error) {
      throw stateError("Home Node state is not valid JSON", error);
    }
    return normalizeState(parsed);
  }

  save(node) {
    node.pruneNonces();
    const directory = dirname(this.path);
    const directoryExisted = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStats = lstatSync(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw stateError("Home Node state directory must be a directory, not a link");
    }
    if (!directoryExisted && process.platform !== "win32") {
      chmodSync(directory, 0o700);
    }

    const state = {
      protocol: HOME_NODE_STATE_PROTOCOL,
      savedAt: node.now().toISOString(),
      node: {
        ...node.node,
        publicKey: clonePublicKey(node.node.publicKey),
      },
      privateKeyPem: node.nodePrivateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      devices: [...node.devices.values()]
        .map(cloneDevice)
        .sort((left, right) => left.id.localeCompare(right.id)),
      usedNonces: [...node.usedNonces]
        .map(([key, timestamp]) => ({ key, timestamp }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    };

    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let descriptor = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, this.path);
      if (process.platform !== "win32") chmodSync(this.path, 0o600);
      syncDirectory(directory);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
    }
    return state;
  }
}

function installPersistence(node, stateFile) {
  const originalPair = node.pair.bind(node);
  const originalStatus = node.status.bind(node);
  const originalUnpair = node.unpair.bind(node);

  node.pair = (request) => {
    const before = snapshotMutableState(node);
    let result;
    try {
      result = originalPair(request);
    } catch (error) {
      restoreMutableState(node, before);
      throw error;
    }
    try {
      stateFile.save(node);
      return result;
    } catch (error) {
      restoreMutableState(node, before);
      throw persistenceError(error);
    }
  };

  const wrapAuthenticatedMutation = (operation) => async (request) => {
    const before = snapshotMutableState(node);
    const beforeFingerprint = mutableFingerprint(before);
    let result;
    try {
      result = await operation(request);
    } catch (operationError) {
      const after = snapshotMutableState(node);
      if (mutableFingerprint(after) !== beforeFingerprint) {
        try {
          stateFile.save(node);
        } catch (saveError) {
          restoreMutableState(node, before);
          throw persistenceError(saveError);
        }
      }
      throw operationError;
    }
    try {
      stateFile.save(node);
      return result;
    } catch (saveError) {
      restoreMutableState(node, before);
      throw persistenceError(saveError);
    }
  };

  node.status = wrapAuthenticatedMutation(originalStatus);
  node.unpair = wrapAuthenticatedMutation(originalUnpair);

  Object.defineProperties(node, {
    statePath: {
      enumerable: true,
      value: stateFile.path,
    },
    persistState: {
      enumerable: false,
      value: () => stateFile.save(node),
    },
  });

  return node;
}

export function createPersistentHomeNode({
  statePath = defaultHomeNodeStatePath(),
  id = undefined,
  name = undefined,
  services = [],
  now = undefined,
  cryptoProvider = undefined,
  pairingLifetimeMs = undefined,
  onPairingCode = undefined,
} = {}) {
  const stateFile = new HomeNodeStateFile(statePath);
  const stored = stateFile.load();

  if (stored && id !== undefined && stored.node.id !== id) {
    throw stateError(
      `Configured Home Node id ${id} does not match persisted id ${stored.node.id}`,
    );
  }

  const node = new GreenwaysHomeNode({
    id: id ?? stored?.node.id ?? "greenways-home",
    name: name ?? stored?.node.name ?? "Greenways Home",
    services,
    ...(now === undefined ? {} : { now }),
    ...(cryptoProvider === undefined ? {} : { cryptoProvider }),
    ...(pairingLifetimeMs === undefined ? {} : { pairingLifetimeMs }),
    ...(onPairingCode === undefined ? {} : { onPairingCode }),
    ...(stored ? { nodeKeyPair: stored.nodeKeyPair } : {}),
  });

  if (stored) {
    if (
      node.node.keyId !== stored.node.keyId
      || canonical(node.node.publicKey) !== canonical(stored.node.publicKey)
    ) {
      throw stateError("Persisted Home Node public identity does not match its private key");
    }
    node.devices = new Map(stored.devices.map((device) => [device.id, cloneDevice(device)]));
    node.usedNonces = new Map(stored.usedNonces.map(({ key, timestamp }) => [key, timestamp]));
    node.pruneNonces();
  }

  installPersistence(node, stateFile);
  stateFile.save(node);
  return node;
}
