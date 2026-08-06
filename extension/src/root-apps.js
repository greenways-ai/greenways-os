export const ROOT_APP_PROTOCOL = "greenways-root-app/1";

const ROOT_APP_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SAFE_PATH = /^[a-zA-Z0-9._/-]+\.html(?:#[a-zA-Z0-9._-]+)?$/;

function requiredString(value, label, maximum = 240) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function normalizeRootApp(value, label = "Root app") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const allowed = new Set([
    "protocol", "id", "version", "name", "description", "path",
    "authority", "preinstalled", "removable",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  if (value.protocol !== ROOT_APP_PROTOCOL) {
    throw new Error(`${label}.protocol must be ${ROOT_APP_PROTOCOL}`);
  }
  const id = requiredString(value.id, `${label}.id`, 80);
  if (!ROOT_APP_ID.test(id)) throw new Error(`${label}.id must be a lowercase root app id`);
  const path = requiredString(value.path, `${label}.path`, 180);
  if (!SAFE_PATH.test(path) || path.startsWith("/") || path.includes("..") || path.includes("\\")) {
    throw new Error(`${label}.path must be a safe packaged HTML path`);
  }
  if (!Array.isArray(value.authority) || !value.authority.length) {
    throw new Error(`${label}.authority must be a non-empty array`);
  }
  const authority = value.authority.map((entry, index) => requiredString(entry, `${label}.authority[${index}]`, 80));
  if (new Set(authority).size !== authority.length) throw new Error(`${label}.authority cannot contain duplicates`);
  if (value.preinstalled !== true || value.removable !== false) {
    throw new Error(`${label} must be preinstalled and non-removable`);
  }
  return Object.freeze({
    protocol: ROOT_APP_PROTOCOL,
    id,
    version: requiredString(value.version, `${label}.version`, 40),
    name: requiredString(value.name, `${label}.name`, 80),
    description: requiredString(value.description, `${label}.description`, 320),
    path,
    authority: Object.freeze(authority),
    preinstalled: true,
    removable: false,
  });
}

export const ROOT_APPS = Object.freeze([
  normalizeRootApp({
    protocol: ROOT_APP_PROTOCOL,
    id: "greenways-devtools",
    version: "0.1.0",
    name: "Kernel DevTools",
    description: "Inspect and program the browser-resident Hara kernel, with an authenticated local RESP bridge for editor and REPL tooling.",
    path: "src/devtools.html",
    authority: ["kernel/inspect", "kernel/evaluate", "devtools/bridge"],
    preinstalled: true,
    removable: false,
  }),
]);

const ROOT_APPS_BY_ID = new Map(ROOT_APPS.map((app) => [app.id, app]));

export function getRootApp(id) {
  return ROOT_APPS_BY_ID.get(String(id)) ?? null;
}

export function resolveRootAppUrl(id, runtime = globalThis.chrome?.runtime) {
  if (!runtime?.getURL) throw new Error("Extension runtime is unavailable");
  const app = getRootApp(id);
  if (!app) throw new Error(`Unknown Greenways root app: ${id}`);
  return runtime.getURL(app.path);
}
