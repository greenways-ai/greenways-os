import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const DIGEST = /^[0-9a-f]{64}$/;
const EXTENSION = /^[a-z0-9]{1,10}$/;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateDigest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new TypeError("SHA-256 digest is invalid");
  return value;
}

function validateExtension(value) {
  if (typeof value !== "string" || !EXTENSION.test(value)) throw new TypeError("Object extension is invalid");
  return value;
}

export class FileObjectStore {
  constructor(root) {
    this.root = resolve(root);
  }

  key(digestValue, extensionValue) {
    const digest = validateDigest(digestValue);
    const extension = validateExtension(extensionValue);
    return `objects/sha256/${digest.slice(0, 2)}/${digest}.${extension}`;
  }

  path(key) {
    if (typeof key !== "string" || !/^objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.[a-z0-9]{1,10}$/.test(key)) {
      throw new TypeError("Object key is invalid");
    }
    return join(this.root, ...key.split("/"));
  }

  async put({ digest, extension, bytes }) {
    const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (sha256(value) !== validateDigest(digest)) throw new Error("Object bytes do not match their SHA-256 digest");
    const key = this.key(digest, extension);
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    try {
      const handle = await open(target, "wx", 0o644);
      try {
        await handle.writeFile(value);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { key, created: true, bytes: value.byteLength };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(target);
      if (sha256(existing) !== digest) throw new Error(`Content-addressed object is corrupt: ${key}`);
      return { key, created: false, bytes: existing.byteLength };
    }
  }

  async read(key) {
    return readFile(this.path(key));
  }

  async verify({ key, digest, bytes }) {
    const target = this.path(key);
    const info = await stat(target);
    if (!info.isFile()) throw new Error(`Asset object is not a file: ${key}`);
    if (Number.isSafeInteger(bytes) && info.size !== bytes) throw new Error(`Asset object size mismatch: ${key}`);
    const value = await readFile(target);
    if (sha256(value) !== validateDigest(digest)) throw new Error(`Asset object digest mismatch: ${key}`);
    return { key, digest, bytes: value.byteLength };
  }
}
