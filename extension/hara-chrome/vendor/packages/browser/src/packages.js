import { parseEDNString } from "edn-data";
import { unzipSync } from "fflate";

const ednOptions = {
  mapAs: "object",
  setAs: "array",
  listAs: "array",
  keywordAs: "string",
  charAs: "string",
  objectKeysAs: "string"
};

const textDecoder = new TextDecoder();

function parseEdn(source) {
  return parseEDNString(String(source), ednOptions);
}

function hex(bytes) {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${hex(new Uint8Array(digest))}`;
}

const defaultPackagesOrigin = "https://packages.hara-lang.org";

function ednScalar(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.sym === "string") return value.sym;
  if (value && typeof value.key === "string") return value.key;
  return String(value);
}

function packageCoordinate(lock, target) {
  if (Object.hasOwn(lock.packages ?? {}, target)) return target;
  for (const [coordinate, entry] of Object.entries(lock.packages ?? {})) {
    if ((entry.namespaces ?? []).some((namespace) => ednScalar(namespace) === target)) return coordinate;
  }
  throw new Error(`package/not-locked: ${target}`);
}

function lockedClosure(lock, targets) {
  const selected = new Set();
  const visit = (target) => {
    const coordinate = packageCoordinate(lock, target);
    if (selected.has(coordinate)) return;
    const entry = lock.packages[coordinate];
    selected.add(coordinate);
    for (const dependency of Object.keys(entry.dependencies ?? {})) visit(dependency);
  };
  for (const target of targets ?? Object.keys(lock.packages ?? {})) visit(target);
  return [...selected].sort();
}

function safeArchivePath(path) {
  return path
    && !path.startsWith("/")
    && !path.includes("\\")
    && path.split("/").every((part) => part && part !== "." && part !== "..");
}

/**
 * Downloads and verifies every HARP archive through the commit-pinned Packages
 * registry. Nothing is registered until all packages verify.
 */
export async function loadLockedPackageResources(
  lockSource,
  request = (...args) => globalThis.fetch(...args),
  origin = defaultPackagesOrigin,
  targets
) {
  const lock = parseEdn(lockSource);
  if (lock["lock/format"] !== "0.0.0-alpha") {
    throw new Error("project.lock.edn requires :lock/format \"0.0.0-alpha\"");
  }

  const staged = {};
  for (const coordinate of lockedClosure(lock, targets)) {
    const entry = lock.packages[coordinate];
    const registryCommit = entry["registry-commit"];
    const identityRevision = entry["identity-revision"];
    const digest = entry["archive-sha256"];
    const version = entry.version;
    if (!/^[0-9a-f]{40}$/.test(registryCommit ?? "")
        || !/^[0-9a-f]{40}$/.test(identityRevision ?? "")
        || !/^sha256:[0-9a-f]{64}$/.test(digest ?? "")
        || typeof version !== "string") {
      throw new Error(`Locked package ${coordinate} has an incomplete exact descriptor`);
    }
    const base = String(origin).replace(/\/$/, "");
    const registryResponse = await request(`${base}/v1/registry?ref=${registryCommit}`);
    if (!registryResponse.ok) {
      throw new Error(`Locked package ${coordinate} registry failed: ${registryResponse.status}`);
    }
    const registry = parseEdn(await registryResponse.text());
    const release = registry["registry/packages"]?.[coordinate]?.[version];
    if (release?.["archive-sha256"] !== digest
        || release?.["identity-revision"] !== identityRevision) {
      throw new Error(`Locked package ${coordinate} registry mismatch`);
    }
    const response = await request(`${base}/objects/sha256/${digest.slice(7)}`);
    if (!response.ok) {
      throw new Error(`Locked package ${coordinate} failed: ${response.status}`);
    }
    const archive = new Uint8Array(await response.arrayBuffer());
    if (entry.size !== undefined && archive.byteLength !== entry.size) {
      throw new Error(`Locked package ${coordinate} size mismatch`);
    }
    if (await sha256(archive) !== digest) {
      throw new Error(`Locked package ${coordinate} digest mismatch`);
    }

    const files = unzipSync(archive);
    if (!files["package.edn"]) {
      throw new Error(`Locked package ${coordinate} has no package.edn`);
    }
    for (const path of Object.keys(files)) {
      if (!safeArchivePath(path)) {
        throw new Error(`Locked package ${coordinate} contains an unsafe path`);
      }
    }

    const manifest = parseEdn(textDecoder.decode(files["package.edn"]));
    for (const [path, file] of Object.entries(manifest.files ?? {})) {
      const bytes = files[path];
      if (!bytes) {
        throw new Error(`Locked package ${coordinate} is missing ${path}`);
      }
      if (file.size !== bytes.byteLength || await sha256(bytes) !== file.sha256) {
        throw new Error(`Locked package ${coordinate} failed file verification: ${path}`);
      }
    }
    for (const [namespace, path] of Object.entries(manifest.resources ?? {})) {
      if (Object.hasOwn(staged, namespace)) {
        throw new Error(`Duplicate locked HAL namespace: ${namespace}`);
      }
      const bytes = files[path];
      if (!bytes) {
        throw new Error(`Locked package ${coordinate} is missing resource ${path}`);
      }
      staged[namespace] = textDecoder.decode(bytes);
    }
  }
  return staged;
}

/** Installs the on-demand Package capability used by std.native.Package. */
export function installPackageProvider(runtime, lockSource, options = {}) {
  const lock = parseEdn(lockSource);
  const active = new Set();
  runtime.raw?.registerPackageLock?.(lockSource);
  const handler = async (service, operation, arguments_) => {
    if (service !== "package") throw new Error(`host/unsupported-service: ${service}`);
    const descriptor = arguments_?.[0] ?? {};
    const coordinate = descriptor["package/coordinate"];
    if (typeof coordinate !== "string") throw new Error("package/descriptor-invalid");
    if (operation === "ensure") {
      const closure = lockedClosure(lock, [coordinate]);
      const resources = await loadLockedPackageResources(
        lockSource,
        options.fetch,
        options.origin ?? defaultPackagesOrigin,
        closure
      );
      for (const [namespace, source] of Object.entries(resources)) {
        runtime.registerResource(namespace, source);
      }
      closure.forEach((item) => active.add(item));
      return descriptor;
    }
    if (operation === "unload") {
      const cascade = arguments_?.[1]?.cascade === true;
      const selected = new Set([coordinate]);
      if (cascade) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const [candidate, entry] of Object.entries(lock.packages ?? {})) {
            if (active.has(candidate)
                && Object.keys(entry.dependencies ?? {}).some((dependency) => selected.has(dependency))
                && !selected.has(candidate)) {
              selected.add(candidate);
              changed = true;
            }
          }
        }
      } else {
        const blockers = Object.entries(lock.packages ?? {})
          .filter(([candidate, entry]) => active.has(candidate)
            && Object.keys(entry.dependencies ?? {}).includes(coordinate))
          .map(([candidate]) => candidate);
        if (blockers.length) throw new Error(`package/unload-blocked: ${blockers.join(",")}`);
      }
      const order = [...selected].reverse();
      for (const item of order) {
        for (const namespace of lock.packages[item]?.namespaces ?? []) {
          runtime.raw?.unregister_resource?.(ednScalar(namespace));
        }
        active.delete(item);
      }
      return order;
    }
    throw new Error(`package/unsupported-operation: ${operation}`);
  };
  runtime.raw?.install_host_handler?.(handler);
  return Object.freeze({ active, handler });
}

/** Verifies a lock completely, then atomically exposes its HAL resources. */
export async function installLockedPackages(runtime, lockSource, options = {}) {
  runtime.raw?.registerPackageLock?.(lockSource);
  const resources = await loadLockedPackageResources(
    lockSource,
    options.fetch,
    options.origin ?? defaultPackagesOrigin,
    options.targets
  );
  for (const [namespace, source] of Object.entries(resources)) {
    runtime.registerResource(namespace, source);
  }
  return Object.keys(resources);
}
