const GIT_LFS_SPEC = "https://git-lfs.github.com/spec/v1";
const POINTER_MAX_BYTES = 1024;
const DIGEST = /^[0-9a-f]{64}$/;
const EXTENSION = /^ext-[0-9]+-[A-Za-z0-9][A-Za-z0-9._-]* [A-Za-z0-9][A-Za-z0-9._-]*:[^\r\n]+$/;

function normalizeDigest(value) {
  if (typeof value !== "string") throw new TypeError("Git LFS SHA-256 digest is invalid");
  const normalized = value.toLowerCase().replace(/^sha256:/, "");
  if (!DIGEST.test(normalized)) throw new TypeError("Git LFS SHA-256 digest is invalid");
  return normalized;
}

function normalizeSize(value) {
  const size = typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError("Git LFS object size is invalid");
  return size;
}

export function encodeGitLfsPointer({ digest, size }) {
  const oid = normalizeDigest(digest);
  const bytes = normalizeSize(size);
  return `version ${GIT_LFS_SPEC}\noid sha256:${oid}\nsize ${bytes}\n`;
}

export function parseGitLfsPointer(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length === 0 || bytes.length > POINTER_MAX_BYTES || bytes.includes(0)) return null;
  const source = bytes.toString("utf8").replace(/\r\n/g, "\n");
  const lines = source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
  if (lines[0] !== `version ${GIT_LFS_SPEC}`) return null;

  let digest = null;
  let size = null;
  const extensions = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("oid ")) {
      if (digest !== null) throw new Error("Git LFS pointer contains more than one oid");
      const match = /^oid sha256:([0-9a-f]{64})$/.exec(line);
      if (!match) throw new Error("Git LFS pointer oid is invalid");
      digest = match[1];
      continue;
    }
    if (line.startsWith("size ")) {
      if (size !== null) throw new Error("Git LFS pointer contains more than one size");
      const match = /^size ([0-9]+)$/.exec(line);
      if (!match) throw new Error("Git LFS pointer size is invalid");
      size = normalizeSize(match[1]);
      continue;
    }
    if (EXTENSION.test(line)) {
      extensions.push(line);
      continue;
    }
    throw new Error(`Git LFS pointer line is invalid: ${JSON.stringify(line)}`);
  }
  if (digest === null || size === null) throw new Error("Git LFS pointer is missing its oid or size");
  return {
    version: GIT_LFS_SPEC,
    oid: `sha256:${digest}`,
    digest,
    size,
    extensions,
  };
}

export function requireHydratedGitLfsObject(input, {
  key = "asset object",
  digest = null,
  size = null,
} = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const pointer = parseGitLfsPointer(bytes);
  if (!pointer) return bytes;
  if (digest !== null && pointer.digest !== normalizeDigest(digest)) {
    throw new Error(`Git LFS pointer digest mismatch: ${key}`);
  }
  if (size !== null && pointer.size !== normalizeSize(size)) {
    throw new Error(`Git LFS pointer size mismatch: ${key}`);
  }
  throw new Error(
    `Git LFS object is not hydrated: ${key}. Run \"git lfs pull\" or \"git lfs checkout\" in the asset catalogue.`,
  );
}

export const gitLfs = Object.freeze({
  spec: GIT_LFS_SPEC,
  pointerMaxBytes: POINTER_MAX_BYTES,
  attributes: "objects/** filter=lfs diff=lfs merge=lfs -text\n",
});
