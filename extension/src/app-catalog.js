import { APP_CAPABILITIES } from "./core-services.js";
import { applicationDescriptorWithDigest } from "./project-app.js";
import chatsProject from "../apps/chats/project.edn";
import chatgptProviderProject from "../apps/chatgpt-provider/project.edn";
import userscriptsProject from "../apps/userscripts/project.edn";

const IDENTIFIER = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SEMANTIC_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const GITHUB_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const GITHUB_SHA = /^[a-f0-9]{40}$/;
const PACKAGE_COORDINATE = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._/-]*$/;
export const APP_MANIFEST_PROTOCOL = "greenways-app/1";

export const APP_CHANNELS = Object.freeze(["bundled", "release", "preview"]);

export const RUNTIME_HANDLERS = Object.freeze([
  "extension-page",
  "packaged-surface",
  "native-hybrid",
  "web-tab",
  "hal-module",
]);

export const PACKAGED_SURFACE_IDS = Object.freeze([
  "chats",
  "chatgpt-provider",
  "userscripts",
]);

export { APP_CAPABILITIES };

const PACKAGED_EXTENSION_PATHS = new Set([
  "src/world.html",
]);
const NATIVE_HYBRID_URLS = new Set([
  "http://127.0.0.1:4319/",
]);
const WEB_TAB_URLS = new Set([
  "https://playground.hara-lang.org/",
]);
const RELEASE_REGISTRIES = new Set([
  "https://packages.hara-lang.org/",
  "https://packages.greenways.ai/",
]);
const HANDLER_SET = new Set(RUNTIME_HANDLERS);
const SURFACE_SET = new Set(PACKAGED_SURFACE_IDS);
const CAPABILITY_SET = new Set(APP_CAPABILITIES);
const CHANNEL_SET = new Set(APP_CHANNELS);
const PACKAGED_SURFACE_BINDINGS = Object.freeze({
  chats: Object.freeze({
    appId: "chats",
    publisherId: "greenways-ai",
    capabilities: Object.freeze([
      "chats/capture",
      "storage/local",
    ]),
  }),
  "chatgpt-provider": Object.freeze({
    appId: "chatgpt-provider",
    publisherId: "greenways-ai",
    capabilities: Object.freeze([
      "model/provide",
      "storage/local",
      "tabs/open",
    ]),
  }),
  userscripts: Object.freeze({
    appId: "userscripts",
    publisherId: "greenways-ai",
    capabilities: Object.freeze([
      "userscripts/manage",
      "storage/local",
    ]),
  }),
});
const SYSTEM_APP_BINDINGS = Object.freeze({
  "greenways-worlds": Object.freeze({
    publisherId: "greenways-ai",
    path: "src/world.html",
    capabilities: Object.freeze(["network/github", "worlds/browse"]),
  }),
});
const FORBIDDEN_CODE_FIELD = /^(?:remote[-_])?(?:executable|module|source|script|entrypoint)(?:[-_]?url)?$/i;

const MANIFEST_KEYS = new Set([
  "protocol", "id", "version", "publisher", "name", "description",
  "category", "capabilities", "launch", "requirement",
  "kind", "channel", "lockDigest", "source", "project",
]);
const PUBLISHER_KEYS = new Set(["id", "name"]);
const LAUNCH_KEYS = Object.freeze({
  "extension-page": new Set(["handler", "path"]),
  "packaged-surface": new Set(["handler", "surfaceId"]),
  "native-hybrid": new Set(["handler", "url"]),
  "web-tab": new Set(["handler", "url"]),
  "hal-module": new Set(["handler"]),
});
const REQUIREMENT_KEYS = new Set(["kind", "id", "name", "description"]);
const PROJECT_KEYS = new Set(["coordinate", "main", "digest"]);
const MODULE_SOURCE_KEYS = Object.freeze({
  registry: new Set(["kind", "registry", "coordinate"]),
  github: new Set(["kind", "owner", "repo", "sha"]),
  bundled: new Set(["kind", "path"]),
});

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

function nonEmptyString(value, label, maximum = 240) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function identifier(value, label) {
  const output = nonEmptyString(value, label, 80);
  if (!IDENTIFIER.test(output)) {
    throw new Error(`${label} must be a lowercase app identifier`);
  }
  return output;
}

function semanticVersion(value, label) {
  const output = nonEmptyString(value, label, 80);
  if (!SEMANTIC_VERSION.test(output)) throw new Error(`${label} must be a semantic version`);
  return output;
}

function sha256Digest(value, label) {
  const output = nonEmptyString(value, label, 80);
  if (!SHA256.test(output)) throw new Error(`${label} must be sha256:<64 lowercase hex characters>`);
  return output;
}

function assertNoExecutableFields(value, label, seen = new WeakSet(), path = []) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) throw new Error(`${label} cannot contain cyclic data`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const safeModuleSourceDescriptor = path.length === 0
      && key === "source"
      && value.kind === "hal-module";
    if (FORBIDDEN_CODE_FIELD.test(key) && !safeModuleSourceDescriptor) {
      throw new Error(`${label} cannot declare executable, module, source, script, or entrypoint fields`);
    }
    assertNoExecutableFields(child, `${label}.${key}`, seen, [...path, key]);
  }
  seen.delete(value);
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function safeUrl(value, label, allowedUrls) {
  const input = nonEmptyString(value, label, 2048);
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.username || parsed.password) throw new Error(`${label} cannot contain credentials`);
  if (parsed.search || parsed.hash) throw new Error(`${label} cannot contain a query or fragment`);
  if (!allowedUrls.has(parsed.href)) throw new Error(`${label} is not an allowlisted launch URL`);
  return parsed.href;
}

function safeBundledPath(value, label) {
  const path = nonEmptyString(value, label, 240);
  if (path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe relative path`);
  }
  return path;
}

function normalizeLaunch(value, label) {
  const input = plainObject(value, label);
  const handler = nonEmptyString(input.handler, `${label}.handler`, 40);
  if (!HANDLER_SET.has(handler)) throw new Error(`${label}.handler is not allowlisted`);
  assertKeys(input, LAUNCH_KEYS[handler], label);

  if (handler === "extension-page") {
    const path = nonEmptyString(input.path, `${label}.path`, 160);
    if (!PACKAGED_EXTENSION_PATHS.has(path)) {
      throw new Error(`${label}.path is not an allowlisted packaged extension page`);
    }
    return Object.freeze({ handler, path });
  }
  if (handler === "packaged-surface") {
    const surfaceId = identifier(input.surfaceId, `${label}.surfaceId`);
    if (!SURFACE_SET.has(surfaceId)) throw new Error(`${label}.surfaceId is not allowlisted`);
    return Object.freeze({ handler, surfaceId });
  }
  if (handler === "native-hybrid") {
    return Object.freeze({ handler, url: safeUrl(input.url, `${label}.url`, NATIVE_HYBRID_URLS) });
  }
  if (handler === "web-tab") {
    return Object.freeze({ handler, url: safeUrl(input.url, `${label}.url`, WEB_TAB_URLS) });
  }
  return Object.freeze({ handler });
}

function normalizeRequirement(value, label) {
  const input = plainObject(value, label);
  assertKeys(input, REQUIREMENT_KEYS, label);
  if (input.kind !== "companion") throw new Error(`${label}.kind must be companion`);
  return Object.freeze({
    kind: "companion",
    id: identifier(input.id, `${label}.id`),
    name: nonEmptyString(input.name, `${label}.name`, 80),
    description: nonEmptyString(input.description, `${label}.description`, 320),
  });
}

function normalizeProject(value, label) {
  if (value === undefined) return null;
  const input = plainObject(value, label);
  assertKeys(input, PROJECT_KEYS, label);
  const coordinate = nonEmptyString(input.coordinate, `${label}.coordinate`, 160);
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\/[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(coordinate)) {
    throw new Error(`${label}.coordinate is invalid`);
  }
  const main = nonEmptyString(input.main, `${label}.main`, 160);
  if (!/^[a-z][a-z0-9.-]*\/[a-zA-Z*+!_?<>=$%&.-][a-zA-Z0-9*+!_?<>=$%&.-]*$/.test(main)) {
    throw new Error(`${label}.main must be a qualified HAL var`);
  }
  return Object.freeze({
    coordinate,
    main,
    digest: sha256Digest(input.digest, `${label}.digest`),
  });
}

function normalizeCapabilities(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const capabilities = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`, 80));
  for (const capability of capabilities) {
    if (!CAPABILITY_SET.has(capability)) throw new Error(`${label} contains non-allowlisted capability ${capability}`);
  }
  if (new Set(capabilities).size !== capabilities.length) throw new Error(`${label} cannot contain duplicates`);
  return Object.freeze(capabilities);
}

function normalizePublisher(value, label) {
  const input = plainObject(value, label);
  assertKeys(input, PUBLISHER_KEYS, label);
  return Object.freeze({
    id: identifier(input.id, `${label}.id`),
    name: nonEmptyString(input.name, `${label}.name`, 80),
  });
}

function normalizeGitHubPart(value, label) {
  const output = nonEmptyString(value, label, 100);
  if (!GITHUB_PART.test(output) || output === "." || output === "..") {
    throw new Error(`${label} is not a valid GitHub owner or repository name`);
  }
  return output;
}

function normalizeModuleSource(value, channel, label) {
  const input = plainObject(value, label);
  const kind = nonEmptyString(input.kind, `${label}.kind`, 20);
  const allowed = MODULE_SOURCE_KEYS[kind];
  if (!allowed) throw new Error(`${label}.kind must be registry, github, or bundled`);
  assertKeys(input, allowed, label);

  if (channel === "release" && kind !== "registry") {
    throw new Error(`${label}.kind must be registry for the release channel`);
  }
  if (channel === "preview" && kind !== "github") {
    throw new Error(`${label}.kind must be github for the preview channel`);
  }
  if (channel === "bundled" && kind !== "bundled") {
    throw new Error(`${label}.kind must be bundled for the bundled channel`);
  }

  if (kind === "registry") {
    const registry = safeUrl(input.registry, `${label}.registry`, RELEASE_REGISTRIES);
    const coordinate = nonEmptyString(input.coordinate, `${label}.coordinate`, 160);
    if (!PACKAGE_COORDINATE.test(coordinate) || coordinate.includes("..")) {
      throw new Error(`${label}.coordinate is invalid`);
    }
    return Object.freeze({ kind, registry, coordinate });
  }
  if (kind === "github") {
    const sha = nonEmptyString(input.sha, `${label}.sha`, 40).toLowerCase();
    if (!GITHUB_SHA.test(sha)) throw new Error(`${label}.sha must be a pinned 40-character commit sha`);
    return Object.freeze({
      kind,
      owner: normalizeGitHubPart(input.owner, `${label}.owner`),
      repo: normalizeGitHubPart(input.repo, `${label}.repo`),
      sha,
    });
  }
  return Object.freeze({
    kind,
    path: safeBundledPath(input.path, `${label}.path`),
  });
}

function normalizeModuleMetadata(input, launch, capabilities, category, label) {
  const moduleFieldsPresent = ["kind", "channel", "lockDigest", "source"]
    .some((key) => input[key] !== undefined);
  if (launch.handler !== "hal-module") {
    if (moduleFieldsPresent) throw new Error(`${label}: only hal-module apps may declare module installation metadata`);
    return null;
  }
  if (input.kind !== "hal-module") throw new Error(`${label}.kind must be hal-module`);
  if (category !== "installable") throw new Error(`${label}: hal-module apps must currently be installable`);
  if (!capabilities.includes("hara/module")) throw new Error(`${label}: hal-module apps require hara/module`);
  const channel = nonEmptyString(input.channel, `${label}.channel`, 20);
  if (!CHANNEL_SET.has(channel)) throw new Error(`${label}.channel must be bundled, release, or preview`);
  return Object.freeze({
    kind: "hal-module",
    channel,
    lockDigest: sha256Digest(input.lockDigest, `${label}.lockDigest`),
    source: normalizeModuleSource(input.source, channel, `${label}.source`),
  });
}

export function normalizeAppDescriptor(value, label = "app manifest") {
  const input = plainObject(value, label);
  assertNoExecutableFields(input, label);
  assertKeys(input, MANIFEST_KEYS, label);

  if (input.protocol !== APP_MANIFEST_PROTOCOL) {
    throw new Error(`${label}.protocol must be ${APP_MANIFEST_PROTOCOL}`);
  }
  const id = identifier(input.id, `${label}.id`);
  const version = semanticVersion(input.version, `${label}.version`);
  const publisher = normalizePublisher(input.publisher, `${label}.publisher`);
  const name = nonEmptyString(input.name, `${label}.name`, 80);
  const description = nonEmptyString(input.description, `${label}.description`, 320);
  const category = nonEmptyString(input.category, `${label}.category`, 24);
  if (category !== "system" && category !== "installable") {
    throw new Error(`${label}.category must be system or installable`);
  }
  const capabilities = normalizeCapabilities(input.capabilities, `${label}.capabilities`);
  const launch = normalizeLaunch(input.launch, `${label}.launch`);
  const project = normalizeProject(input.project, `${label}.project`);
  const requirement = input.requirement === undefined
    ? null
    : normalizeRequirement(input.requirement, `${label}.requirement`);
  const moduleMetadata = normalizeModuleMetadata(input, launch, capabilities, category, label);

  if (category === "system" && launch.handler !== "extension-page") {
    throw new Error(`${label}: system apps must use the extension-page handler`);
  }
  const systemBinding = SYSTEM_APP_BINDINGS[id];
  if (category === "system") {
    if (!systemBinding
      || publisher.id !== systemBinding.publisherId
      || launch.path !== systemBinding.path) {
      throw new Error(`${label}: system app id, publisher, and packaged path are not bound together`);
    }
    if (capabilities.length !== systemBinding.capabilities.length
      || systemBinding.capabilities.some((capability) => !capabilities.includes(capability))) {
      throw new Error(`${label}: system app capabilities must match the packaged binding`);
    }
  }
  if (category === "installable" && systemBinding) {
    throw new Error(`${label}: reserved system app ids must use their packaged system binding`);
  }
  if (category === "installable" && launch.handler === "extension-page") {
    throw new Error(`${label}: installable apps cannot claim a system extension page`);
  }
  if (launch.handler === "native-hybrid" && requirement?.kind !== "companion") {
    throw new Error(`${label}: native-hybrid apps must declare a companion requirement`);
  }
  if (launch.handler !== "native-hybrid" && requirement !== null) {
    throw new Error(`${label}: only native-hybrid apps may declare a companion requirement`);
  }
  if (launch.handler === "native-hybrid" && !capabilities.includes("network/loopback")) {
    throw new Error(`${label}: native-hybrid apps require network/loopback`);
  }
  if (launch.handler === "native-hybrid" && !capabilities.includes("tabs/open")) {
    throw new Error(`${label}: native-hybrid apps require tabs/open`);
  }
  if (launch.handler === "web-tab" && !capabilities.includes("tabs/open")) {
    throw new Error(`${label}: web-tab apps require tabs/open`);
  }
  if (launch.handler === "packaged-surface") {
    const binding = PACKAGED_SURFACE_BINDINGS[launch.surfaceId];
    if (id !== binding.appId || publisher.id !== binding.publisherId) {
      throw new Error(
        `${label}: ${launch.surfaceId} is bound to app ${binding.appId} from publisher ${binding.publisherId}`
      );
    }
    for (const capability of binding.capabilities) {
      if (!capabilities.includes(capability)) {
        throw new Error(`${label}: ${launch.surfaceId} requires ${capability}`);
      }
    }
  }

  const output = {
    protocol: APP_MANIFEST_PROTOCOL,
    id,
    version,
    publisher,
    name,
    description,
    category,
    capabilities,
    launch,
  };
  if (project) output.project = project;
  if (requirement) output.requirement = requirement;
  if (moduleMetadata) Object.assign(output, moduleMetadata);
  return Object.freeze(output);
}

export const validateAppManifest = normalizeAppDescriptor;

export function validateAppCatalog(value) {
  if (!Array.isArray(value)) throw new TypeError("app catalog must be an array");
  if (!value.length) throw new Error("app catalog cannot be empty");
  if (value.length > 64) throw new Error("app catalog cannot contain more than 64 apps");
  const catalog = value.map((entry, index) => normalizeAppDescriptor(entry, `app catalog[${index}]`));
  const ids = catalog.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("app catalog ids must be unique");
  return Object.freeze(catalog);
}

const STATIC_BUILTIN_DESCRIPTORS = [
  {
    protocol: APP_MANIFEST_PROTOCOL,
    id: "greenways-worlds",
    version: "0.3.0",
    publisher: { id: "greenways-ai", name: "Greenways AI" },
    name: "Worlds",
    description: "Open and explore Greenways Worlds while keeping the local kernel in control.",
    category: "system",
    capabilities: ["network/github", "worlds/browse"],
    launch: { handler: "extension-page", path: "src/world.html" },
  },
  {
    protocol: APP_MANIFEST_PROTOCOL,
    id: "hara-playground",
    version: "0.2.0",
    publisher: { id: "hara-lang", name: "Hara Lang" },
    name: "Hara Playground",
    description: "Open the browser-native Hara playground in a separate web tab.",
    category: "installable",
    capabilities: ["hara/evaluate", "model/generate", "tabs/open"],
    launch: { handler: "web-tab", url: "https://playground.hara-lang.org/" },
  },
];

let builtinAppCatalog;
let builtinAppCatalogPromise;

export const SYSTEM_APP_IDS = Object.freeze(["greenways-worlds"]);

export function getBuiltinAppCatalog() {
  if (!builtinAppCatalogPromise) {
    builtinAppCatalogPromise = Promise.all([
      applicationDescriptorWithDigest(chatsProject),
      applicationDescriptorWithDigest(chatgptProviderProject),
      applicationDescriptorWithDigest(userscriptsProject),
    ]).then(([chats, chatgptProvider, userscripts]) => {
      builtinAppCatalog = validateAppCatalog([
        STATIC_BUILTIN_DESCRIPTORS[0],
        chats,
        chatgptProvider,
        userscripts,
        STATIC_BUILTIN_DESCRIPTORS[1],
      ]);
      return builtinAppCatalog;
    });
  }
  return builtinAppCatalogPromise;
}

function currentBuiltinAppCatalog() {
  if (!builtinAppCatalog) {
    throw new Error("The built-in app catalog has not been initialized");
  }
  return builtinAppCatalog;
}

export function resolveAppById(id, catalog = currentBuiltinAppCatalog()) {
  const requestedId = identifier(id, "app id");
  const safeCatalog = catalog === builtinAppCatalog ? catalog : validateAppCatalog(catalog);
  return safeCatalog.find((app) => app.id === requestedId) ?? null;
}

export function getAppManifest(id) {
  return resolveAppById(id);
}

export function resolveAppLaunch(id, catalog = currentBuiltinAppCatalog()) {
  const app = resolveAppById(id, catalog);
  if (!app) throw new Error(`Unknown app id: ${id}`);
  return Object.freeze({ appId: app.id, ...app.launch });
}
