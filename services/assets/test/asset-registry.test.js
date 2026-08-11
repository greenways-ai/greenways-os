import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssetRegistry } from "../src/asset-registry.js";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

function pngHeader(width, height, marker = 0) {
  const bytes = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = marker;
  return bytes;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "greenways-assets-test-"));
  const source = join(root, "source.png");
  await writeFile(source, pngHeader(1122, 1402, 1));
  let clock = 0;
  let id = 0;
  const registry = new AssetRegistry(join(root, "registry"), {
    now: () => new Date(Date.UTC(2026, 7, 11, 4, 0, clock++)),
    idFactory: () => IDS[id++],
  });
  return { root, source, registry };
}

test("imports an immutable content-addressed image and writes HAL lineage metadata", async () => {
  const { source, registry } = await fixture();
  const result = await registry.importFile(source, {
    title: "Compact peacock mosaic flower",
    project: "greenways.visual-language",
    collection: "flowers",
    alias: "visual-language/hodos/peacock-rosette",
    tag: ["hodos", "peacock", "mosaic"],
    provider: "openai-image",
    generationId: "generation-123",
    promptSha256: "a".repeat(64),
  });

  assert.equal(result.created, true);
  assert.equal(result.asset.id, `gw.asset/${IDS[0]}`);
  assert.equal(result.asset.state, "inbox");
  assert.deepEqual(result.asset.content, {
    sha256: result.asset.content.sha256,
    mime: "image/png",
    bytes: 25,
    width: 1122,
    height: 1402,
    objectKey: `objects/sha256/${result.asset.content.sha256.slice(0, 2)}/${result.asset.content.sha256}.png`,
  });

  const objectBytes = await readFile(join(registry.root, ...result.asset.content.objectKey.split("/")));
  assert.deepEqual(objectBytes, pngHeader(1122, 1402, 1));

  const manifest = await readFile(registry.manifestPath(result.asset.id, 1), "utf8");
  assert.match(manifest, /:asset\/protocol "greenways-asset\/0-alpha"/);
  assert.match(manifest, /:asset\/aliases \["visual-language\/hodos\/peacock-rosette"\]/);
  assert.match(manifest, /:source\/prompt-sha256 "aaaaaaaa/);
  assert.doesNotMatch(manifest, /prompt\s+text/i);

  const byAlias = await registry.read("visual-language/hodos/peacock-rosette");
  assert.equal(byAlias.id, result.asset.id);
  assert.deepEqual(byAlias.collections, ["flowers"]);
  assert.deepEqual(byAlias.tags, ["hodos", "mosaic", "peacock"]);
});

test("deduplicates exact bytes without creating a second logical asset", async () => {
  const { source, registry } = await fixture();
  const first = await registry.importFile(source, { title: "First" });
  const second = await registry.importFile(source, { title: "Duplicate metadata is ignored" });
  assert.equal(second.created, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.asset.id, first.asset.id);
  assert.equal(second.asset.title, "First");
  assert.deepEqual(await readdir(join(registry.root, "heads")), [`${IDS[0]}.json`]);
});

test("tracks immutable lifecycle revisions and rejects backwards movement", async () => {
  const { source, registry } = await fixture();
  const imported = await registry.importFile(source, { alias: "flowers/peacock" });
  const approved = await registry.transition(imported.asset.id, "approved", { note: "Selected for Hodos" });
  const published = await registry.transition("flowers/peacock", "published", { note: "Public rendition ready" });

  assert.equal(approved.revision, 2);
  assert.equal(approved.workflow.from, "inbox");
  assert.equal(published.revision, 3);
  assert.equal(published.state, "published");
  assert.deepEqual((await registry.history(imported.asset.id)).map((entry) => entry.state), [
    "inbox",
    "approved",
    "published",
  ]);
  await assert.rejects(() => registry.transition(imported.asset.id, "curated"), /cannot move backwards/);
});

test("records parent lineage for a distinct edit", async () => {
  const { root, source, registry } = await fixture();
  const parent = await registry.importFile(source, { title: "Tall peacock" });
  const editPath = join(root, "compact.png");
  await writeFile(editPath, pngHeader(1122, 900, 2));
  const edit = await registry.importFile(editPath, {
    title: "Compact peacock",
    parent: parent.asset.id,
    operation: "image/edit",
    instruction: "Shorten vertically and use fewer leaves",
  });
  assert.deepEqual(edit.asset.lineage, {
    parent: parent.asset.id,
    operation: "image/edit",
    instruction: "Shorten vertically and use fewer leaves",
  });
});

test("verifies exact object bytes and detects corruption", async () => {
  const { source, registry } = await fixture();
  const imported = await registry.importFile(source);
  const verified = await registry.verify(imported.asset.id);
  assert.equal(verified.assetId, imported.asset.id);
  assert.equal(verified.width, 1122);

  await writeFile(join(registry.root, ...imported.asset.content.objectKey.split("/")), Buffer.from("corrupt"));
  await assert.rejects(() => registry.verify(imported.asset.id), /size mismatch|digest mismatch/);
});

test("does not allow two assets to claim the same alias", async () => {
  const { root, source, registry } = await fixture();
  await registry.importFile(source, { alias: "flowers/selected" });
  const other = join(root, "other.png");
  await writeFile(other, pngHeader(640, 480, 9));
  await assert.rejects(() => registry.importFile(other, { alias: "flowers/selected" }), /already assigned/);
});
