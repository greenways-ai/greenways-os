import assert from "node:assert/strict";
import test from "node:test";
import {
  databaseTransaction,
  deleteStoreEntries,
  putSignedRecordStores,
  replaceStoreEntries,
  withOriginLock,
} from "../src/storage.js";

function successfulRequest(result) {
  return {
    result,
    set onsuccess(handler) { queueMicrotask(handler); },
    set onerror(_handler) {},
  };
}

test("replaces an installed-app snapshot through one object-store transaction", async () => {
  const calls = [];
  const target = {
    clear() {
      calls.push(["clear"]);
      return successfulRequest(undefined);
    },
    put(value, key) {
      calls.push(["put", key, value.id]);
      return successfulRequest(key);
    },
  };

  await replaceStoreEntries(target, [
    ["greenways-home", { id: "greenways-home" }],
    ["historia", { id: "historia" }],
  ]);

  assert.deepEqual(calls, [
    ["clear"],
    ["put", "greenways-home", "greenways-home"],
    ["put", "historia", "historia"],
  ]);
});

test("rejects malformed replacement snapshots before touching storage", () => {
  const target = {
    clear() { throw new Error("must not run"); },
  };
  assert.throws(() => replaceStoreEntries(target, null), /must be an array/);
});

test("deletes an acknowledged outbox batch through one object-store transaction", async () => {
  const calls = [];
  const target = {
    delete(key) {
      calls.push(key);
      return successfulRequest(undefined);
    },
  };
  await deleteStoreEntries(target, ["sha256:first", "sha256:second"]);
  assert.deepEqual(calls, ["sha256:first", "sha256:second"]);
});

test("aborts a transaction when an operation fails after queuing a write", async () => {
  const originalIndexedDB = globalThis.indexedDB;
  let aborted = false;
  const tx = {
    error: null,
    objectStore() {
      return { put() {} };
    },
    abort() {
      aborted = true;
      queueMicrotask(() => this.onabort?.());
    },
  };
  const database = {
    transaction() { return tx; },
    close() {},
  };
  globalThis.indexedDB = {
    open() {
      return {
        result: database,
        set onupgradeneeded(_handler) {},
        set onsuccess(handler) { queueMicrotask(handler); },
        set onerror(_handler) {},
      };
    },
  };

  try {
    await assert.rejects(
      databaseTransaction("apps", "readwrite", (transaction) => {
        transaction.objectStore("apps").put({ id: "historia" }, "historia");
        throw new Error("snapshot validation failed");
      }),
      /snapshot validation failed/,
    );
    assert.equal(aborted, true);
  } finally {
    if (originalIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = originalIndexedDB;
  }
});

test("writes an action, inclusion, and outbox item through one transaction", async () => {
  const calls = [];
  const tx = {
    objectStore(name) {
      return {
        put(value, key) {
          calls.push([name, key, value]);
          return successfulRequest(key);
        },
      };
    },
  };
  const action = { id: "action:1", root: "sha256:action" };
  const inclusion = { eventHash: "sha256:inclusion" };

  await putSignedRecordStores(tx, action, inclusion);

  assert.deepEqual(calls, [
    ["actions", "action:1", action],
    ["inclusions", "sha256:inclusion", inclusion],
    ["outbox", "sha256:action", action],
  ]);
});

test("coordinates shared state through an origin-wide exclusive lock", async () => {
  const calls = [];
  const locks = {
    request(name, options, operation) {
      calls.push([name, options]);
      return operation();
    },
  };
  const value = await withOriginLock("personal-chain", async () => "advanced", locks);
  assert.equal(value, "advanced");
  assert.deepEqual(calls, [["greenways-os:personal-chain", { mode: "exclusive" }]]);
});
