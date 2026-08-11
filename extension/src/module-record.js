import { validateAppManifest } from "./app-catalog.js";

export const MODULE_RECORD_PROTOCOL = "greenways-module-record/0-alpha";
export const MODULE_RECORD_LIMITS = Object.freeze({
  packages: 64,
  archiveBytes: 32 * 1024 * 1024,
});

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const APP_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const RECORD_KEYS = new Set([
  "protocol",
  "id",
  "manifest",
  "lockSource",
  "lockDigest",
  "entry",
  "packages",
  "installedAt",
]);
const PACKAGE_KEYS = new Set(["coordinate", "url", "digest", "size", "archive"]);

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

function nonEmptyString(value, label, maximum = 4096) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function digest(value, label) {
  const output = nonEmptyString(value, label, 80);
  if (!SHA256.test(output)) throw new Error(`${label} must be sha256:<64 lowercase hex characters>`);
  return output;
}

function appId(value, label = "Module record id") {
  const output = nonEmptyString(value, label, 80);
  if (!APP_ID.test(output)) throw new Error(`${label} must be a lowercase app identifier`);
  return output;
}

function qualifiedEntry(value) {
  const output = nonEmptyString(value, "Module record entry", 240);
  const slash = output.indexOf("/");
  if (slash <= 0 || slash !== output.lastIndexOf("/") || slash === output.length - 1) {
    throw new Error("Module record entry must be a namespace-qualified symbol");
  }
  return output;
}

function archiveBytes(value, label) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be a Uint8Array`);
  return value.slice();
}

function normalizePackages(value) {
  const input = plainObject(value, "Module record packages");
  const entries = Object.entries(input);
  if (!entries.length) throw new Error("Module record packages cannot be empty");
  if (entries.length > MODULE_RECORD_LIMITS.packages) {
    throw new Error(`Module record cannot contain more than ${MODULE_RECORD_LIMITS.packages} packages`);
  }
  const output = {};
  const urls = new Set();
  let bytes = 0;
  for (const [coordinateKey, raw] of entries) {
    const coordinate = nonEmptyString(coordinateKey, "Module package coordinate", 240);
    const inputPackage = plainObject(raw, `Module package ${coordinate}`);
    closedKeys(inputPackage, PACKAGE_KEYS, `Module package ${coordinate}`);
    if (inputPackage.coordinate !== coordinate) {
      throw new Error(`Module package ${coordinate} coordinate does not match its key`);
    }
    const url = nonEmptyString(inputPackage.url, `Module package ${coordinate} URL`, 2048);
    if (urls.has(url)) throw new Error(`Module record contains duplicate archive URL ${url}`);
    urls.add(url);
    const archive = archiveBytes(inputPackage.archive, `Module package ${coordinate} archive`);
    if (!Number.isSafeInteger(inputPackage.size) || inputPackage.size < 0 || inputPackage.size !== archive.byteLength) {
      throw new Error(`Module package ${coordinate} size does not match its archive`);
    }
    bytes += archive.byteLength;
    if (bytes > MODULE_RECORD_LIMITS.archiveBytes) {
      throw new Error("Module record archives exceed the persistent byte limit");
    }
    output[coordinate] = Object.freeze({
      coordinate,
      url,
      digest: digest(inputPackage.digest, `Module package ${coordinate} digest`),
      size: archive.byteLength,
      archive,
    });
  }
  return Object.freeze(output);
}

function normalizeManifest(value) {
  const manifest = validateAppManifest(value, "Module record manifest");
  if (manifest.kind !== "hal-module" || manifest.launch.handler !== "hal-module") {
    throw new Error("Module record manifest must describe a hal-module launch");
  }
  return manifest;
}

/**
 * Returns the bounded approval projection of a durable module record.
 *
 * This intentionally does not copy or verify archive bytes. Authorization may
 * use this projection only when the same app and lock digest are also present
 * in host-owned runtime state populated after full boot-time verification.
 */
export function moduleRecordApproval(value) {
  const input = plainObject(value, "Module record");
  closedKeys(input, RECORD_KEYS, "Module record");
  if (input.protocol !== MODULE_RECORD_PROTOCOL) {
    throw new Error(`Module record protocol must be ${MODULE_RECORD_PROTOCOL}`);
  }
  const manifest = normalizeManifest(input.manifest);
  const id = appId(input.id);
  if (id !== manifest.id) throw new Error("Module record id does not match its manifest");
  const lockDigest = digest(input.lockDigest, "Module record lock digest");
  if (lockDigest !== manifest.lockDigest) {
    throw new Error("Module record lock digest does not match its approval manifest");
  }
  const installedAt = nonEmptyString(input.installedAt, "Module record installation time", 80);
  if (Number.isNaN(Date.parse(installedAt))) throw new Error("Module record installation time is invalid");
  return Object.freeze({
    protocol: MODULE_RECORD_PROTOCOL,
    id,
    manifest,
    lockDigest,
    installedAt,
  });
}

export function validateModuleRecord(value) {
  const input = plainObject(value, "Module record");
  const approval = moduleRecordApproval(input);
  return Object.freeze({
    ...approval,
    lockSource: nonEmptyString(input.lockSource, "Module record lock source", 4 * 1024 * 1024),
    entry: qualifiedEntry(input.entry),
    packages: normalizePackages(input.packages),
  });
}

export function createModuleRecord(manifestValue, bundle, {
  entry: entryValue,
  now = () => new Date(),
} = {}) {
  const manifest = normalizeManifest(manifestValue);
  const input = plainObject(bundle, "Verified package bundle");
  const packages = {};
  for (const [coordinate, raw] of Object.entries(plainObject(input.packages, "Verified package bundle packages"))) {
    const value = plainObject(raw, `Verified package ${coordinate}`);
    packages[coordinate] = {
      coordinate,
      url: value.url,
      digest: value.digest,
      size: value.size,
      archive: value.archive,
    };
  }
  return validateModuleRecord({
    protocol: MODULE_RECORD_PROTOCOL,
    id: manifest.id,
    manifest,
    lockSource: input.lockSource,
    lockDigest: input.lockDigest,
    entry: entryValue ?? input.entry,
    packages,
    installedAt: now().toISOString(),
  });
}

export function moduleArchiveRequest(recordValue) {
  const record = validateModuleRecord(recordValue);
  const byUrl = new Map(Object.values(record.packages).map((entry) => [entry.url, entry]));
  return async (url) => {
    const entry = byUrl.get(String(url));
    if (!entry) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const archive = entry.archive.slice();
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
    };
  };
}

export async function stageModuleRecord(recordValue, {
  loadBundle,
  appEntry,
} = {}) {
  if (typeof loadBundle !== "function" || typeof appEntry !== "function") {
    throw new TypeError("Module record staging requires package verification functions");
  }
  const record = validateModuleRecord(recordValue);
  const bundle = await loadBundle(record.lockSource, moduleArchiveRequest(record));
  if (bundle.lockDigest !== record.lockDigest) {
    throw new Error("Re-verified module lock digest does not match its install record");
  }
  const entry = appEntry(bundle);
  if (entry !== record.entry) throw new Error("Re-verified module entry does not match its install record");
  const packageEvidence = Object.fromEntries(
    Object.entries(bundle.packages).map(([coordinate, value]) => [coordinate, {
      url: value.url,
      digest: value.digest,
      size: value.size,
    }]),
  );
  for (const [coordinate, expected] of Object.entries(record.packages)) {
    const actual = packageEvidence[coordinate];
    if (!actual
      || actual.url !== expected.url
      || actual.digest !== expected.digest
      || actual.size !== expected.size) {
      throw new Error(`Re-verified module package evidence changed for ${coordinate}`);
    }
  }
  if (Object.keys(packageEvidence).length !== Object.keys(record.packages).length) {
    throw new Error("Re-verified module package graph changed");
  }
  return Object.freeze({
    id: record.id,
    lockDigest: record.lockDigest,
    entry,
    resources: bundle.resources,
    manifest: record.manifest,
  });
}
