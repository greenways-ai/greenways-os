const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const COORDINATE = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._/-]*$/;
const CAPABILITIES = new Set([
  "hara/evaluate",
  "hara/module",
  "hestia/connect",
  "historia/import",
  "identity/local",
  "network/github",
  "network/https",
  "network/loopback",
  "storage/local",
  "tabs/open",
  "worlds/browse",
  "key/public",
  "key/sign",
  "credential/manage",
  "credential/use",
  "model/generate",
]);
const MANIFEST_KEYS = new Set([
  "protocol", "id", "version", "publisher", "name", "description",
  "category", "capabilities", "launch", "kind", "channel", "lockDigest", "source",
]);
const PUBLISHER_KEYS = new Set(["id", "name"]);
const SOURCE_KEYS = new Set(["kind", "registry", "coordinate"]);
const FORBIDDEN_CODE_FIELD = /^(?:remote[-_])?(?:executable|module|source|script|entrypoint)(?:[-_]?url)?$/i;

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

function exactKeys(value, allowed, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  return input;
}

function nonEmpty(value, label, maximum = 240) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function identifier(value, label) {
  const output = nonEmpty(value, label, 80);
  if (!IDENTIFIER.test(output)) throw new Error(`${label} must be a lowercase identifier`);
  return output;
}

function assertNoExecutableFields(value, label, seen = new WeakSet(), root = true) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`${label} cannot contain cyclic data`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const allowedDescriptor = root && key === "source" && value.kind === "hal-module";
    if (FORBIDDEN_CODE_FIELD.test(key) && !allowedDescriptor) {
      throw new Error(`${label} cannot declare executable, module, source, script, or entrypoint fields`);
    }
    assertNoExecutableFields(child, `${label}.${key}`, seen, false);
  }
  seen.delete(value);
}

function normalizeOrigin(value, label) {
  const url = new URL(nonEmpty(value, label, 2048));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS origin`);
  }
  url.pathname = "/";
  return url.href;
}

function normalizeCapabilities(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const output = value.map((entry, index) => nonEmpty(entry, `${label}[${index}]`, 80));
  if (new Set(output).size !== output.length) throw new Error(`${label} cannot contain duplicates`);
  for (const capability of output) {
    if (!CAPABILITIES.has(capability)) throw new Error(`${label} contains non-allowlisted capability ${capability}`);
  }
  if (!output.includes("hara/module")) throw new Error(`${label} must include hara/module`);
  return Object.freeze(output);
}

export function validateReleaseModuleManifest(value) {
  const input = exactKeys(value, MANIFEST_KEYS, "release app manifest");
  assertNoExecutableFields(input, "release app manifest");
  if (input.protocol !== "greenways-app/0-alpha") {
    throw new Error("release app manifest.protocol must be greenways-app/0-alpha");
  }
  if (input.kind !== "hal-module" || input.channel !== "release") {
    throw new Error("release app manifest must be a release hal-module");
  }
  if (input.category !== "installable") {
    throw new Error("release app manifest.category must be installable");
  }
  const id = identifier(input.id, "release app manifest.id");
  const version = nonEmpty(input.version, "release app manifest.version", 80);
  if (!SEMANTIC_VERSION.test(version)) throw new Error("release app manifest.version must be semantic");
  const publisherInput = exactKeys(input.publisher, PUBLISHER_KEYS, "release app manifest.publisher");
  const publisher = Object.freeze({
    id: identifier(publisherInput.id, "release app manifest.publisher.id"),
    name: nonEmpty(publisherInput.name, "release app manifest.publisher.name", 80),
  });
  const launch = exactKeys(input.launch, new Set(["handler"]), "release app manifest.launch");
  if (launch.handler !== "hal-module") throw new Error("release app manifest.launch.handler must be hal-module");
  const lockDigest = nonEmpty(input.lockDigest, "release app manifest.lockDigest", 80);
  if (!SHA256.test(lockDigest)) throw new Error("release app manifest.lockDigest is invalid");
  const source = exactKeys(input.source, SOURCE_KEYS, "release app manifest.source");
  if (source.kind !== "registry") throw new Error("release app manifest.source.kind must be registry");
  const coordinate = nonEmpty(source.coordinate, "release app manifest.source.coordinate", 160);
  if (!COORDINATE.test(coordinate) || coordinate.includes("..")) {
    throw new Error("release app manifest.source.coordinate is invalid");
  }
  return Object.freeze({
    protocol: "greenways-app/0-alpha",
    id,
    version,
    publisher,
    name: nonEmpty(input.name, "release app manifest.name", 80),
    description: nonEmpty(input.description, "release app manifest.description", 320),
    category: "installable",
    capabilities: normalizeCapabilities(input.capabilities, "release app manifest.capabilities"),
    launch: Object.freeze({ handler: "hal-module" }),
    kind: "hal-module",
    channel: "release",
    lockDigest,
    source: Object.freeze({
      kind: "registry",
      registry: normalizeOrigin(source.registry, "release app manifest.source.registry"),
      coordinate,
    }),
  });
}

export function appApprovalIdentity(manifest) {
  return Object.freeze({
    id: manifest.id,
    version: manifest.version,
    publisherId: manifest.publisher.id,
    capabilities: Object.freeze([...(manifest.capabilities ?? [])].sort()),
    handler: manifest.launch.handler,
    lockDigest: manifest.lockDigest,
  });
}
