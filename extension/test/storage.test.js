import assert from "node:assert/strict";
import test from "node:test";
import {
  DATABASE_STORES,
  DATABASE_VERSION,
  KERNEL_GLOBAL_KEY,
  abortKernelRequest,
  capabilityStore,
  commitKernelStores,
  commitKernelTransition,
  databaseTransaction,
  deleteStoreEntries,
  getKernelRequest,
  getKernelSnapshot,
  kernelContextKey,
  kernelRequestKey,
  moduleStore,
  prepareKernelRequest,
  putSignedRecordStores,
  readKernelSnapshot,
  replaceKernelGlobal,
  replaceKernelGlobalStores,
  replacePersonalChainStores,
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

function recordingStores(initial = new Map()) {
  const calls = [];
  const values = new Map(initial);
  const target = (name) => ({
    clear() {
      calls.push([name, "clear"]);
      for (const key of [...values.keys()]) {
        if (key.startsWith(`${name}:`)) values.delete(key);
      }
      return successfulRequest(undefined);
    },
    put(value, key) {
      calls.push([name, "put", key, value]);
      values.set(`${name}:${key}`, value);
      return successfulRequest(key);
    },
    delete(key) {
      calls.push([name, "delete", key]);
      values.delete(`${name}:${key}`);
      return successfulRequest(undefined);
    },
    get(key) {
      calls.push([name, "get", key]);
      return successfulRequest(values.get(`${name}:${key}`));
    },
  });
  const stores = new Map();
  const tx = {
    objectStore(name) {
      if (!stores.has(name)) stores.set(name, target(name));
      return stores.get(name);
    },
  };
  return { calls, values, tx };
}

test("database v8 adds durable foreground model sessions without removing existing stores", () => {
  assert.equal(DATABASE_VERSION, 8);
  assert.deepEqual(DATABASE_STORES, [
    "settings",
    "identity",
    "projects",
    "actions",
    "inclusions",
    "outbox",
    "apps",
    "modules",
    "grants",
    "kernel",
    "userscripts",
    "chats",
    "modelSessions",
    "fabric",
  ]);
});

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
  const action = {
    protocol: "greenways-action/1",
    id: "action:1",
    root: "sha256:action",
    signature: "signed-action",
  };
  const inclusion = {
    protocol: "greenways-personal-chain/1",
    chainId: "identity/alice",
    keyId: "sha256:alice-key",
    sequence: 1,
    previousHash: `sha256:${"0".repeat(64)}`,
    eventHash: "sha256:inclusion",
    actionRoot: action.root,
    signature: "signed-inclusion",
  };
  const syncEntry = {
    protocol: "greenways-sync-entry/1",
    action,
    inclusion,
  };

  await putSignedRecordStores(tx, action, inclusion);

  assert.deepEqual(calls, [
    ["actions", "action:1", action],
    ["inclusions", "sha256:inclusion", inclusion],
    ["outbox", "sha256:inclusion", syncEntry],
  ]);
});

test("rejects an outbox entry whose inclusion names another action", () => {
  const tx = {
    objectStore() {
      return { put: () => successfulRequest() };
    },
  };
  assert.throws(
    () => putSignedRecordStores(
      tx,
      {
        protocol: "greenways-action/1",
        id: "action:1",
        root: "sha256:action",
        signature: "signed-action",
      },
      {
        protocol: "greenways-personal-chain/1",
        chainId: "identity/alice",
        keyId: "sha256:alice-key",
        sequence: 1,
        previousHash: `sha256:${"0".repeat(64)}`,
        eventHash: "sha256:inclusion",
        actionRoot: "sha256:other",
        signature: "signed-inclusion",
      },
    ),
    /does not name its action/,
  );
});

test("atomically replaces a migrated identity, inclusions, and signed outbox", async () => {
  const { calls, values, tx } = recordingStores(new Map([
    ["inclusions:sha256:old", { eventHash: "sha256:old" }],
    ["outbox:sha256:old", { protocol: "legacy" }],
  ]));
  const identityRecord = {
    identity: { identityId: "identity/alice" },
    privateKey: { type: "private" },
  };
  const action = {
    protocol: "greenways-action/1",
    id: "action/one",
    root: "sha256:action",
    signature: "signed-action",
  };
  const inclusion = {
    protocol: "greenways-personal-chain/1",
    chainId: "identity/alice",
    keyId: "sha256:alice-key",
    sequence: 1,
    previousHash: `sha256:${"0".repeat(64)}`,
    eventHash: "sha256:inclusion",
    actionRoot: action.root,
    signature: "signed-inclusion",
  };
  const entry = { protocol: "greenways-sync-entry/1", action, inclusion };

  await replacePersonalChainStores(tx, {
    identityRecord,
    inclusions: [inclusion],
    outbox: [entry],
  });

  assert.deepEqual(calls, [
    ["identity", "put", "owner", identityRecord],
    ["inclusions", "clear"],
    ["inclusions", "put", inclusion.eventHash, inclusion],
    ["outbox", "clear"],
    ["outbox", "put", inclusion.eventHash, entry],
  ]);
  assert.equal(values.get("identity:owner"), identityRecord);
  assert.equal(values.get(`inclusions:${inclusion.eventHash}`), inclusion);
  assert.equal(values.get(`outbox:${inclusion.eventHash}`), entry);
  assert.equal(values.has("inclusions:sha256:old"), false);
  assert.equal(values.has("outbox:sha256:old"), false);
});

test("commits global and context envelopes, exact apps, and request acknowledgement atomically", async () => {
  const { calls, values, tx } = recordingStores(new Map([
    ["apps:removed-app", { id: "removed-app" }],
    ["kernel:request:req-1", { id: "req-1", status: "prepared" }],
  ]));
  const globalEnvelope = { protocol: "greenways-kernel-state/1", revision: 4, state: { apps: {} } };
  const contextEnvelope = { protocol: "greenways-kernel-context/1", revision: 2, state: { surface: null } };
  const apps = [{ id: "greenways-home" }, { id: "historia" }];

  await commitKernelStores(tx, {
    requestId: "req-1",
    contextId: "launcher:one",
    globalEnvelope,
    contextEnvelope,
    apps,
  });

  assert.deepEqual(calls, [
    ["kernel", "put", KERNEL_GLOBAL_KEY, globalEnvelope],
    ["kernel", "put", "context:launcher:one", contextEnvelope],
    ["apps", "clear"],
    ["apps", "put", "greenways-home", apps[0]],
    ["apps", "put", "historia", apps[1]],
    ["kernel", "delete", "request:req-1"],
  ]);
  assert.equal(values.get("apps:removed-app"), undefined);
  assert.equal(values.get("apps:historia"), apps[1]);
  assert.equal(values.get("kernel:request:req-1"), undefined);
  assert.equal(values.get("kernel:global"), globalEnvelope);
  assert.equal(values.get("kernel:context:launcher:one"), contextEnvelope);
});

test("commits an exact module snapshot in the same two-phase transaction", async () => {
  const { calls, values, tx } = recordingStores(new Map([
    ["modules:old", { id: "old" }],
    ["kernel:request:req-module", { id: "req-module", status: "prepared" }],
  ]));
  const module = {
    protocol: "greenways-module-record/1",
    id: "notes",
    lockDigest: `sha256:${"a".repeat(64)}`,
  };
  await commitKernelStores(tx, {
    requestId: "req-module",
    contextId: "launcher:modules",
    globalEnvelope: { protocol: "greenways-kernel-global/1", revision: 1 },
    contextEnvelope: { protocol: "greenways-kernel-context/1", revision: 1 },
    apps: [{ id: "greenways-home" }, { id: "notes" }],
    modules: [module],
  });
  assert.ok(calls.some((call) => call[0] === "modules" && call[1] === "clear"));
  assert.ok(calls.some((call) => call[0] === "modules" && call[1] === "put" && call[2] === "notes"));
  assert.equal(values.has("modules:old"), false);
  assert.equal(values.get("modules:notes"), module);
  assert.equal(values.has("kernel:request:req-module"), false);
});

test("commits an exact capability grant snapshot in the same two-phase transaction", async () => {
  const { calls, values, tx } = recordingStores(new Map([
    ["grants:grant/old-grant", { id: "grant/old-grant" }],
    ["kernel:request:req-grant", { id: "req-grant", status: "prepared" }],
  ]));
  const grant = {
    protocol: "greenways-capability-grant/1",
    id: "grant/signing-room-0001",
    capability: "key/sign",
  };
  await commitKernelStores(tx, {
    requestId: "req-grant",
    contextId: "launcher:grants",
    globalEnvelope: { protocol: "greenways-kernel-global/1", revision: 2 },
    contextEnvelope: { protocol: "greenways-kernel-context/1", revision: 2 },
    apps: [{ id: "greenways-home" }],
    grants: [grant],
  });
  assert.ok(calls.some((call) => call[0] === "grants" && call[1] === "clear"));
  assert.ok(calls.some((call) => call[0] === "grants" && call[1] === "put" && call[2] === grant.id));
  assert.equal(values.has("grants:grant/old-grant"), false);
  assert.equal(values.get(`grants:${grant.id}`), grant);
  assert.equal(values.has("kernel:request:req-grant"), false);
});

test("validates a complete module snapshot before queuing kernel writes", async () => {
  const { calls, tx } = recordingStores();
  await assert.rejects(
    commitKernelStores(tx, {
      requestId: "req-module-invalid",
      contextId: "launcher:modules",
      globalEnvelope: { revision: 1 },
      contextEnvelope: { revision: 1 },
      apps: [],
      modules: [{ id: "notes" }, { id: "notes" }],
    }),
    /duplicate module id notes/,
  );
  assert.deepEqual(calls, []);
});

test("rebinds packaged system manifests and their app projection atomically", async () => {
  const { calls, tx } = recordingStores(new Map([
    ["apps:greenways-home", { id: "greenways-home", version: "0.2.0" }],
  ]));
  const globalEnvelope = {
    protocol: "greenways-kernel-global/1",
    revision: 3,
    installed: [{ id: "greenways-home", version: "0.3.0" }],
    receipts: [],
  };
  await replaceKernelGlobalStores(tx, {
    globalEnvelope,
    apps: globalEnvelope.installed,
  });
  assert.deepEqual(calls, [
    ["kernel", "put", KERNEL_GLOBAL_KEY, globalEnvelope],
    ["apps", "clear"],
    ["apps", "put", "greenways-home", globalEnvelope.installed[0]],
  ]);
});

test("validates the complete kernel commit before queuing any writes", async () => {
  const { calls, tx } = recordingStores();
  await assert.rejects(
    commitKernelStores(tx, {
      requestId: "req-2",
      contextId: "launcher:two",
      globalEnvelope: { revision: 1 },
      contextEnvelope: { revision: 1 },
      apps: [{ id: "historia" }, { id: "historia" }],
    }),
    /duplicate app id historia/,
  );
  assert.deepEqual(calls, []);
});

test("kernel lifecycle helpers select one bounded transaction each", async () => {
  const { calls, tx } = recordingStores(new Map([
    ["kernel:global", { revision: 7 }],
    ["kernel:context:world:one", { revision: 3 }],
    ["kernel:request:req-read", { id: "req-read", status: "prepared" }],
  ]));
  const transactions = [];
  const transact = async (stores, mode, operation) => {
    transactions.push([stores, mode]);
    return operation(tx);
  };

  await prepareKernelRequest("req-new", { id: "req-new", status: "prepared" }, transact);
  assert.deepEqual(await getKernelRequest("req-new", transact), { id: "req-new", status: "prepared" });
  assert.deepEqual(await getKernelSnapshot("world:one", transact), {
    globalEnvelope: { revision: 7 },
    contextEnvelope: { revision: 3 },
  });
  await abortKernelRequest("req-new", transact);
  await commitKernelTransition({
    requestId: "req-read",
    contextId: "world:one",
    globalEnvelope: { revision: 8 },
    contextEnvelope: { revision: 4 },
    apps: [],
  }, transact);
  await replaceKernelGlobal({
    globalEnvelope: { revision: 9 },
    apps: [],
  }, transact);
  await commitKernelTransition({
    requestId: "req-module-write",
    contextId: "world:one",
    globalEnvelope: { revision: 10 },
    contextEnvelope: { revision: 5 },
    apps: [],
    modules: [{ id: "notes" }],
  }, transact);
  await commitKernelTransition({
    requestId: "req-grant-write",
    contextId: "world:one",
    globalEnvelope: { revision: 11 },
    contextEnvelope: { revision: 6 },
    apps: [],
    grants: [{ id: "grant/signing-room-0001" }],
  }, transact);

  assert.deepEqual(transactions, [
    ["kernel", "readwrite"],
    ["kernel", "readonly"],
    ["kernel", "readonly"],
    ["kernel", "readwrite"],
    [["kernel", "apps"], "readwrite"],
    [["kernel", "apps"], "readwrite"],
    [["kernel", "apps", "modules"], "readwrite"],
    [["kernel", "apps", "grants"], "readwrite"],
  ]);
  assert.ok(calls.some((call) => call[0] === "kernel" && call[1] === "delete" && call[2] === "request:req-new"));
});

test("kernel keys are namespaced and snapshot retrieval is concurrent", async () => {
  assert.equal(kernelContextKey("world:one"), "context:world:one");
  assert.equal(kernelRequestKey("request:one"), "request:request:one");
  assert.throws(() => kernelContextKey(""), /non-empty string/);
  assert.throws(() => kernelRequestKey(null), /non-empty string/);

  const { calls, tx } = recordingStores(new Map([
    ["kernel:global", { revision: 1 }],
    ["kernel:context:launcher", { revision: 2 }],
  ]));
  assert.deepEqual(await readKernelSnapshot(tx.objectStore("kernel"), "launcher"), {
    globalEnvelope: { revision: 1 },
    contextEnvelope: { revision: 2 },
  });
  assert.deepEqual(calls, [
    ["kernel", "get", "global"],
    ["kernel", "get", "context:launcher"],
  ]);
});

test("exposes a module-only durable repository facade", () => {
  assert.deepEqual(Object.keys(moduleStore), ["get", "put", "delete", "values", "replace"]);
  assert.throws(() => moduleStore.get(""), /non-empty string/);
  assert.throws(() => moduleStore.put({}), /Module record id/);
});

test("exposes a capability-only durable repository facade", () => {
  assert.deepEqual(Object.keys(capabilityStore), ["get", "put", "delete", "values", "replace"]);
  assert.throws(() => capabilityStore.get(""), /non-empty string/);
  assert.throws(() => capabilityStore.put({}), /Capability grant id/);
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
