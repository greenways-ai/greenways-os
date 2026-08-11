import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { canonicalJson } from "./canonical.js";
import { encodeEdn } from "./edn.js";
import { FileObjectStore, sha256 } from "./file-object-store.js";
import { inspectImage } from "./image-metadata.js";

export const ASSET_PROTOCOL = "greenways-asset/0-alpha";
export const ASSET_STATES = Object.freeze(["inbox", "curated", "approved", "published", "deprecated"]);
const ASSET_STATE_RANK = new Map(ASSET_STATES.map((state, index) => [state, index]));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){0,7}$/;
const MAX_TEXT = 2000;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

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

function nonEmpty(value, label, maximum = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError(`${label} must be at most ${maximum} characters`);
  return normalized;
}

function optionalText(value, label, maximum = MAX_TEXT) {
  if (value === undefined || value === null || value === "") return null;
  return nonEmpty(value, label, maximum);
}

function named(value, label) {
  const normalized = nonEmpty(value, label, 160);
  if (!NAME.test(normalized) || normalized.includes("//") || normalized.endsWith("/")) {
    throw new TypeError(`${label} must be a portable name`);
  }
  return normalized;
}

function normalizeAlias(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = nonEmpty(value, "asset alias", 256).toLowerCase();
  if (!ALIAS.test(normalized)) {
    throw new TypeError("asset alias must contain lowercase portable path segments");
  }
  return normalized;
}

function normalizeId(value) {
  const id = nonEmpty(value, "asset ID", 80);
  if (!id.startsWith("gw.asset/") || !UUID.test(id.slice("gw.asset/".length))) {
    throw new TypeError("asset ID must be gw.asset/<uuid>");
  }
  return `gw.asset/${id.slice("gw.asset/".length).toLowerCase()}`;
}

function assetToken(id) {
  return normalizeId(id).slice("gw.asset/".length);
}

function normalizeDigest(value, label = "SHA-256 digest") {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const normalized = value.toLowerCase().replace(/^sha256:/, "");
  if (!DIGEST.test(normalized)) throw new TypeError(`${label} is invalid`);
  return normalized;
}

function normalizeStringList(value, label, normalizer) {
  const input = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
  return [...new Set(input.map((entry, index) => normalizer(entry, `${label}[${index}]`)))].sort();
}

function normalizeDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError(`${label} must return a valid Date`);
  return value.toISOString();
}

function state(value) {
  const normalized = nonEmpty(value, "asset state", 40).toLowerCase();
  if (!ASSET_STATE_RANK.has(normalized)) throw new TypeError(`asset state must be one of ${ASSET_STATES.join(", ")}`);
  return normalized;
}

function generatedTitle(path) {
  const name = basename(path, extname(path)).replace(/[-_]+/g, " ").trim();
  return name || "Untitled image";
}

function manifest(record) {
  const source = {
    "source/kind": record.source.kind,
    "source/provider": record.source.provider,
    "source/generation-id": record.source.generationId,
    "source/file-name": record.source.fileName,
    "source/prompt-sha256": record.source.promptSha256,
  };
  const lineage = record.lineage ? {
    "lineage/parent": record.lineage.parent,
    "lineage/operation": record.lineage.operation,
    "lineage/instruction": record.lineage.instruction,
  } : null;
  const workflow = record.workflow ? {
    "workflow/from": record.workflow.from,
    "workflow/to": record.workflow.to,
    "workflow/note": record.workflow.note,
  } : null;
  return {
    "asset/protocol": record.protocol,
    "asset/id": record.id,
    "asset/revision": record.revision,
    "asset/kind": record.kind,
    "asset/title": record.title,
    "asset/state": record.state,
    "asset/created-at": record.createdAt,
    "asset/updated-at": record.updatedAt,
    "asset/project": record.project,
    "asset/collections": record.collections,
    "asset/aliases": record.aliases,
    "asset/tags": record.tags,
    "asset/content": {
      "content/sha256": record.content.sha256,
      "content/mime": record.content.mime,
      "content/bytes": record.content.bytes,
      "content/width": record.content.width,
      "content/height": record.content.height,
      "content/object-key": record.content.objectKey,
    },
    "asset/source": source,
    "asset/lineage": lineage,
    "asset/workflow": workflow,
  };
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function writeExclusive(path, source) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx", 0o644);
  try {
    await handle.writeFile(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path, source) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeExclusive(temporary, source);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function validateRecord(value) {
  const record = plainObject(value, "asset record");
  if (record.protocol !== ASSET_PROTOCOL) throw new Error(`asset protocol must be ${ASSET_PROTOCOL}`);
  normalizeId(record.id);
  if (!Number.isSafeInteger(record.revision) || record.revision <= 0) throw new Error("asset revision is invalid");
  if (record.kind !== "image") throw new Error("asset kind must be image");
  nonEmpty(record.title, "asset title", 240);
  state(record.state);
  if (!Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error("asset timestamps are invalid");
  }
  named(record.project, "asset project");
  normalizeStringList(record.collections, "asset collections", named);
  normalizeStringList(record.aliases, "asset aliases", (entry) => normalizeAlias(entry));
  normalizeStringList(record.tags, "asset tags", (entry, label) => named(entry, label).toLowerCase());
  const content = plainObject(record.content, "asset content");
  normalizeDigest(content.sha256);
  nonEmpty(content.mime, "asset MIME type", 100);
  if (!Number.isSafeInteger(content.bytes) || content.bytes <= 0) throw new Error("asset byte length is invalid");
  if (!Number.isSafeInteger(content.width) || content.width <= 0) throw new Error("asset width is invalid");
  if (!Number.isSafeInteger(content.height) || content.height <= 0) throw new Error("asset height is invalid");
  nonEmpty(content.objectKey, "asset object key", 300);
  plainObject(record.source, "asset source");
  return record;
}

export class AssetRegistry {
  constructor(root, {
    objectStore = null,
    now = () => new Date(),
    idFactory = () => randomUUID(),
    maxBytes = DEFAULT_MAX_BYTES,
  } = {}) {
    this.root = resolve(root);
    this.objectStore = objectStore ?? new FileObjectStore(this.root);
    if (typeof now !== "function") throw new TypeError("asset registry requires a clock");
    if (typeof idFactory !== "function") throw new TypeError("asset registry requires an ID factory");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("asset registry maxBytes must be positive");
    this.now = now;
    this.idFactory = idFactory;
    this.maxBytes = maxBytes;
  }

  async init() {
    await Promise.all([
      "objects/sha256",
      "heads",
      "records",
      "manifests",
      "indexes/sha256",
      "aliases",
      "locks",
    ].map((path) => mkdir(join(this.root, ...path.split("/")), { recursive: true })));
    return { root: this.root, protocol: ASSET_PROTOCOL };
  }

  headPath(id) {
    return join(this.root, "heads", `${assetToken(id)}.json`);
  }

  recordPath(id, revision) {
    return join(this.root, "records", assetToken(id), `${String(revision).padStart(8, "0")}.json`);
  }

  manifestPath(id, revision) {
    return join(this.root, "manifests", assetToken(id), `${String(revision).padStart(8, "0")}.hal`);
  }

  digestIndexPath(digest) {
    const value = normalizeDigest(digest);
    return join(this.root, "indexes", "sha256", value.slice(0, 2), `${value}.json`);
  }

  aliasPath(aliasValue) {
    const alias = normalizeAlias(aliasValue);
    if (!alias) throw new TypeError("asset alias is required");
    const segments = alias.split("/");
    return join(this.root, "aliases", ...segments.slice(0, -1), `${segments.at(-1)}.json`);
  }

  async withMutationLock(operation) {
    await mkdir(join(this.root, "locks"), { recursive: true });
    const path = join(this.root, "locks", "registry.lock");
    const started = Date.now();
    let handle;
    while (!handle) {
      try {
        handle = await open(path, "wx", 0o600);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const information = await stat(path);
          if (Date.now() - information.mtimeMs > LOCK_STALE_MS) {
            await unlink(path);
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - started > LOCK_WAIT_MS) throw new Error("asset registry is busy");
        await sleep(25);
      }
    }
    try {
      await handle.writeFile(canonicalJson({ pid: process.pid, createdAt: new Date().toISOString() }));
      await handle.sync();
      return await operation();
    } finally {
      await handle.close();
      await rm(path, { force: true });
    }
  }

  async writeRevision(recordValue) {
    const record = validateRecord(recordValue);
    const recordPath = this.recordPath(record.id, record.revision);
    const manifestPath = this.manifestPath(record.id, record.revision);
    await writeExclusive(recordPath, canonicalJson(record));
    try {
      await writeExclusive(manifestPath, `${encodeEdn(manifest(record))}\n`);
    } catch (error) {
      await rm(recordPath, { force: true });
      throw error;
    }
    await writeAtomic(this.headPath(record.id), canonicalJson({
      protocol: "greenways-asset-head/0-alpha",
      assetId: record.id,
      revision: record.revision,
      record: `records/${assetToken(record.id)}/${String(record.revision).padStart(8, "0")}.json`,
      manifest: `manifests/${assetToken(record.id)}/${String(record.revision).padStart(8, "0")}.hal`,
    }));
    return record;
  }

  async resolveId(value) {
    if (typeof value === "string" && value.startsWith("gw.asset/")) return normalizeId(value);
    const alias = normalizeAlias(value);
    if (!alias) throw new TypeError("asset reference must be an ID or alias");
    const pointer = await readJson(this.aliasPath(alias), `asset alias ${alias}`);
    if (!pointer) throw new Error(`asset alias not found: ${alias}`);
    if (pointer.protocol !== "greenways-asset-alias/0-alpha" || pointer.alias !== alias) {
      throw new Error(`asset alias record is invalid: ${alias}`);
    }
    return normalizeId(pointer.assetId);
  }

  async read(reference) {
    const id = await this.resolveId(reference);
    const head = await readJson(this.headPath(id), `asset head ${id}`);
    if (!head) throw new Error(`asset not found: ${id}`);
    if (head.protocol !== "greenways-asset-head/0-alpha" || head.assetId !== id || !Number.isSafeInteger(head.revision)) {
      throw new Error(`asset head is invalid: ${id}`);
    }
    const record = await readJson(this.recordPath(id, head.revision), `asset record ${id}@${head.revision}`);
    if (!record) throw new Error(`asset record is missing: ${id}@${head.revision}`);
    validateRecord(record);
    if (record.id !== id || record.revision !== head.revision) throw new Error(`asset head does not match its record: ${id}`);
    return record;
  }

  async findByDigest(digest) {
    const value = normalizeDigest(digest);
    const index = await readJson(this.digestIndexPath(value), `asset SHA-256 index ${value}`);
    if (!index) return null;
    if (index.protocol !== "greenways-asset-sha256-index/0-alpha" || index.sha256 !== value) {
      throw new Error(`asset SHA-256 index is invalid: ${value}`);
    }
    const record = await this.read(index.assetId);
    if (record.content.sha256 !== value) throw new Error(`asset SHA-256 index points to different content: ${value}`);
    return record;
  }

  async importFile(path, metadata = {}) {
    const options = plainObject(metadata, "asset import metadata");
    await this.init();
    const file = resolve(path);
    const information = await stat(file);
    if (!information.isFile()) throw new Error("asset import source must be a file");
    if (information.size <= 0) throw new Error("asset import source is empty");
    if (information.size > this.maxBytes) throw new Error(`asset import exceeds ${this.maxBytes} bytes`);
    const bytes = await readFile(file);
    const image = inspectImage(bytes);
    const digest = sha256(bytes);

    return this.withMutationLock(async () => {
      const duplicate = await this.findByDigest(digest);
      if (duplicate) return { created: false, duplicate: true, asset: duplicate };

      const aliases = options.alias ? [normalizeAlias(options.alias)] : [];
      for (const alias of aliases) {
        const existing = await readJson(this.aliasPath(alias), `asset alias ${alias}`);
        if (existing) throw new Error(`asset alias is already assigned: ${alias}`);
      }

      const parent = options.parent ? normalizeId(options.parent) : null;
      if (parent) await this.read(parent);
      const createdAt = normalizeDate(this.now(), "asset registry clock");
      const id = normalizeId(`gw.asset/${nonEmpty(this.idFactory(), "generated asset UUID", 60)}`);
      const object = await this.objectStore.put({ digest, extension: image.extension, bytes });
      const collections = normalizeStringList(options.collections ?? options.collection, "asset collections", named);
      const tags = normalizeStringList(options.tags ?? options.tag, "asset tags", (entry, label) => named(entry, label).toLowerCase());
      const promptSha256 = options.promptSha256 ? normalizeDigest(options.promptSha256, "prompt SHA-256") : null;
      const record = {
        protocol: ASSET_PROTOCOL,
        id,
        revision: 1,
        kind: "image",
        title: optionalText(options.title, "asset title", 240) ?? generatedTitle(file),
        state: "inbox",
        createdAt,
        updatedAt: createdAt,
        project: named(options.project ?? "personal", "asset project"),
        collections,
        aliases,
        tags,
        content: {
          sha256: digest,
          mime: image.mime,
          bytes: bytes.byteLength,
          width: image.width,
          height: image.height,
          objectKey: object.key,
        },
        source: {
          kind: named(options.sourceKind ?? "file-import", "asset source kind"),
          provider: optionalText(options.provider, "asset provider", 160),
          generationId: optionalText(options.generationId, "asset generation ID", 300),
          fileName: basename(file),
          promptSha256,
        },
        lineage: parent ? {
          parent,
          operation: named(options.operation ?? "image/edit", "asset lineage operation"),
          instruction: optionalText(options.instruction, "asset lineage instruction", 2000),
        } : null,
        workflow: {
          from: null,
          to: "inbox",
          note: "Imported immutable source object",
        },
      };
      await this.writeRevision(record);
      await writeExclusive(this.digestIndexPath(digest), canonicalJson({
        protocol: "greenways-asset-sha256-index/0-alpha",
        sha256: digest,
        assetId: id,
      }));
      for (const alias of aliases) {
        await writeExclusive(this.aliasPath(alias), canonicalJson({
          protocol: "greenways-asset-alias/0-alpha",
          alias,
          assetId: id,
          assignedAt: createdAt,
        }));
      }
      return { created: true, duplicate: false, asset: record };
    });
  }

  async transition(reference, nextStateValue, { note = null } = {}) {
    await this.init();
    const nextState = state(nextStateValue);
    return this.withMutationLock(async () => {
      const current = await this.read(reference);
      if (current.state === nextState) return current;
      if (current.state === "deprecated") throw new Error("deprecated assets cannot transition");
      const currentRank = ASSET_STATE_RANK.get(current.state);
      const nextRank = ASSET_STATE_RANK.get(nextState);
      if (nextState !== "deprecated" && nextRank <= currentRank) {
        throw new Error(`asset state cannot move backwards from ${current.state} to ${nextState}`);
      }
      const updatedAt = normalizeDate(this.now(), "asset registry clock");
      const record = {
        ...current,
        revision: current.revision + 1,
        state: nextState,
        updatedAt,
        workflow: {
          from: current.state,
          to: nextState,
          note: optionalText(note, "asset transition note", 1000),
        },
      };
      return this.writeRevision(record);
    });
  }

  async history(reference) {
    const id = await this.resolveId(reference);
    const directory = join(this.root, "records", assetToken(id));
    let names;
    try {
      names = await readdir(directory);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error(`asset not found: ${id}`);
      throw error;
    }
    const records = [];
    for (const name of names.filter((entry) => /^\d{8}\.json$/.test(entry)).sort()) {
      const record = await readJson(join(directory, name), `asset history ${id}/${name}`);
      records.push(validateRecord(record));
    }
    return records;
  }

  async list({ state: stateFilter = null, project = null, collection = null } = {}) {
    await this.init();
    const normalizedState = stateFilter ? state(stateFilter) : null;
    const normalizedProject = project ? named(project, "asset project filter") : null;
    const normalizedCollection = collection ? named(collection, "asset collection filter") : null;
    const names = await readdir(join(this.root, "heads"));
    const records = [];
    for (const name of names.filter((entry) => UUID.test(entry.replace(/\.json$/, ""))).sort()) {
      const id = `gw.asset/${name.replace(/\.json$/, "")}`;
      const record = await this.read(id);
      if (normalizedState && record.state !== normalizedState) continue;
      if (normalizedProject && record.project !== normalizedProject) continue;
      if (normalizedCollection && !record.collections.includes(normalizedCollection)) continue;
      records.push(record);
    }
    records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
    return records;
  }

  async verify(reference) {
    const record = await this.read(reference);
    const result = await this.objectStore.verify({
      key: record.content.objectKey,
      digest: record.content.sha256,
      bytes: record.content.bytes,
    });
    const bytes = await this.objectStore.read(record.content.objectKey);
    const image = inspectImage(bytes);
    for (const field of ["mime", "width", "height"]) {
      if (image[field] !== record.content[field]) throw new Error(`asset ${field} metadata mismatch: ${record.id}`);
    }
    return {
      assetId: record.id,
      revision: record.revision,
      state: record.state,
      ...result,
      mime: image.mime,
      width: image.width,
      height: image.height,
    };
  }
}
