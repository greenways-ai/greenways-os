import assert from "node:assert/strict";
import test from "node:test";
import {
  MODULE_RECORD_PROTOCOL,
  createModuleRecord,
  moduleArchiveRequest,
  stageModuleRecord,
  validateModuleRecord,
} from "../src/module-record.js";

const LOCK = `sha256:${"a".repeat(64)}`;
const ARCHIVE = new Uint8Array([1, 2, 3, 4]);

function manifest(overrides = {}) {
  return {
    protocol: "greenways-app/1",
    id: "notes",
    version: "1.0.0",
    publisher: { id: "greenways-ai", name: "Greenways AI" },
    name: "Notes",
    description: "A bounded notes module.",
    category: "installable",
    capabilities: ["hara/module", "storage/local"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "release",
    lockDigest: LOCK,
    source: {
      kind: "registry",
      registry: "https://packages.greenways.ai/",
      coordinate: "greenways:notes",
    },
    ...overrides,
  };
}

function bundle(overrides = {}) {
  return {
    lockSource: "{:lock/format 2 :packages {}}",
    lockDigest: LOCK,
    entry: "notes.app/view",
    resources: { "notes.app": "(ns notes.app)" },
    packages: {
      "greenways:notes": {
        url: "https://packages.greenways.ai/v1/packages/notes/1.0.0.harp",
        digest: `sha256:${"b".repeat(64)}`,
        size: ARCHIVE.byteLength,
        archive: ARCHIVE,
      },
    },
    ...overrides,
  };
}

test("creates an exact persistent record from a verified bundle", () => {
  const record = createModuleRecord(manifest(), bundle(), {
    now: () => new Date("2026-08-06T00:00:00.000Z"),
  });
  assert.equal(record.protocol, MODULE_RECORD_PROTOCOL);
  assert.equal(record.id, "notes");
  assert.equal(record.lockDigest, LOCK);
  assert.equal(record.entry, "notes.app/view");
  assert.deepEqual([...record.packages["greenways:notes"].archive], [...ARCHIVE]);
  assert.notEqual(record.packages["greenways:notes"].archive, ARCHIVE);
});

test("binds record id and digest to the approved manifest", () => {
  const record = createModuleRecord(manifest(), bundle());
  assert.throws(() => validateModuleRecord({ ...record, id: "other" }), /id does not match/);
  assert.throws(
    () => validateModuleRecord({ ...record, lockDigest: `sha256:${"c".repeat(64)}` }),
    /lock digest does not match/,
  );
  assert.throws(
    () => validateModuleRecord({ ...record, packages: {
      ...record.packages,
      copy: { ...record.packages["greenways:notes"], coordinate: "copy" },
    } }),
    /duplicate archive URL/,
  );
});

test("serves only exact persisted archive URLs during boot verification", async () => {
  const record = createModuleRecord(manifest(), bundle());
  const request = moduleArchiveRequest(record);
  assert.equal((await request("https://missing.invalid/x")).status, 404);
  const response = await request(record.packages["greenways:notes"].url);
  assert.equal(response.ok, true);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...ARCHIVE]);
});

test("re-verifies archive evidence before returning staged HAL source", async () => {
  const record = createModuleRecord(manifest(), bundle());
  const seen = [];
  const staged = await stageModuleRecord(record, {
    async loadBundle(lockSource, request) {
      seen.push(lockSource);
      const response = await request(record.packages["greenways:notes"].url);
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...ARCHIVE]);
      return bundle();
    },
    appEntry: (value) => value.entry,
  });
  assert.deepEqual(seen, [record.lockSource]);
  assert.deepEqual(staged.resources, { "notes.app": "(ns notes.app)" });
  assert.equal(staged.id, "notes");
});

test("fails boot staging when lock, entry, or package evidence changes", async () => {
  const record = createModuleRecord(manifest(), bundle());
  const appEntry = (value) => value.entry;
  await assert.rejects(
    stageModuleRecord(record, { loadBundle: async () => bundle({ lockDigest: `sha256:${"c".repeat(64)}` }), appEntry }),
    /lock digest/,
  );
  await assert.rejects(
    stageModuleRecord(record, { loadBundle: async () => bundle({ entry: "notes.app/other" }), appEntry }),
    /entry/,
  );
  await assert.rejects(
    stageModuleRecord(record, { loadBundle: async () => bundle({ packages: {
      "greenways:notes": { ...bundle().packages["greenways:notes"], size: 5 },
    } }), appEntry }),
    /package evidence/,
  );
});
