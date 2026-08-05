export const BEACON_PROTOCOL = "greenways-beacon/1";
export const BEACON_LINK_PROTOCOL = "greenways-beacon-link/1";
export const SPACE_PROTOCOL = "greenways-space/1";
export const BEACON_SETTINGS_KEY = "beacon";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
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
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function assertNoExecutableFields(value, label = "descriptor", seen = new WeakSet()) {
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

function exact(value, expected, label) {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
  return expected;
}

function stringList(value, label, maximum = 64) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} cannot contain more than ${maximum} entries`);
  const output = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`, 80));
  if (new Set(output).size !== output.length) throw new Error(`${label} cannot contain duplicates`);
  return Object.freeze(output);
}

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

export function normalizeBeaconOrigin(value) {
  const input = nonEmptyString(value, "Beacon origin", 2048);
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Beacon must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new Error("Beacon origin cannot contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter only the Beacon origin, without a path, query, or fragment");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("A Beacon away from this machine must use HTTPS");
  }
  return url.origin;
}

/**
 * Chrome host permissions are match patterns and do not include ports. Beacon
 * still fetches the exact configured origin; the permission necessarily covers
 * that host's other ports because that is the browser platform's granularity.
 */
export function beaconPermissionPattern(value) {
  const url = new URL(normalizeBeaconOrigin(value));
  return `${url.protocol}//${url.hostname}/*`;
}

function normalizeRuntime(value) {
  const input = plainObject(value, "Beacon runtime");
  assertKeys(input, new Set(["applicationServer", "language", "namespace", "edge"]), "Beacon runtime");
  return Object.freeze({
    applicationServer: exact(input.applicationServer, "Hoplite", "Beacon runtime.applicationServer"),
    language: exact(input.language, "Hara", "Beacon runtime.language"),
    namespace: input.namespace === undefined
      ? "gw.beacon"
      : exact(input.namespace, "gw.beacon", "Beacon runtime.namespace"),
    edge: exact(input.edge, "Nginx", "Beacon runtime.edge"),
  });
}

function normalizeBeaconSpace(value) {
  const input = plainObject(value, "Beacon Space route");
  assertKeys(input, new Set(["origin", "protocol", "localPrefix", "discovery"]), "Beacon Space route");
  return Object.freeze({
    origin: exact(input.origin, "https://greenways.space", "Beacon Space route.origin"),
    protocol: exact(input.protocol, SPACE_PROTOCOL, "Beacon Space route.protocol"),
    localPrefix: exact(input.localPrefix, "/space/", "Beacon Space route.localPrefix"),
    discovery: exact(input.discovery, "/space/discovery.json", "Beacon Space route.discovery"),
  });
}

export function normalizeBeaconDescriptor(value) {
  const input = plainObject(value, "Beacon descriptor");
  assertNoExecutableFields(input, "Beacon descriptor");
  assertKeys(input, new Set([
    "protocol", "id", "name", "role", "runtime", "space",
    "boundaries", "capabilities", "legacy",
  ]), "Beacon descriptor");
  const boundaries = plainObject(input.boundaries, "Beacon boundaries");
  assertKeys(boundaries, new Set([
    "browserKernel", "serviceAuthority", "privateOffice", "agentService",
  ]), "Beacon boundaries");
  const legacy = input.legacy === undefined ? null : plainObject(input.legacy, "Beacon legacy boundary");
  if (legacy) assertKeys(legacy, new Set(["protocol", "status"]), "Beacon legacy boundary");

  return Object.freeze({
    protocol: exact(input.protocol, BEACON_PROTOCOL, "Beacon descriptor.protocol"),
    id: exact(input.id, "greenways.beacon", "Beacon descriptor.id"),
    name: nonEmptyString(input.name, "Beacon descriptor.name", 80),
    role: exact(input.role, "local-gateway", "Beacon descriptor.role"),
    runtime: normalizeRuntime(input.runtime),
    space: normalizeBeaconSpace(input.space),
    boundaries: Object.freeze({
      browserKernel: exact(boundaries.browserKernel, "Greenways OS", "Beacon boundaries.browserKernel"),
      serviceAuthority: exact(boundaries.serviceAuthority, "Greenways Space", "Beacon boundaries.serviceAuthority"),
      privateOffice: exact(boundaries.privateOffice, "Hestia", "Beacon boundaries.privateOffice"),
      agentService: exact(boundaries.agentService, "Ignatius", "Beacon boundaries.agentService"),
    }),
    capabilities: stringList(input.capabilities ?? [], "Beacon descriptor.capabilities"),
    ...(legacy ? {
      legacy: Object.freeze({
        protocol: nonEmptyString(legacy.protocol, "Beacon legacy boundary.protocol", 80),
        status: nonEmptyString(legacy.status, "Beacon legacy boundary.status", 80),
      }),
    } : {}),
  });
}

function normalizeSpaceService(value, index) {
  const label = `Space service[${index}]`;
  const input = plainObject(value, label);
  assertKeys(input, new Set([
    "id", "name", "role", "authority", "status", "capabilities",
  ]), label);
  return Object.freeze({
    id: identifier(input.id, `${label}.id`),
    name: nonEmptyString(input.name, `${label}.name`, 80),
    role: identifier(input.role, `${label}.role`),
    authority: identifier(input.authority, `${label}.authority`),
    status: identifier(input.status, `${label}.status`),
    capabilities: stringList(input.capabilities ?? [], `${label}.capabilities`),
  });
}

export function normalizeSpaceDescriptor(value) {
  const input = plainObject(value, "Space descriptor");
  assertNoExecutableFields(input, "Space descriptor");
  assertKeys(input, new Set([
    "protocol", "id", "name", "revision", "status", "beacon",
    "services", "execution", "signing",
  ]), "Space descriptor");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new Error("Space descriptor.revision must be a positive integer");
  }

  const beacon = plainObject(input.beacon, "Space Beacon contract");
  assertKeys(beacon, new Set(["protocol", "basePath", "discovery"]), "Space Beacon contract");
  const execution = plainObject(input.execution, "Space execution boundary");
  assertKeys(execution, new Set([
    "remoteCode", "descriptorKind", "browserKernelAuthority",
  ]), "Space execution boundary");
  const signing = plainObject(input.signing, "Space signing state");
  assertKeys(signing, new Set([
    "status", "requiredForPrivateCapabilities",
  ]), "Space signing state");
  if (!Array.isArray(input.services) || input.services.length > 64) {
    throw new Error("Space descriptor.services must be an array of at most 64 services");
  }
  const services = input.services.map(normalizeSpaceService);
  if (new Set(services.map(({ id }) => id)).size !== services.length) {
    throw new Error("Space descriptor.services cannot contain duplicate ids");
  }

  return Object.freeze({
    protocol: exact(input.protocol, SPACE_PROTOCOL, "Space descriptor.protocol"),
    id: exact(input.id, "greenways.space", "Space descriptor.id"),
    name: nonEmptyString(input.name, "Space descriptor.name", 80),
    revision: input.revision,
    status: identifier(input.status, "Space descriptor.status"),
    beacon: Object.freeze({
      protocol: exact(beacon.protocol, "greenways-beacon-space/1", "Space Beacon contract.protocol"),
      basePath: exact(beacon.basePath, "/beacon/v1/", "Space Beacon contract.basePath"),
      discovery: exact(beacon.discovery, "/beacon/v1/discovery.json", "Space Beacon contract.discovery"),
    }),
    services: Object.freeze(services),
    execution: Object.freeze({
      remoteCode: exact(execution.remoteCode, false, "Space execution boundary.remoteCode"),
      descriptorKind: exact(execution.descriptorKind, "inert-data", "Space execution boundary.descriptorKind"),
      browserKernelAuthority: exact(
        execution.browserKernelAuthority,
        false,
        "Space execution boundary.browserKernelAuthority",
      ),
    }),
    signing: Object.freeze({
      status: identifier(signing.status, "Space signing state.status"),
      requiredForPrivateCapabilities: exact(
        signing.requiredForPrivateCapabilities,
        true,
        "Space signing state.requiredForPrivateCapabilities",
      ),
    }),
  });
}

export function privateSpaceCapabilitiesEnabled(space) {
  return space?.signing?.status === "signed";
}

export async function requestBeaconOriginAccess(origin, permissions = globalThis.chrome?.permissions) {
  const pattern = beaconPermissionPattern(origin);
  if (!permissions) return true;
  if (permissions.contains && await permissions.contains({ origins: [pattern] })) return true;
  const granted = await permissions.request({ origins: [pattern] });
  if (!granted) throw new Error("Beacon origin access was not granted");
  return true;
}

export async function revokeBeaconOriginAccess(origin, permissions = globalThis.chrome?.permissions) {
  const pattern = beaconPermissionPattern(origin);
  if (!permissions) return true;
  const request = { origins: [pattern] };
  if (await permissions.remove(request)) return true;
  if (permissions.contains && !await permissions.contains(request)) return true;
  throw new Error("Beacon origin access could not be revoked");
}

export class BeaconClient {
  constructor({ origin, request = fetch }) {
    this.origin = normalizeBeaconOrigin(origin);
    this.request = request;
  }

  async discover() {
    const response = await this.request(
      `${this.origin}/.well-known/greenways-beacon`,
      privateRequestOptions({ headers: { accept: "application/json" } }),
    );
    if (!response.ok) throw new Error(`Beacon discovery failed: ${response.status}`);
    return normalizeBeaconDescriptor(await response.json());
  }

  async discoverSpace(descriptor = null) {
    const beacon = descriptor ?? await this.discover();
    const response = await this.request(
      `${this.origin}${beacon.space.discovery}`,
      privateRequestOptions({ headers: { accept: "application/json" } }),
    );
    if (!response.ok) throw new Error(`Greenways Space discovery failed through Beacon: ${response.status}`);
    const space = normalizeSpaceDescriptor(await response.json());
    if (space.protocol !== beacon.space.protocol) {
      throw new Error("Beacon and Space disagree on the service protocol");
    }
    return space;
  }

  async inspect() {
    const descriptor = await this.discover();
    const space = await this.discoverSpace(descriptor);
    return Object.freeze({ descriptor, space });
  }
}

export function createBeaconRecord({ origin, descriptor, space }) {
  return Object.freeze({
    protocol: BEACON_LINK_PROTOCOL,
    origin: normalizeBeaconOrigin(origin),
    descriptor: normalizeBeaconDescriptor(descriptor),
    space: normalizeSpaceDescriptor(space),
    connectedAt: new Date().toISOString(),
  });
}
