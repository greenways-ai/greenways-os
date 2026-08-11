import { parseEDNString } from "edn-data";
import { unzipSync } from "fflate";
import { sha256 } from "./crypto.js";

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

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function safePath(value) {
  return typeof value === "string" && value && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}


function unzipBoundedArchive(archive, coordinate) {
  if (archive.byteLength > HARP_LIMITS.archiveBytes) {
    throw new Error(`Locked package ${coordinate} exceeds the ${HARP_LIMITS.archiveBytes} byte archive limit`);
  }
  let files = 0;
  let expandedBytes = 0;
  return unzipSync(archive, {
    filter(file) {
      if (!safePath(file.name)) throw new Error(`Locked package ${coordinate} contains an unsafe path`);
      files += 1;
      if (files > HARP_LIMITS.files) throw new Error(`Locked package ${coordinate} contains too many files`);
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

function archiveUrl(entry) {
  return entry["distribution/url"] ?? entry["packages/url"] ?? entry["release-url"] ?? entry.url;
}

function archiveDigest(entry) {
  return entry["harp-sha256"] ?? entry.sha256;
}

function appEntry(manifest, label) {
  const raw = manifest["greenways/app"];
  if (raw === undefined) return null;
  const value = plainObject(raw, `${label} :greenways/app`);
  for (const key of Object.keys(value)) {
    if (key !== "entry") throw new Error(`${label} :greenways/app contains unsupported field ${key}`);
  }
  if (typeof value.entry !== "string" || !value.entry.includes("/")) {
    throw new Error(`${label} :greenways/app requires a namespace-qualified :entry`);
  }
  return value.entry;
}

export async function verifyLockedPackageBundle(lockSource, request) {
  const lockText = String(lockSource);
  const lock = parseEDNString(lockText, ednOptions);
  if (lock["lock/format"] !== "0.0.0-alpha") throw new Error("project.lock.edn requires alpha lock format");
  const lockPackages = plainObject(lock.packages ?? {}, "project.lock.edn packages");
  const packages = {};
  const resources = {};

  for (const [coordinate, rawEntry] of Object.entries(lockPackages)) {
    const entry = plainObject(rawEntry, `Locked package ${coordinate}`);
    const url = archiveUrl(entry);
    const digest = archiveDigest(entry);
    if (typeof url !== "string" || !url || typeof digest !== "string" || !digest) {
      throw new Error(`Locked package ${coordinate} is missing its URL or SHA-256`);
    }
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
    if (manifest["harp/format"] !== "0.0.0-alpha") throw new Error(`Locked package ${coordinate} requires alpha HARP format`);
    const declaredFiles = plainObject(manifest.files ?? {}, `Locked package ${coordinate} files`);
    const declaredResources = plainObject(manifest.resources ?? {}, `Locked package ${coordinate} resources`);
    const archivePaths = new Set(Object.keys(files));
    const declaredPaths = new Set(["package.edn", ...Object.keys(declaredFiles)]);
    for (const path of archivePaths) {
      if (!declaredPaths.has(path)) throw new Error(`Locked package ${coordinate} contains undeclared file ${path}`);
    }
    for (const path of declaredPaths) {
      if (!archivePaths.has(path)) throw new Error(`Locked package ${coordinate} is missing ${path}`);
    }

    for (const [path, rawFile] of Object.entries(declaredFiles)) {
      if (!safePath(path)) throw new Error(`Locked package ${coordinate} declares an unsafe path`);
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
    for (const [namespace, path] of Object.entries(declaredResources)) {
      if (!safePath(path) || !(path in declaredFiles)) {
        throw new Error(`Locked package ${coordinate} resource ${path} is not safely digest-declared`);
      }
      if (resources[namespace]) throw new Error(`Duplicate locked HAL namespace: ${namespace}`);
      const bytes = files[path];
      if (!bytes) throw new Error(`Locked package ${coordinate} is missing resource ${path}`);
      resources[namespace] = decoder.decode(bytes);
    }
    packages[coordinate] = Object.freeze({
      coordinate,
      manifest,
      appEntry: appEntry(manifest, `Locked package ${coordinate}`),
    });
  }

  return Object.freeze({
    lock,
    lockSource: lockText,
    lockDigest: await sha256(encoder.encode(lockText)),
    packages: Object.freeze(packages),
    resources: Object.freeze(resources),
  });
}

export function requireSingleAppEntry(bundle) {
  const entries = Object.values(plainObject(bundle?.packages, "Locked package bundle packages"))
    .map((record) => record.appEntry)
    .filter(Boolean);
  if (entries.length !== 1) {
    throw new Error(`Locked package graph must declare exactly one Greenways app entry; found ${entries.length}`);
  }
  return entries[0];
}
