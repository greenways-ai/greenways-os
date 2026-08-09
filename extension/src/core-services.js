export const CORE_SERVICE_PROTOCOL = "greenways-core-service/1";
export const CAPABILITY_DEFINITION_PROTOCOL = "greenways-capability-definition/1";
export const CAPABILITY_GRANT_PROTOCOL = "greenways-capability-grant/1";

const APP_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SERVICE_ID = /^[a-z][a-z0-9-]{1,63}$/;
const PUBLISHER_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GRANT_ID = /^grant\/[a-z0-9][a-z0-9._/-]{7,126}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_FIELD = /^(?:secret|password|token|api[-_]?key|private[-_]?key|authorization|bearer)$/i;
const MAX_CONSTRAINT_BYTES = 64 * 1024;
const MAX_CONSTRAINT_DEPTH = 8;
const MAX_CONSTRAINT_ENTRIES = 64;
const MAX_CONSTRAINT_STRING = 4096;

const service = (id, name, status, dependencies = []) => Object.freeze({
  protocol: CORE_SERVICE_PROTOCOL,
  id,
  name,
  version: "0.1.0",
  status,
  resident: true,
  removable: false,
  dependencies: Object.freeze([...dependencies]),
});

export const CORE_SERVICES = Object.freeze([
  service("kernel", "Kernel and Module Runtime", "active"),
  service("store", "Durable State Store", "active", ["kernel"]),
  service("capabilities", "Capability and Consent", "active", ["kernel", "store"]),
  service("identity", "Identity", "active", ["store", "capabilities"]),
  service("keyring", "Keyring", "active", ["identity", "store", "capabilities"]),
  service("packages", "Package Lifecycle and Trust", "active", ["kernel", "store", "capabilities"]),
  service("surfaces", "Surface and Interaction Host", "active", ["kernel", "capabilities"]),
  service("receipts", "Receipt and Event Journal", "foundation", ["store", "identity"]),
  service("connectors", "Connector Broker", "foundation", ["capabilities", "keyring", "receipts"]),
  service("work", "Work and Agent Supervisor", "foundation", ["kernel", "store", "capabilities", "receipts"]),
]);

const capability = (id, serviceId, risk, {
  grantable = false,
  trustedPublishers = [],
  description,
} = {}) => Object.freeze({
  protocol: CAPABILITY_DEFINITION_PROTOCOL,
  id,
  service: serviceId,
  risk,
  grantable,
  trustedPublishers: Object.freeze([...trustedPublishers]),
  description: description ?? id,
});

export const CAPABILITY_DEFINITIONS = Object.freeze([
  capability("hara/evaluate", "kernel", "medium"),
  capability("hara/module", "kernel", "high"),
  capability("hestia/connect", "connectors", "high"),
  capability("hestia/propose", "work", "high", {
    grantable: true,
    description: "Submit an exact-root consequential intent to the Hestia controller.",
  }),
  capability("hestia/approve", "work", "critical", {
    grantable: true,
    description: "Approve an exact Hestia proposal under the current application mandate.",
  }),
  capability("hestia/execute", "work", "critical", {
    grantable: true,
    description: "Execute an approved Hestia proposal through the supervised work service.",
  }),
  capability("historia/import", "connectors", "medium"),
  capability("chats/capture", "surfaces", "critical", {
    grantable: true,
    trustedPublishers: ["greenways-ai"],
    description: "Observe rendered conversations on an explicitly approved AI chat origin.",
  }),
  capability("identity/local", "identity", "high", { trustedPublishers: ["greenways-ai"] }),
  capability("network/github", "connectors", "medium"),
  capability("network/https", "connectors", "high"),
  capability("network/loopback", "connectors", "high"),
  capability("storage/local", "store", "medium"),
  capability("tabs/open", "surfaces", "medium"),
  capability("userscripts/manage", "surfaces", "critical", {
    grantable: true,
    trustedPublishers: ["greenways-ai"],
    description: "Register, update, or remove user-authored scripts that run in matching web pages.",
  }),
  capability("worlds/browse", "connectors", "low"),
  capability("key/public", "keyring", "low", {
    grantable: true,
    description: "Read public key and controller metadata without exporting private material.",
  }),
  capability("key/sign", "keyring", "critical", {
    grantable: true,
    description: "Ask the Keyring to sign a bounded payload under an exact grant.",
  }),
  capability("credential/manage", "keyring", "critical", {
    grantable: true,
    trustedPublishers: ["greenways-ai"],
    description: "Create, update, or remove opaque credential profiles.",
  }),
  capability("credential/use", "keyring", "critical", {
    grantable: true,
    description: "Use an opaque credential profile without revealing its secret.",
  }),
  capability("model/generate", "connectors", "high", {
    grantable: true,
    description: "Run a bounded model request through an approved provider profile.",
  }),
  capability("tahto/connect", "connectors", "high", {
    grantable: true,
    description: "Pair one browser device identity with an explicitly approved Tahto node.",
  }),
  capability("tahto/read", "connectors", "medium", {
    grantable: true,
    description: "Read bounded semantic state from the selected Tahto node.",
  }),
  capability("tahto/write", "connectors", "critical", {
    grantable: true,
    description: "Prepare and submit signed semantic changes to the selected Tahto node.",
  }),
]);

export const APP_CAPABILITIES = Object.freeze(CAPABILITY_DEFINITIONS.map(({ id }) => id));

const SERVICES_BY_ID = new Map(CORE_SERVICES.map((entry) => [entry.id, entry]));
const CAPABILITIES_BY_ID = new Map(CAPABILITY_DEFINITIONS.map((entry) => [entry.id, entry]));

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

function closedKeys(value, allowed, label) {
  for (const key of Object.keys(plainObject(value, label))) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function requiredString(value, label, maximum = 240) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function matchingString(value, pattern, label, maximum = 240) {
  const output = requiredString(value, label, maximum);
  if (!pattern.test(output)) throw new Error(`${label} is invalid`);
  return output;
}

function canonicalTime(value, label) {
  const output = requiredString(value, label, 80);
  const parsed = Date.parse(output);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== output) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function optionalTime(value, label) {
  return value === null || value === undefined ? null : canonicalTime(value, label);
}

function normalizeConstraintValue(value, label, depth = 0) {
  if (depth > MAX_CONSTRAINT_DEPTH) throw new Error(`${label} exceeds the maximum depth`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > MAX_CONSTRAINT_STRING) throw new Error(`${label} contains an oversized string`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONSTRAINT_ENTRIES) throw new Error(`${label} contains too many entries`);
    return Object.freeze(value.map((entry, index) => normalizeConstraintValue(entry, `${label}[${index}]`, depth + 1)));
  }
  const input = plainObject(value, label);
  const entries = Object.entries(input);
  if (entries.length > MAX_CONSTRAINT_ENTRIES) throw new Error(`${label} contains too many fields`);
  const output = {};
  for (const [key, child] of entries) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} contains a forbidden field ${key}`);
    if (SECRET_FIELD.test(key)) throw new Error(`${label} cannot contain secret material in ${key}`);
    if (!key || key.length > 80) throw new Error(`${label} contains an invalid field name`);
    output[key] = normalizeConstraintValue(child, `${label}.${key}`, depth + 1);
  }
  return Object.freeze(output);
}

export function normalizeCapabilityConstraints(value = {}) {
  const output = normalizeConstraintValue(value, "Capability constraints");
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new TypeError("Capability constraints must be an object");
  }
  if (JSON.stringify(output).length > MAX_CONSTRAINT_BYTES) {
    throw new Error("Capability constraints exceed the 64 KB limit");
  }
  return output;
}

export function getCoreService(id) {
  return SERVICES_BY_ID.get(String(id)) ?? null;
}

export function getCapabilityDefinition(id) {
  return CAPABILITIES_BY_ID.get(String(id)) ?? null;
}

function normalizedManifestBinding(manifestValue) {
  const manifest = plainObject(manifestValue, "Approved app manifest");
  const publisher = plainObject(manifest.publisher, "Approved app publisher");
  const id = matchingString(manifest.id, APP_ID, "Approved app id", 80);
  const version = matchingString(manifest.version, SEMANTIC_VERSION, "Approved app version", 80);
  const publisherId = matchingString(publisher.id, PUBLISHER_ID, "Approved app publisher id", 80);
  if (!Array.isArray(manifest.capabilities)) throw new TypeError("Approved app capabilities must be an array");
  const capabilities = Object.freeze(manifest.capabilities.map((entry, index) => (
    matchingString(entry, CAPABILITY_ID, `Approved app capability ${index}`, 80)
  )));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error("Approved app capabilities cannot contain duplicates");
  }
  const lockDigest = manifest.kind === "hal-module"
    ? matchingString(manifest.lockDigest, SHA256, "Approved app lock digest", 80)
    : null;
  return Object.freeze({ id, version, publisherId, capabilities, lockDigest });
}

function normalizeSubject(value) {
  const input = plainObject(value, "Capability grant subject");
  closedKeys(input, new Set(["kind", "appId", "version", "publisherId", "lockDigest"]), "Capability grant subject");
  if (input.kind !== "app") throw new Error("Capability grant subject.kind must be app");
  return Object.freeze({
    kind: "app",
    appId: matchingString(input.appId, APP_ID, "Capability grant subject app id", 80),
    version: matchingString(input.version, SEMANTIC_VERSION, "Capability grant subject version", 80),
    publisherId: matchingString(input.publisherId, PUBLISHER_ID, "Capability grant subject publisher id", 80),
    lockDigest: input.lockDigest === null
      ? null
      : matchingString(input.lockDigest, SHA256, "Capability grant subject lock digest", 80),
  });
}

export function validateCapabilityGrant(value) {
  const input = plainObject(value, "Capability grant");
  closedKeys(
    input,
    new Set(["protocol", "id", "subject", "capability", "constraints", "issuedAt", "expiresAt", "revokedAt"]),
    "Capability grant",
  );
  if (input.protocol !== CAPABILITY_GRANT_PROTOCOL) {
    throw new Error(`Capability grant protocol must be ${CAPABILITY_GRANT_PROTOCOL}`);
  }
  const capabilityId = matchingString(input.capability, CAPABILITY_ID, "Capability grant capability", 80);
  const definition = getCapabilityDefinition(capabilityId);
  if (!definition?.grantable) throw new Error(`Capability ${capabilityId} is not operation-grantable`);
  const issuedAt = canonicalTime(input.issuedAt, "Capability grant issuedAt");
  const expiresAt = optionalTime(input.expiresAt, "Capability grant expiresAt");
  const revokedAt = optionalTime(input.revokedAt, "Capability grant revokedAt");
  if (expiresAt && expiresAt <= issuedAt) throw new Error("Capability grant expiry must follow issuance");
  if (revokedAt && revokedAt < issuedAt) throw new Error("Capability grant revocation cannot precede issuance");
  const subject = normalizeSubject(input.subject);
  if (definition.trustedPublishers.length
    && !definition.trustedPublishers.includes(subject.publisherId)) {
    throw new Error(`Capability ${capabilityId} is restricted to a trusted publisher`);
  }
  return Object.freeze({
    protocol: CAPABILITY_GRANT_PROTOCOL,
    id: matchingString(input.id, GRANT_ID, "Capability grant id", 128),
    subject,
    capability: capabilityId,
    constraints: normalizeCapabilityConstraints(input.constraints ?? {}),
    issuedAt,
    expiresAt,
    revokedAt,
  });
}

export function createCapabilityGrant(requestValue, manifestValue, {
  now = () => new Date(),
} = {}) {
  const request = plainObject(requestValue, "Capability grant request");
  closedKeys(request, new Set(["id", "appId", "capability", "constraints", "expiresAt"]), "Capability grant request");
  const binding = normalizedManifestBinding(manifestValue);
  const appId = matchingString(request.appId, APP_ID, "Capability grant request app id", 80);
  if (appId !== binding.id) throw new Error("Capability grant request does not match the approved app");
  const capabilityId = matchingString(request.capability, CAPABILITY_ID, "Capability grant request capability", 80);
  const definition = getCapabilityDefinition(capabilityId);
  if (!definition?.grantable) throw new Error(`Capability ${capabilityId} is not operation-grantable`);
  if (!binding.capabilities.includes(capabilityId)) {
    throw new Error(`Approved app ${binding.id} does not declare ${capabilityId}`);
  }
  if (definition.trustedPublishers.length
    && !definition.trustedPublishers.includes(binding.publisherId)) {
    throw new Error(`Capability ${capabilityId} is restricted to a trusted publisher`);
  }
  const issuedAt = now().toISOString();
  const expiresAt = optionalTime(request.expiresAt, "Capability grant request expiresAt");
  return validateCapabilityGrant({
    protocol: CAPABILITY_GRANT_PROTOCOL,
    id: request.id,
    subject: {
      kind: "app",
      appId: binding.id,
      version: binding.version,
      publisherId: binding.publisherId,
      lockDigest: binding.lockDigest,
    },
    capability: capabilityId,
    constraints: request.constraints ?? {},
    issuedAt,
    expiresAt,
    revokedAt: null,
  });
}

export function grantMatchesManifest(grantValue, manifestValue) {
  const grant = validateCapabilityGrant(grantValue);
  const binding = normalizedManifestBinding(manifestValue);
  return grant.subject.appId === binding.id
    && grant.subject.version === binding.version
    && grant.subject.publisherId === binding.publisherId
    && grant.subject.lockDigest === binding.lockDigest
    && binding.capabilities.includes(grant.capability);
}

export function revokeCapabilityGrant(grantValue, {
  now = () => new Date(),
} = {}) {
  const grant = validateCapabilityGrant(grantValue);
  if (grant.revokedAt) throw new Error("Capability grant is already revoked");
  return validateCapabilityGrant({ ...grant, revokedAt: now().toISOString() });
}

export function activeCapabilityGrant(grants, manifest, capabilityId, {
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(grants)) throw new TypeError("Capability grants must be an array");
  const time = now().toISOString();
  return grants
    .map(validateCapabilityGrant)
    .find((grant) => (
      grant.capability === capabilityId
      && !grant.revokedAt
      && (!grant.expiresAt || grant.expiresAt > time)
      && grantMatchesManifest(grant, manifest)
    )) ?? null;
}
