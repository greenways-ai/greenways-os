export const TAHTO_NODE_PROTOCOL = "tahto.node/1";
export const TAHTO_HEALTH_PROTOCOL = "tahto.health/1";
export const TAHTO_STATUS_PROTOCOL = "tahto.status/1";
export const TAHTO_LINK_PROTOCOL = "greenways-tahto-nodes/1";
export const TAHTO_SETTINGS_KEY = "tahto-nodes";
export const TAHTO_PAIRING_PREPARE_PROTOCOL = "tahto.pairing-prepare/1";
export const TAHTO_PAIRING_COMPLETE_PROTOCOL = "tahto.pairing-complete/1";
export const TAHTO_PAIRING_INTENT_PROTOCOL = "tahto.pairing-intent/1";
export const TAHTO_PAIRING_PREPARE_RESULT_PROTOCOL = "tahto.pairing-prepare-result/1";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const IDENTIFIER = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9]{0,79}$/;
const MAXIMUM_JSON_BYTES = 1024 * 1024;
const FORBIDDEN_EXECUTABLE_FIELD = /^(?:remote[-_])?(?:code|executable|html|javascript|module|script|source|entrypoint|wasm|hal)(?:[-_]?url)?$/i;

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

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(plainObject(value, label))) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function assertNoExecutableFields(value, label = "Tahto response", seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`${label} cannot contain cyclic data`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EXECUTABLE_FIELD.test(key)) {
      throw new Error(`${label} cannot contain executable field ${key}`);
    }
    assertNoExecutableFields(child, `${label}.${key}`, seen);
  }
  seen.delete(value);
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

function fieldName(value, label) {
  const output = requiredString(value, label, 80);
  if (!FIELD_NAME.test(output)) throw new Error(`${label} must be an identifier field name`);
  return output;
}

function exact(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be ${String(expected)}`);
  return expected;
}

function stringRecord(value, label, allowedKeys) {
  const input = plainObject(value, label);
  assertKeys(input, allowedKeys, label);
  const output = {};
  for (const key of allowedKeys) {
    if (!(key in input)) throw new Error(`${label}.${key} is required`);
    output[key] = requiredString(input[key], `${label}.${key}`, 240);
  }
  return Object.freeze(output);
}

function timestamp(value, label) {
  const output = requiredString(value, label, 80);
  const parsed = Date.parse(output);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== output) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function pairingTimestamp(value, label) {
  const output = requiredString(value, label, 80);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(output)
      || !Number.isFinite(Date.parse(output))) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function privateRequestOptions(options = {}) {
  const output = {
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    ...options,
  };
  if (!output.signal && globalThis.AbortSignal?.timeout) {
    output.signal = AbortSignal.timeout(10_000);
  }
  return output;
}

async function boundedJson(response, label) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new Error(`${label} did not return JSON`);
  }
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > MAXIMUM_JSON_BYTES) {
    throw new Error(`${label} exceeded the 1 MiB control-response limit`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function encodeBase64UrlText(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizePairingResult(value) {
  const input = plainObject(value, "Tahto pairing result");
  assertNoExecutableFields(input, "Tahto pairing result");
  assertKeys(input, new Set(["protocol", "node", "device", "administrator", "grants"]), "Tahto pairing result");
  if (!Array.isArray(input.grants) || input.grants.length !== 0) throw new Error("Tahto pairing must not mint grants");
  return Object.freeze({
    protocol: exact(input.protocol, "tahto.pairing-result/1", "Tahto pairing result.protocol"),
    node: identifier(input.node, "Tahto pairing result.node"),
    device: identifier(input.device, "Tahto pairing result.device"),
    administrator: exact(input.administrator, false, "Tahto pairing result.administrator"),
    grants: Object.freeze([]),
  });
}

function normalizePairingPrepareResult(value) {
  const input = plainObject(value, "Tahto pairing prepare result");
  assertNoExecutableFields(input, "Tahto pairing prepare result");
  assertKeys(input, new Set(["protocol", "intent", "intentDigest"]), "Tahto pairing prepare result");
  const intent = plainObject(input.intent, "Tahto pairing intent");
  const fields = new Set([
    "protocol", "invitation", "node", "device", "public-key",
    "algorithm", "prepared-at", "expires-at",
  ]);
  assertKeys(intent, fields, "Tahto pairing intent");
  for (const field of fields) {
    if (!(field in intent)) throw new Error(`Tahto pairing intent.${field} is required`);
  }
  return Object.freeze({
    protocol: exact(input.protocol, TAHTO_PAIRING_PREPARE_RESULT_PROTOCOL, "Tahto pairing prepare result.protocol"),
    intent: Object.freeze({
      protocol: exact(intent.protocol, TAHTO_PAIRING_INTENT_PROTOCOL, "Tahto pairing intent.protocol"),
      invitation: identifier(intent.invitation, "Tahto pairing intent.invitation"),
      node: identifier(intent.node, "Tahto pairing intent.node"),
      device: identifier(intent.device, "Tahto pairing intent.device"),
      "public-key": requiredString(intent["public-key"], "Tahto pairing intent.public-key", 2048),
      algorithm: exact(intent.algorithm, "p256-sha256", "Tahto pairing intent.algorithm"),
      "prepared-at": pairingTimestamp(intent["prepared-at"], "Tahto pairing intent.prepared-at"),
      "expires-at": pairingTimestamp(intent["expires-at"], "Tahto pairing intent.expires-at"),
    }),
    intentDigest: requiredString(input.intentDigest, "Tahto pairing intent digest", 71),
  });
}

function normalizeSemanticResult(value, operation) {
  const input = plainObject(value, "Tahto semantic result");
  assertNoExecutableFields(input, "Tahto semantic result");
  assertKeys(input, new Set(["protocol", "operation", "status", "value", "plan", "receipt", "error"]), "Tahto semantic result");
  const output = {
    protocol: exact(input.protocol, "tahto.semantic-result/1", "Tahto semantic result.protocol"),
    operation: exact(input.operation, operation, "Tahto semantic result.operation"),
    status: requiredString(input.status, "Tahto semantic result.status", 40),
  };
  for (const key of ["value", "plan", "receipt", "error"]) {
    if (key in input) output[key] = structuredClone(input[key]);
  }
  return Object.freeze(output);
}

export function normalizeTahtoOrigin(value) {
  const input = requiredString(value, "Tahto origin", 2048);
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Tahto must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Tahto origin cannot contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter only the Tahto origin, without a path, query, or fragment");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("A Tahto node away from this machine must use HTTPS");
  }
  return url.origin;
}

export function tahtoPermissionPattern(value) {
  return `${normalizeTahtoOrigin(value)}/*`;
}

export async function requestTahtoOriginAccess(origin, permissions = globalThis.chrome?.permissions) {
  const pattern = tahtoPermissionPattern(origin);
  if (!permissions) return true;
  const request = { origins: [pattern] };
  if (permissions.contains && await permissions.contains(request)) return true;
  if (!await permissions.request(request)) throw new Error("Tahto origin access was not granted");
  return true;
}

export async function revokeTahtoOriginAccess(origin, permissions = globalThis.chrome?.permissions) {
  const request = { origins: [tahtoPermissionPattern(origin)] };
  if (!permissions) return true;
  if (await permissions.remove(request)) return true;
  if (permissions.contains && !await permissions.contains(request)) return true;
  throw new Error("Tahto origin access could not be revoked");
}

export function normalizeTahtoDescriptor(value) {
  const input = plainObject(value, "Tahto descriptor");
  assertNoExecutableFields(input, "Tahto descriptor");
  assertKeys(input, new Set([
    "protocol", "id", "name", "role", "runtime", "authority", "boundaries",
    "routes", "components", "compatibility",
  ]), "Tahto descriptor");
  const runtime = stringRecord(input.runtime, "Tahto runtime", new Set([
    "applicationServer", "language", "namespace", "edge",
  ]));
  const authority = stringRecord(input.authority, "Tahto authority", new Set([
    "installation", "consent", "privateKeys", "custody", "meaning",
  ]));
  const boundaries = plainObject(input.boundaries, "Tahto boundaries");
  const boundaryKeys = new Set([
    "conflicts", "remoteExecutableCatalogue", "hostedSpaceRequired", "largeObjectBodies",
    "signedRecords", "devicePairing", "requestReplay", "metadataTransactions", "metadataHost",
    "objectHost", "serviceDescriptors", "workerExecution", "semanticSchemas",
  ]);
  assertKeys(boundaries, boundaryKeys, "Tahto boundaries");
  for (const key of boundaryKeys) {
    if (!(key in boundaries)) throw new Error(`Tahto boundaries.${key} is required`);
  }
  const routeInput = plainObject(input.routes, "Tahto routes");
  assertKeys(routeInput, new Set(["discovery", "health", "status", "pairingPrepare", "pairingComplete"]), "Tahto routes");
  const routes = {};
  for (const key of ["discovery", "health", "status"]) {
    if (!(key in routeInput)) throw new Error(`Tahto routes.${key} is required`);
    routes[key] = requiredString(routeInput[key], `Tahto routes.${key}`, 240);
  }
  for (const key of ["pairingPrepare", "pairingComplete"]) {
    if (key in routeInput) routes[key] = requiredString(routeInput[key], `Tahto routes.${key}`, 240);
  }
  if (("pairingPrepare" in routes) !== ("pairingComplete" in routes)) {
    throw new Error("Tahto pairing prepare and complete routes must be advertised together");
  }
  const components = plainObject(input.components, "Tahto components");
  if (Object.keys(components).length > 64) throw new Error("Tahto components cannot exceed 64 entries");
  const normalizedComponents = {};
  for (const [key, componentStatus] of Object.entries(components)) {
    normalizedComponents[fieldName(key, `Tahto component ${key}`)] = requiredString(
      componentStatus,
      `Tahto component ${key} status`,
      160,
    );
  }
  const compatibility = stringRecord(input.compatibility, "Tahto compatibility", new Set(["greenwaysBeacon"]));
  return Object.freeze({
    protocol: exact(input.protocol, TAHTO_NODE_PROTOCOL, "Tahto descriptor.protocol"),
    id: exact(input.id, "greenways.tahto", "Tahto descriptor.id"),
    name: requiredString(input.name, "Tahto descriptor.name", 80),
    role: exact(input.role, "application-state-fabric", "Tahto descriptor.role"),
    runtime,
    authority,
    boundaries: Object.freeze({ ...boundaries }),
    routes: Object.freeze({
      discovery: exact(routes.discovery, "/.well-known/tahto", "Tahto routes.discovery"),
      health: exact(routes.health, "/tahto/v1/health", "Tahto routes.health"),
      status: exact(routes.status, "/tahto/v1/status", "Tahto routes.status"),
      ...(routes.pairingPrepare ? {
        pairingPrepare: exact(routes.pairingPrepare, "/tahto/v1/pairing/prepare", "Tahto routes.pairingPrepare"),
        pairingComplete: exact(routes.pairingComplete, "/tahto/v1/pairing/complete", "Tahto routes.pairingComplete"),
      } : {}),
    }),
    components: Object.freeze(normalizedComponents),
    compatibility,
  });
}

export function normalizeTahtoHealth(value) {
  const input = plainObject(value, "Tahto health");
  assertNoExecutableFields(input, "Tahto health");
  assertKeys(input, new Set(["protocol", "status", "runtime", "scope"]), "Tahto health");
  return Object.freeze({
    protocol: exact(input.protocol, TAHTO_HEALTH_PROTOCOL, "Tahto health.protocol"),
    status: identifier(input.status, "Tahto health.status"),
    runtime: identifier(input.runtime, "Tahto health.runtime"),
    scope: requiredString(input.scope, "Tahto health.scope", 160),
  });
}

export function normalizeTahtoStatus(value) {
  const input = plainObject(value, "Tahto status");
  assertNoExecutableFields(input, "Tahto status");
  assertKeys(input, new Set(["protocol", "node", "fabric", "hostedSpace"]), "Tahto status");
  const node = stringRecord(input.node, "Tahto status.node", new Set(["status", "phase", "mode"]));
  const fabric = plainObject(input.fabric, "Tahto status.fabric");
  if (Object.keys(fabric).length > 64) throw new Error("Tahto status.fabric cannot exceed 64 entries");
  const normalizedFabric = {};
  for (const [key, status] of Object.entries(fabric)) {
    normalizedFabric[fieldName(key, `Tahto fabric ${key}`)] = requiredString(status, `Tahto fabric ${key} status`, 160);
  }
  const hostedSpace = plainObject(input.hostedSpace, "Tahto status.hostedSpace");
  assertKeys(hostedSpace, new Set(["required", "adapter"]), "Tahto status.hostedSpace");
  return Object.freeze({
    protocol: exact(input.protocol, TAHTO_STATUS_PROTOCOL, "Tahto status.protocol"),
    node,
    fabric: Object.freeze(normalizedFabric),
    hostedSpace: Object.freeze({
      required: exact(hostedSpace.required, false, "Tahto status.hostedSpace.required"),
      adapter: requiredString(hostedSpace.adapter, "Tahto status.hostedSpace.adapter", 160),
    }),
  });
}

export class TahtoClient {
  constructor({ origin, request = fetch, keyring = null }) {
    this.origin = normalizeTahtoOrigin(origin);
    if (typeof request !== "function") throw new TypeError("Tahto client request must be a function");
    this.request = request;
    this.keyring = keyring;
  }

  async get(path, label, normalize) {
    const response = await this.request(
      `${this.origin}${path}`,
      privateRequestOptions({ headers: { accept: "application/json" } }),
    );
    if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
    return normalize(await boundedJson(response, label));
  }

  discover() {
    return this.get("/.well-known/tahto", "Tahto discovery", normalizeTahtoDescriptor);
  }

  health() {
    return this.get("/tahto/v1/health", "Tahto health", normalizeTahtoHealth);
  }

  status() {
    return this.get("/tahto/v1/status", "Tahto status", normalizeTahtoStatus);
  }

  async inspect() {
    const descriptor = await this.discover();
    const [health, status] = await Promise.all([this.health(), this.status()]);
    return Object.freeze({ descriptor, health, status });
  }

  async postEnvelope(path, header, envelope, label, normalize) {
    const encoded = encodeBase64UrlText(canonical(envelope));
    if (encoded.length > 1_398_102) throw new Error(`${label} exceeds the 1 MiB envelope limit`);
    const response = await this.request(`${this.origin}${path}`, privateRequestOptions({
      method: "POST",
      headers: { accept: "application/json", [header]: encoded },
    }));
    const body = await boundedJson(response, label);
    if (!response.ok) throw new Error(body?.error?.code || `${label} failed: ${response.status}`);
    return normalize(body);
  }

  async pair(invitationValue) {
    if (!this.keyring) throw new Error("Tahto pairing requires a device keyring");
    const invitation = requiredString(invitationValue, "Tahto invitation", 512);
    let key = await this.keyring.status(this.origin);
    if (!key) key = await this.keyring.create(this.origin);
    if (key.deviceId || key.nodeId) throw new Error("This browser key is already paired with the Tahto node");
    const device = `device.${key.keyId.slice(7, 31)}`;
    const preparedAt = new Date().toISOString();
    const prepared = await this.postEnvelope(
      "/tahto/v1/pairing/prepare",
      "x-tahto-pairing",
      {
        protocol: TAHTO_PAIRING_PREPARE_PROTOCOL,
        invitation,
        device,
        publicKey: key.publicKey,
        algorithm: key.algorithm,
        preparedAt,
      },
      "Tahto pairing prepare",
      normalizePairingPrepareResult,
    );
    const invitationId = invitation.slice(0, invitation.indexOf("~"));
    if (prepared.intent.invitation !== invitationId || prepared.intent.device !== device
        || prepared.intent["public-key"] !== key.publicKey || prepared.intent.algorithm !== key.algorithm) {
      throw new Error("Tahto pairing intent does not match the requested browser identity");
    }
    const signature = await this.keyring.signPairingIntent(this.origin, prepared.intent, prepared.intentDigest);
    const result = await this.postEnvelope(
      "/tahto/v1/pairing/complete",
      "x-tahto-pairing",
      {
        protocol: TAHTO_PAIRING_COMPLETE_PROTOCOL,
        invitation,
        acceptedAt: new Date().toISOString(),
        intent: prepared.intent,
        signature,
      },
      "Tahto pairing complete",
      normalizePairingResult,
    );
    if (result.device !== device) throw new Error("Tahto paired a different device identity");
    await this.keyring.bind(this.origin, { deviceId: result.device, nodeId: result.node });
    return result;
  }

  async semantic(operation, coordinate, payload, options) {
    if (!this.keyring) throw new Error("Tahto semantic operations require a device keyring");
    if (!["semantic.read", "semantic.prepare", "semantic.submit"].includes(operation)) {
      throw new Error("Unsupported Tahto semantic operation");
    }
    const signed = await this.keyring.signRequest(this.origin, {
      operation,
      application: coordinate.application,
      namespace: coordinate.namespace,
      collection: coordinate.collection,
      payload,
    }, options);
    return this.postEnvelope(
      `/tahto/v1/semantic/${operation.slice("semantic.".length)}`,
      "x-tahto-request",
      signed,
      `Tahto ${operation}`,
      (value) => normalizeSemanticResult(value, operation),
    );
  }

  read(coordinate, payload = {}, options) {
    return this.semantic("semantic.read", coordinate, payload, options);
  }

  prepare(coordinate, payload, options) {
    return this.semantic("semantic.prepare", coordinate, payload, options);
  }

  submit(coordinate, payload, options) {
    return this.semantic("semantic.submit", coordinate, payload, options);
  }
}

function normalizeNodeRecord(value, index = 0) {
  const input = plainObject(value, `Tahto node ${index}`);
  assertKeys(input, new Set([
    "origin", "label", "descriptor", "health", "status", "connectedAt", "checkedAt",
  ]), `Tahto node ${index}`);
  const origin = normalizeTahtoOrigin(input.origin);
  return Object.freeze({
    origin,
    label: requiredString(input.label, `Tahto node ${index}.label`, 80),
    descriptor: normalizeTahtoDescriptor(input.descriptor),
    health: normalizeTahtoHealth(input.health),
    status: normalizeTahtoStatus(input.status),
    connectedAt: timestamp(input.connectedAt, `Tahto node ${index}.connectedAt`),
    checkedAt: timestamp(input.checkedAt, `Tahto node ${index}.checkedAt`),
  });
}

export function normalizeTahtoNodeState(value) {
  if (!value) return Object.freeze({ protocol: TAHTO_LINK_PROTOCOL, defaultOrigin: null, nodes: Object.freeze([]) });
  const input = plainObject(value, "Stored Tahto nodes");
  assertKeys(input, new Set(["protocol", "defaultOrigin", "nodes"]), "Stored Tahto nodes");
  exact(input.protocol, TAHTO_LINK_PROTOCOL, "Stored Tahto nodes.protocol");
  if (!Array.isArray(input.nodes)) throw new TypeError("Stored Tahto nodes.nodes must be an array");
  if (input.nodes.length > 32) throw new Error("No more than 32 Tahto nodes may be stored");
  const nodes = input.nodes.map(normalizeNodeRecord);
  if (new Set(nodes.map(({ origin }) => origin)).size !== nodes.length) {
    throw new Error("Stored Tahto node origins must be unique");
  }
  const defaultOrigin = input.defaultOrigin === null
    ? null
    : normalizeTahtoOrigin(input.defaultOrigin);
  if (defaultOrigin && !nodes.some(({ origin }) => origin === defaultOrigin)) {
    throw new Error("The default Tahto origin must identify a stored node");
  }
  return Object.freeze({ protocol: TAHTO_LINK_PROTOCOL, defaultOrigin, nodes: Object.freeze(nodes) });
}

export function createTahtoNodeRecord({ origin, label, descriptor, health, status }, now = () => new Date().toISOString()) {
  const checkedAt = timestamp(now(), "Tahto node check time");
  return normalizeNodeRecord({
    origin,
    label: label || descriptor?.name || "Tahto",
    descriptor,
    health,
    status,
    connectedAt: checkedAt,
    checkedAt,
  });
}

export function upsertTahtoNode(stateValue, nodeValue) {
  const state = normalizeTahtoNodeState(stateValue);
  const node = normalizeNodeRecord(nodeValue);
  const previous = state.nodes.find((entry) => entry.origin === node.origin);
  const nextNode = previous ? Object.freeze({ ...node, connectedAt: previous.connectedAt }) : node;
  const nodes = [...state.nodes.filter((entry) => entry.origin !== node.origin), nextNode]
    .sort((left, right) => left.origin.localeCompare(right.origin));
  return normalizeTahtoNodeState({
    protocol: TAHTO_LINK_PROTOCOL,
    defaultOrigin: state.defaultOrigin ?? node.origin,
    nodes,
  });
}

export function setDefaultTahtoNode(stateValue, originValue) {
  const state = normalizeTahtoNodeState(stateValue);
  const origin = normalizeTahtoOrigin(originValue);
  if (!state.nodes.some((node) => node.origin === origin)) throw new Error("Tahto node is not stored");
  return normalizeTahtoNodeState({ ...state, defaultOrigin: origin });
}

export function removeTahtoNode(stateValue, originValue) {
  const state = normalizeTahtoNodeState(stateValue);
  const origin = normalizeTahtoOrigin(originValue);
  const nodes = state.nodes.filter((node) => node.origin !== origin);
  if (nodes.length === state.nodes.length) throw new Error("Tahto node is not stored");
  return normalizeTahtoNodeState({
    protocol: TAHTO_LINK_PROTOCOL,
    defaultOrigin: state.defaultOrigin === origin ? (nodes[0]?.origin ?? null) : state.defaultOrigin,
    nodes,
  });
}
import { canonical } from "./protocol.js";
