import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileObjectStore, sha256 } from "../src/file-object-store.js";
import {
  encodeGitLfsPointer,
  gitLfs,
  parseGitLfsPointer,
  requireHydratedGitLfsObject,
} from "../src/git-lfs.js";

const DIGEST = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

test("encodes the canonical Git LFS v1 pointer from registry identity", () => {
  const pointer = encodeGitLfsPointer({ digest: DIGEST, size: 2447383 });
  assert.equal(pointer,
    "version https://git-lfs.github.com/spec/v1\n"
    + `oid sha256:${DIGEST}\n`
    + "size 2447383\n");
  assert.deepEqual(parseGitLfsPointer(pointer), {
    version: "https://git-lfs.github.com/spec/v1",
    oid: `sha256:${DIGEST}`,
    digest: DIGEST,
    size: 2447383,
    extensions: [],
  });
});

test("recognises valid extension lines without changing the content oid", () => {
  const pointer = Buffer.from(
    "version https://git-lfs.github.com/spec/v1\n"
    + "ext-0-c2pa sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
    + `oid sha256:${DIGEST}\n`
    + "size 12\n",
  );
  const parsed = parseGitLfsPointer(pointer);
  assert.equal(parsed.digest, DIGEST);
  assert.equal(parsed.size, 12);
  assert.deepEqual(parsed.extensions, [
    "ext-0-c2pa sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ]);
});

test("rejects malformed Git LFS pointers and passes ordinary bytes through", () => {
  assert.equal(parseGitLfsPointer(Buffer.from("ordinary image bytes")), null);
  assert.throws(
    () => parseGitLfsPointer(Buffer.from("version https://git-lfs.github.com/spec/v1\nsize 1\n")),
    /missing its oid or size/,
  );
  const ordinary = Buffer.from("ordinary image bytes");
  assert.equal(requireHydratedGitLfsObject(ordinary), ordinary);
});

test("reports a useful error when a checked-out asset is still an LFS pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "greenways-assets-lfs-"));
  const store = new FileObjectStore(root);
  const bytes = Buffer.from("exact immutable asset bytes");
  const digest = sha256(bytes);
  const object = await store.put({ digest, extension: "png", bytes });
  await writeFile(store.path(object.key), encodeGitLfsPointer({ digest, size: bytes.byteLength }));

  await assert.rejects(
    () => store.read(object.key),
    /Git LFS object is not hydrated.*git lfs pull/,
  );
  await assert.rejects(
    () => store.verify({ key: object.key, digest, bytes: bytes.byteLength }),
    /Git LFS object is not hydrated/,
  );
});

test("publishes the catalogue tracking rule", () => {
  assert.equal(gitLfs.attributes, "objects/** filter=lfs diff=lfs merge=lfs -text\n");
  assert.equal(gitLfs.pointerMaxBytes, 1024);
});
