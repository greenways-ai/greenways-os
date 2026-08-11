import { validateAppCatalog, validateAppManifest } from "./app-catalog.js";
import { sameManifestApproval } from "./app-launch.js";

export const PACKAGE_MANAGER_PROTOCOL = "greenways-package-manager/0-alpha";
export const PACKAGE_PROTOCOL = "greenways-package/0-alpha";

export const PACKAGE_KINDS = Object.freeze([
  "system",
  "bundled-module",
  "companion",
  "web-application",
]);

function kindForManifest(manifest) {
  if (manifest.category === "system") return "system";
  if (manifest.launch.handler === "packaged-surface") return "bundled-module";
  if (manifest.launch.handler === "native-hybrid") return "companion";
  if (manifest.launch.handler === "web-tab") return "web-application";
  throw new Error(`Unsupported package binding for ${manifest.id}`);
}

export function projectPackage(manifest) {
  const safe = validateAppManifest(manifest);
  return Object.freeze({
    protocol: PACKAGE_PROTOCOL,
    id: safe.id,
    version: safe.version,
    publisher: safe.publisher,
    name: safe.name,
    description: safe.description,
    kind: kindForManifest(safe),
    capabilities: safe.capabilities,
    launch: safe.launch,
    requirement: safe.requirement ?? null,
  });
}

export function projectPackageCatalog(catalog) {
  return Object.freeze(validateAppCatalog(catalog).map(projectPackage));
}

export function packageInventory(catalog, installed = []) {
  const packages = projectPackageCatalog(catalog);
  if (!Array.isArray(installed)) throw new TypeError("Installed package projection must be an array");
  const approvals = new Map(installed.map((manifest) => {
    const safe = validateAppManifest(manifest);
    return [safe.id, safe];
  }));

  const entries = packages.map((pkg) => {
    const approved = approvals.get(pkg.id) ?? null;
    const current = validateAppManifest(catalog.find(({ id }) => id === pkg.id));
    const status = !approved
      ? "available"
      : sameManifestApproval(approved, current)
        ? "installed"
        : "update-available";
    return Object.freeze({ ...pkg, status });
  });

  return Object.freeze({
    protocol: PACKAGE_MANAGER_PROTOCOL,
    entries: Object.freeze(entries),
    installed: entries.filter(({ status }) => status === "installed").length,
    updates: entries.filter(({ status }) => status === "update-available").length,
    available: entries.filter(({ status }) => status === "available").length,
  });
}

export function packageKindLabel(kind) {
  const labels = {
    system: "SYSTEM PACKAGE",
    "bundled-module": "BUNDLED PACKAGE",
    companion: "COMPANION PACKAGE",
    "web-application": "WEB PACKAGE",
  };
  if (!PACKAGE_KINDS.includes(kind)) throw new Error(`Unsupported package kind: ${kind}`);
  return labels[kind];
}
