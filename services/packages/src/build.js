import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { appApprovalIdentity, validateReleaseModuleManifest } from "./app.js";
import { requireSingleAppEntry, verifyLockedPackageBundle } from "./harp.js";
import { encodeEdn } from "./edn.js";
import {
  importPrivateP256,
  publisherPayload,
  readPrivateJwk,
  sha256,
  signEs256,
} from "./crypto.js";

const SOURCE_PROTOCOL = "greenways-registry-source/1";
const encoder = new TextEncoder();

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function origin(value) {
  const url = new URL(nonEmpty(value, "registry origin"));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("registry origin must be a credential-free HTTPS origin");
  }
  url.pathname = "/";
  return url.href;
}

function safeSourcePath(root, path, label) {
  const target = resolve(root, nonEmpty(path, label));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || rel.includes("\\")) throw new Error(`${label} escapes the source directory`);
  return target;
}

function packageOutputPath(coordinate, version, name) {
  return `v1/packages/${encodeURIComponent(coordinate)}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`;
}

function manifestEdn(manifest) {
  return {
    "app/protocol": manifest.protocol,
    "app/id": manifest.id,
    "app/version": manifest.version,
    "app/publisher": {
      "publisher/id": manifest.publisher.id,
      "publisher/name": manifest.publisher.name,
    },
    "app/name": manifest.name,
    "app/description": manifest.description,
    "app/category": manifest.category,
    "app/capabilities": manifest.capabilities,
  };
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function buildVersion({
  sourceRoot,
  outputRoot,
  registry,
  packageRecord,
  versionRecord,
  publisherKey,
}) {
  const coordinate = nonEmpty(packageRecord.coordinate, "package coordinate");
  const version = nonEmpty(versionRecord.version, `${coordinate} version`);
  const appPath = safeSourcePath(sourceRoot, versionRecord.app, `${coordinate}@${version} app path`);
  const baseApp = plainObject(await readJson(appPath, `${coordinate}@${version} app manifest`), `${coordinate}@${version} app manifest`);
  const archiveRecords = [];
  const archiveResponses = new Map();
  const outputNames = new Set();

  for (const [index, rawArchive] of (versionRecord.archives ?? []).entries()) {
    const archive = plainObject(rawArchive, `${coordinate}@${version} archive[${index}]`);
    const archiveCoordinate = nonEmpty(archive.coordinate, `${coordinate}@${version} archive coordinate`);
    const archiveVersion = nonEmpty(archive.version, `${archiveCoordinate} archive version`);
    const sourcePath = safeSourcePath(sourceRoot, archive.file, `${archiveCoordinate} archive path`);
    const bytes = new Uint8Array(await readFile(sourcePath));
    const name = basename(sourcePath);
    if (outputNames.has(name)) throw new Error(`${coordinate}@${version} contains duplicate archive basename ${name}`);
    outputNames.add(name);
    const relativePath = packageOutputPath(coordinate, version, name);
    const url = new URL(relativePath, registry).href;
    const digest = await sha256(bytes);
    archiveRecords.push({
      coordinate: archiveCoordinate,
      entry: {
        version: archiveVersion,
        "distribution/url": url,
        "harp-sha256": digest,
        size: bytes.byteLength,
      },
      sourcePath,
      relativePath,
      url,
      bytes,
    });
    archiveResponses.set(url, bytes);
  }
  if (!archiveRecords.length) throw new Error(`${coordinate}@${version} must contain at least one HARP archive`);

  const lockObject = {
    "lock/format": 2,
    packages: Object.fromEntries(archiveRecords.map(({ coordinate: id, entry }) => [id, entry])),
  };
  const lockSource = encodeEdn(lockObject);
  const bundle = await verifyLockedPackageBundle(lockSource, async (url) => {
    const bytes = archiveResponses.get(url);
    if (!bytes) return { ok: false, status: 404 };
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  });
  requireSingleAppEntry(bundle);

  const manifest = validateReleaseModuleManifest({
    ...baseApp,
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "release",
    lockDigest: bundle.lockDigest,
    source: { kind: "registry", registry, coordinate },
  });
  if (manifest.version !== version) throw new Error(`${coordinate}@${version} app version does not match its release directory`);
  if (manifest.id !== packageRecord.id) throw new Error(`${coordinate}@${version} app id does not match its package record`);
  if (manifest.publisher.id !== packageRecord.publisher.id) throw new Error(`${coordinate}@${version} publisher does not match its package record`);

  const signature = await signEs256(publisherKey, publisherPayload({
    registry,
    coordinate,
    version,
    lockDigest: bundle.lockDigest,
    approvalIdentity: appApprovalIdentity(manifest),
  }));

  for (const archive of archiveRecords) {
    const target = join(outputRoot, archive.relativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(archive.sourcePath, target);
  }
  const lockRelativePath = packageOutputPath(coordinate, version, "lock.edn");
  const lockTarget = join(outputRoot, lockRelativePath);
  await mkdir(dirname(lockTarget), { recursive: true });
  await writeFile(lockTarget, lockSource);

  return {
    version,
    indexRecord: {
      version,
      "lock/url": new URL(lockRelativePath, registry).href,
      "lock/sha256": bundle.lockDigest,
      "app/manifest": manifestEdn(manifest),
      "publisher/signature": {
        algorithm: "ES256",
        "key-id": packageRecord.publisher.keyId,
        value: signature,
      },
    },
  };
}

export async function buildRegistry({
  source,
  output,
  registryPrivateKey,
  now = () => new Date(),
} = {}) {
  const sourceRoot = resolve(source ?? ".");
  const configPath = join(sourceRoot, "registry.json");
  const config = plainObject(await readJson(configPath, "registry.json"), "registry.json");
  if (config.protocol !== SOURCE_PROTOCOL) throw new Error(`registry.json protocol must be ${SOURCE_PROTOCOL}`);
  const registry = origin(config.origin);
  const generated = now();
  const expiresSeconds = Number(config.expiresSeconds ?? 86400);
  if (!Number.isInteger(expiresSeconds) || expiresSeconds < 60 || expiresSeconds > 604800) {
    throw new Error("registry expiresSeconds must be an integer from 60 to 604800");
  }
  const expires = new Date(generated.getTime() + expiresSeconds * 1000);
  const outputRoot = resolve(output ?? join(sourceRoot, "dist"));
  const temporaryRoot = `${outputRoot}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporaryRoot, { recursive: true, force: true });
  await mkdir(temporaryRoot, { recursive: true });

  try {
    const registryKey = await importPrivateP256(await readPrivateJwk(resolve(registryPrivateKey)));
    const publisherKeys = new Map();
    const packages = {};
    for (const [index, rawPackage] of (config.packages ?? []).entries()) {
      const packageRecord = plainObject(rawPackage, `registry package[${index}]`);
      const coordinate = nonEmpty(packageRecord.coordinate, `registry package[${index}] coordinate`);
      const publisher = plainObject(packageRecord.publisher, `${coordinate} publisher`);
      for (const field of ["id", "name", "keyId", "privateKey"]) nonEmpty(publisher[field], `${coordinate} publisher ${field}`);
      let publisherKey = publisherKeys.get(publisher.keyId);
      if (!publisherKey) {
        publisherKey = await importPrivateP256(await readPrivateJwk(safeSourcePath(sourceRoot, publisher.privateKey, `${coordinate} publisher private key`)));
        publisherKeys.set(publisher.keyId, publisherKey);
      }
      const versions = {};
      for (const rawVersion of packageRecord.versions ?? []) {
        const built = await buildVersion({
          sourceRoot,
          outputRoot: temporaryRoot,
          registry,
          packageRecord,
          versionRecord: plainObject(rawVersion, `${coordinate} version`),
          publisherKey,
        });
        if (versions[built.version]) throw new Error(`${coordinate} contains duplicate version ${built.version}`);
        versions[built.version] = built.indexRecord;
      }
      const latest = nonEmpty(packageRecord.latest, `${coordinate} latest version`);
      if (!versions[latest]) throw new Error(`${coordinate} latest version is not present in versions`);
      packages[coordinate] = {
        "package/id": packageRecord.id,
        "package/publisher": {
          "publisher/id": publisher.id,
          "publisher/name": publisher.name,
          "publisher/key-id": publisher.keyId,
        },
        "package/latest": latest,
        "package/versions": versions,
      };
    }

    const payloadSource = encodeEdn({
      "index/protocol": "greenways-registry-index/1",
      "index/registry": registry,
      "index/generated-at": generated.toISOString(),
      "index/expires-at": expires.toISOString(),
      "index/packages": packages,
    });
    const payloadBytes = encoder.encode(payloadSource);
    const envelope = encodeEdn({
      "registry/protocol": "greenways-registry/1",
      "registry/key-id": nonEmpty(config.keyId, "registry keyId"),
      "registry/algorithm": "ES256",
      "registry/signed": Buffer.from(payloadBytes).toString("base64url"),
      "registry/signature": await signEs256(registryKey, payloadBytes),
    });
    await mkdir(join(temporaryRoot, "v1"), { recursive: true });
    await writeFile(join(temporaryRoot, "v1", "index.edn"), envelope);
    await writeFile(join(temporaryRoot, "v1", "index.payload.edn"), payloadSource);

    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(dirname(outputRoot), { recursive: true });
    await rename(temporaryRoot, outputRoot);
    return {
      output: outputRoot,
      registry,
      packages: Object.keys(packages).length,
      generatedAt: generated.toISOString(),
      expiresAt: expires.toISOString(),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}
