import { parseEDNString } from "edn-data";
import { unzipSync } from "fflate";

const ednOptions = {
  mapAs: "object", setAs: "array", listAs: "array",
  keywordAs: "string", charAs: "string", objectKeysAs: "string",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const HARP_LIMITS = Object.freeze({
  archiveBytes: 8 * 1024 * 1024,
  files: 512,
  expandedBytes: 16 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
});
const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

async function sha256(bytes) {
  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

function packageUrl(entry) {
  return entry["distribution/url"]
    ?? entry["packages/url"]
    ?? entry["release-url"]
    ?? entry.url
    ?? entry["distribution/path"];
}

function packageDigest(entry) {
  return entry["harp-sha256"] ?? entry.sha256;
}

function safeArchivePath(path) {
  return path && !path.startsWith("/") && !path.includes("\\")
    && path.split("/").every((part) => part && part !== "." && part !== "..");
}


function unzipBoundedArchive(archive, coordinate) {
  if (archive.byteLength > HARP_LIMITS.archiveBytes) {
    throw new Error(`Locked package ${coordinate} exceeds the ${HARP_LIMITS.archiveBytes} byte archive limit`);
  }
  let files = 0;
  let expandedBytes = 0;
  return unzipSync(archive, {
    filter(file) {
      if (!safeArchivePath(file.name)) {
        throw new Error(`Locked package ${coordinate} contains an unsafe path`);
      }
      files += 1;
      if (files > HARP_LIMITS.files) {
        throw new Error(`Locked package ${coordinate} contains too many files`);
      }
      if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
        throw new Error(`Locked package ${coordinate} has an invalid expanded size for ${file.name}`);
      }
      expandedBytes += file.originalSize;
      if (expandedBytes > HARP_LIMITS.expandedBytes) {
        throw new Error(`Locked package ${coordinate} exceeds the expanded byte limit`);
      }
      return true;
    },
  });
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function packageAppEntry(manifest, label) {
  const descriptor = manifest["greenways/app"];
  if (descriptor === undefined) return null;
  const input = plainObject(descriptor, `${label} :greenways/app`);
  for (const key of Object.keys(input)) {
    if (key !== "entry") throw new Error(`${label} :greenways/app contains unsupported field ${key}`);
  }
  if (typeof input.entry !== "string" || !input.entry.includes("/")) {
    throw new Error(`${label} :greenways/app requires a namespace-qualified :entry`);
  }
  return input.entry;
}

function freezePackageRecord(record) {
  return Object.freeze({
    ...record,
    resourceNames: Object.freeze(record.resourceNames),
  });
}

/**
 * Fetches and verifies every archive in a :lock/format \"0.0.0-alpha\" lock.
 *
 * The returned bundle deliberately keeps executable HAL source separate from
 * app manifests. Callers may persist the exact lock and archive bytes, but a
 * module can become active only after manifest validation, approval policy,
 * and the HAL namespace container have accepted it.
 */
export async function loadLockedPackageBundle(
  lockSource,
  request = (...args) => globalThis.fetch(...args),
  { resolvePackageUrl = (value) => value } = {},
) {
  const lockText = String(lockSource);
  const lock = parseEDNString(lockText, ednOptions);
  if (lock["lock/format"] !== "0.0.0-alpha") throw new Error("project.lock.edn requires alpha lock format");
  plainObject(lock.packages ?? {}, "project.lock.edn packages");

  const staged = {};
  const packages = {};
  for (const [coordinate, rawEntry] of Object.entries(lock.packages ?? {})) {
    const entry = plainObject(rawEntry, `Locked package ${coordinate}`);
    const lockedUrl = packageUrl(entry);
    const digest = packageDigest(entry);
    if (!lockedUrl || !digest) throw new Error(`Locked package ${coordinate} is missing its URL or SHA-256`);
    const url = resolvePackageUrl(lockedUrl, { coordinate, entry });
    if (typeof url !== "string" || !url) throw new Error(`Locked package ${coordinate} resolved to an invalid URL`);

    const response = await request(url);
    if (!response?.ok) throw new Error(`Locked package ${coordinate} failed: ${response?.status ?? "network"}`);
    const archive = new Uint8Array(await response.arrayBuffer());
    if (archive.byteLength > HARP_LIMITS.archiveBytes) {
      throw new Error(`Locked package ${coordinate} exceeds the ${HARP_LIMITS.archiveBytes} byte archive limit`);
    }
    if (entry.size !== undefined && archive.byteLength !== entry.size) {
      throw new Error(`Locked package ${coordinate} size mismatch`);
    }
    if (await sha256(archive) !== digest) throw new Error(`Locked package ${coordinate} digest mismatch`);

    const files = unzipBoundedArchive(archive, coordinate);
    if (!files["package.edn"]) throw new Error(`Locked package ${coordinate} has no package.edn`);
    if (files["package.edn"].byteLength > HARP_LIMITS.manifestBytes) {
      throw new Error(`Locked package ${coordinate} package.edn exceeds the manifest byte limit`);
    }

    const manifest = parseEDNString(decoder.decode(files["package.edn"]), ednOptions);
    if (manifest["harp/format"] !== "0.0.0-alpha") {
      throw new Error(`Locked package ${coordinate} requires :harp/format \"0.0.0-alpha\"`);
    }
    const declaredFiles = plainObject(manifest.files ?? {}, `Locked package ${coordinate} files`);
    const declaredResources = plainObject(manifest.resources ?? {}, `Locked package ${coordinate} resources`);
    const archivePaths = new Set(Object.keys(files));
    const declaredPaths = new Set(["package.edn", ...Object.keys(declaredFiles)]);
    for (const path of archivePaths) {
      if (!declaredPaths.has(path)) {
        throw new Error(`Locked package ${coordinate} contains undeclared file ${path}`);
      }
    }
    for (const path of declaredPaths) {
      if (!archivePaths.has(path)) {
        throw new Error(`Locked package ${coordinate} is missing ${path}`);
      }
    }

    for (const [path, rawFile] of Object.entries(declaredFiles)) {
      if (!safeArchivePath(path)) throw new Error(`Locked package ${coordinate} declares an unsafe path`);
      const file = plainObject(rawFile, `Locked package ${coordinate} file ${path}`);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || !/^sha256:[a-f0-9]{64}$/.test(file.sha256 ?? "")) {
        throw new Error(`Locked package ${coordinate} has invalid file evidence for ${path}`);
      }
      const bytes = files[path];
      if (!bytes) throw new Error(`Locked package ${coordinate} is missing ${path}`);
      if (file.size !== bytes.byteLength || await sha256(bytes) !== file.sha256) {
        throw new Error(`Locked package ${coordinate} failed file verification: ${path}`);
      }
    }

    const resourceNames = [];
    for (const [namespace, path] of Object.entries(declaredResources)) {
      if (typeof path !== "string" || !safeArchivePath(path)) {
        throw new Error(`Locked package ${coordinate} declares an unsafe resource path`);
      }
      if (!(path in declaredFiles)) {
        throw new Error(`Locked package ${coordinate} resource ${path} is not digest-declared`);
      }
      if (staged[namespace]) throw new Error(`Duplicate locked HAL namespace: ${namespace}`);
      const bytes = files[path];
      if (!bytes) throw new Error(`Locked package ${coordinate} is missing resource ${path}`);
      staged[namespace] = decoder.decode(bytes);
      resourceNames.push(namespace);
    }

    packages[coordinate] = freezePackageRecord({
      coordinate,
      version: entry.version ?? null,
      url,
      digest,
      size: archive.byteLength,
      archive: archive.slice(),
      manifest,
      appEntry: packageAppEntry(manifest, `Locked package ${coordinate}`),
      resourceNames,
    });
  }

  return Object.freeze({
    lock,
    lockSource: lockText,
    lockDigest: await sha256(encoder.encode(lockText)),
    resources: Object.freeze(staged),
    packages: Object.freeze(packages),
  });
}

export async function loadLockedPackageResources(lockSource, request, options) {
  return (await loadLockedPackageBundle(lockSource, request, options)).resources;
}

export function lockedPackageAppEntry(bundle) {
  const entries = Object.values(plainObject(bundle?.packages, "Locked package bundle packages"))
    .map((record) => record?.appEntry)
    .filter(Boolean);
  if (entries.length !== 1) {
    throw new Error(`Locked package graph must declare exactly one Greenways app entry; found ${entries.length}`);
  }
  return entries[0];
}
