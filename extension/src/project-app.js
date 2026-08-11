import { parseEDNString } from "edn-data";
import { sha256 } from "./protocol.js";

const EDN_OPTIONS = Object.freeze({
  mapAs: "object",
  setAs: "array",
  listAs: "array",
  keywordAs: "string",
  charAs: "string",
  objectKeysAs: "string",
});

const PROJECT_KEYS = new Set([
  "hara/type", "hara/version", "project/id", "project/version",
  "project/source-paths", "project/test-paths", "project/extension-paths",
  "project/capabilities", "project/dependencies", "project/main",
  "project/application",
]);
const APPLICATION_KEYS = new Set([
  "application/publisher-name", "application/name", "application/description",
  "application/category", "application/launch",
]);
const LAUNCH_KEYS = new Set([
  "launch/handler", "launch/surface-id", "launch/path", "launch/url",
]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COORDINATE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\/[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const QUALIFIED_SYMBOL = /^[a-z][a-z0-9.-]*\/[a-zA-Z*+!_?<>=$%&.-][a-zA-Z0-9*+!_?<>=$%&.-]*$/;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an EDN map`);
  }
  return value;
}

function vector(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be a vector or set`);
  return value;
}

function scalar(value, label) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.sym === "string") return value.sym;
  throw new Error(`${label} must be a string, keyword, or symbol`);
}

function closedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported key :${key}`);
  }
}

function launch(value) {
  const input = object(value, ":project/application :application/launch");
  closedKeys(input, LAUNCH_KEYS, ":application/launch");
  const handler = scalar(input["launch/handler"], ":launch/handler");
  if (handler === "packaged-surface") {
    return { handler, surfaceId: scalar(input["launch/surface-id"], ":launch/surface-id") };
  }
  if (handler === "extension-page") {
    return { handler, path: scalar(input["launch/path"], ":launch/path") };
  }
  if (handler === "web-tab" || handler === "native-hybrid") {
    return { handler, url: scalar(input["launch/url"], ":launch/url") };
  }
  if (handler === "hal-module") return { handler };
  throw new Error(`Unsupported :launch/handler :${handler}`);
}

export function parseApplicationProject(source) {
  try {
    return parseEDNString(String(source), EDN_OPTIONS);
  } catch (error) {
    throw new Error(`project.edn is not valid EDN: ${error.message}`);
  }
}

export function applicationDescriptorFromProject(value) {
  const project = object(value, "project.edn");
  closedKeys(project, PROJECT_KEYS, "project.edn");
  if (project["hara/type"] !== "project" || project["hara/version"] !== "1.0.0") {
    throw new Error("project.edn must declare :hara/type :project and :hara/version \"1.0.0\"");
  }
  const coordinate = scalar(project["project/id"], ":project/id");
  if (!COORDINATE.test(coordinate)) throw new Error(":project/id must be an owner/application coordinate");
  const [publisherId, id] = coordinate.split("/");
  const version = scalar(project["project/version"], ":project/version");
  if (!SEMVER.test(version)) throw new Error(":project/version must be SemVer");
  for (const key of ["project/source-paths", "project/test-paths", "project/extension-paths"]) {
    vector(project[key], `:${key}`).forEach((entry) => scalar(entry, `:${key} entry`));
  }
  const capabilities = vector(project["project/capabilities"], ":project/capabilities")
    .map((entry) => scalar(entry, ":project/capabilities entry"));
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(":project/capabilities cannot contain duplicates");
  }
  const dependencies = object(project["project/dependencies"] ?? {}, ":project/dependencies");
  if (Object.keys(dependencies).length) {
    throw new Error("Bundled Greenways applications cannot declare unresolved project dependencies");
  }
  const main = scalar(project["project/main"], ":project/main");
  if (!QUALIFIED_SYMBOL.test(main)) throw new Error(":project/main must be a qualified HAL var");

  const application = object(project["project/application"], ":project/application");
  closedKeys(application, APPLICATION_KEYS, ":project/application");
  return Object.freeze({
    protocol: "greenways-app/0-alpha",
    id,
    version,
    publisher: Object.freeze({
      id: publisherId,
      name: scalar(application["application/publisher-name"], ":application/publisher-name"),
    }),
    name: scalar(application["application/name"], ":application/name"),
    description: scalar(application["application/description"], ":application/description"),
    category: scalar(application["application/category"], ":application/category"),
    capabilities: Object.freeze(capabilities),
    launch: Object.freeze(launch(application["application/launch"])),
    project: Object.freeze({ coordinate, main }),
  });
}

export function applicationDescriptorFromEdn(source) {
  return applicationDescriptorFromProject(parseApplicationProject(source));
}

export async function applicationDescriptorWithDigest(source) {
  const descriptor = applicationDescriptorFromEdn(source);
  return Object.freeze({
    ...descriptor,
    project: Object.freeze({
      ...descriptor.project,
      digest: await sha256(String(source)),
    }),
  });
}
