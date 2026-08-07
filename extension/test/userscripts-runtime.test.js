import assert from "node:assert/strict";
import test from "node:test";
import { createUserscriptsRuntime } from "../src/userscripts-runtime.js";

function memoryStore(initial = []) {
  const entries = new Map(initial.map((record) => [record.id, record]));
  return {
    entries,
    async get(id) {
      return entries.get(id);
    },
    async put(record) {
      entries.set(record.id, structuredClone(record));
    },
    async delete(id) {
      entries.delete(id);
    },
    async values() {
      return [...entries.values()].map((record) => structuredClone(record));
    },
  };
}

function fakeUserScripts() {
  return {
    registered: [],
    calls: [],
    async unregister(ids) {
      this.calls.push(["unregister", ids ?? null]);
      this.registered = ids ? this.registered.filter(({ id }) => !ids.includes(id)) : [];
    },
    async register(scripts) {
      this.calls.push(["register", structuredClone(scripts)]);
      this.registered.push(...structuredClone(scripts));
    },
    async getScripts() {
      this.calls.push(["getScripts"]);
      return structuredClone(this.registered);
    },
  };
}

function createRig({
  store = memoryStore(),
  userScripts = fakeUserScripts(),
  assertAuthority = async () => {},
  now = () => new Date("2026-08-07T03:00:00.000Z"),
} = {}) {
  const runtime = createUserscriptsRuntime({ store, userScripts, assertAuthority, now });
  return { runtime, store, userScripts };
}

const draft = {
  name: "Hello script",
  matches: ["https://example.com/*"],
  runAt: "document_end",
  enabled: true,
  source: "console.log('hello');",
};

test("lists and reports status without management authority", async () => {
  const { runtime } = createRig({
    assertAuthority: async () => {
      throw new Error("denied");
    },
  });
  const status = await runtime.call("userscripts/status");
  assert.equal(status.ok, true);
  assert.equal(status.available, true);
  assert.equal(status.scripts, 0);
  const list = await runtime.call("userscripts/list");
  assert.deepEqual(list.scripts, []);
});

test("reports registration as unavailable without the chrome.userScripts API", async () => {
  const { runtime } = createRig({ userScripts: null });
  const status = await runtime.call("userscripts/status");
  assert.equal(status.available, false);
});

test("requires management authority before saving", async () => {
  const { runtime, store } = createRig({
    assertAuthority: async () => {
      const error = new Error("Capability authority denied: userscripts/manage");
      error.code = "CAPABILITY_DENIED";
      throw error;
    },
  });
  await assert.rejects(() => runtime.call("userscripts/save", [draft]), /denied/);
  assert.equal(store.entries.size, 0);
});

test("saves a validated record and registers enabled scripts in an isolated world", async () => {
  const { runtime, store, userScripts } = createRig();
  const result = await runtime.call("userscripts/save", [draft]);
  const { record } = result;
  assert.match(record.id, /^script\/[a-f0-9]{32}$/);
  assert.match(record.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(record.createdAt, "2026-08-07T03:00:00.000Z");
  assert.equal(record.updatedAt, "2026-08-07T03:00:00.000Z");
  assert.equal(store.entries.size, 1);
  assert.equal(result.registration.registered, 1);
  const registered = userScripts.registered[0];
  assert.equal(registered.id, record.id);
  assert.deepEqual(registered.matches, ["https://example.com/*"]);
  assert.equal(registered.runAt, "document_end");
  assert.deepEqual(registered.js, [{ code: "console.log('hello');" }]);
  assert.equal(registered.world, "USER_SCRIPT");
});

test("re-registers the full enabled set on every mutation", async () => {
  const { runtime, userScripts } = createRig();
  await runtime.call("userscripts/save", [draft]);
  await runtime.call("userscripts/save", [{ ...draft, name: "Second", enabled: false }]);
  const unregisterCalls = userScripts.calls.filter(([method]) => method === "unregister");
  assert.equal(unregisterCalls.length, 2);
  assert.equal(userScripts.registered.length, 1);
});

test("updates an existing record while preserving identity and creation time", async () => {
  let tick = 0;
  const times = ["2026-08-07T03:00:00.000Z", "2026-08-07T04:00:00.000Z"];
  const { runtime } = createRig({ now: () => new Date(times[Math.min(tick++, times.length - 1)]) });
  const created = await runtime.call("userscripts/save", [{ ...draft, enabled: false }]);
  const updated = await runtime.call("userscripts/save", [{
    id: created.record.id,
    name: "Renamed",
    matches: ["https://example.org/*"],
    runAt: "document_start",
    enabled: true,
    source: "console.log('v2');",
  }]);
  assert.equal(updated.record.id, created.record.id);
  assert.equal(updated.record.name, "Renamed");
  assert.equal(updated.record.createdAt, "2026-08-07T03:00:00.000Z");
  assert.equal(updated.record.updatedAt, "2026-08-07T04:00:00.000Z");
  assert.notEqual(updated.record.digest, created.record.digest);
});

test("rejects unknown ids, oversized collections, and invalid drafts", async () => {
  const { runtime } = createRig();
  await assert.rejects(
    () => runtime.call("userscripts/save", [{ ...draft, id: "script/missing00" }]),
    /does not exist/,
  );
  await assert.rejects(
    () => runtime.call("userscripts/save", [{ ...draft, matches: ["javascript:alert(1)"] }]),
    /match pattern/i,
  );
  await assert.rejects(() => runtime.call("userscripts/remove", ["script/missing00"]), /does not exist/);
  await assert.rejects(() => runtime.call("userscripts/set-enabled", ["script/missing00", true]), /does not exist/);
});

test("toggles enablement and keeps disabled scripts out of the registration", async () => {
  const { runtime, userScripts } = createRig();
  const created = await runtime.call("userscripts/save", [draft]);
  const disabled = await runtime.call("userscripts/set-enabled", [created.record.id, false]);
  assert.equal(disabled.record.enabled, false);
  assert.equal(userScripts.registered.length, 0);
  await runtime.call("userscripts/set-enabled", [created.record.id, true]);
  assert.equal(userScripts.registered.length, 1);
});

test("removes records and unregisters them", async () => {
  const { runtime, store, userScripts } = createRig();
  const created = await runtime.call("userscripts/save", [draft]);
  const removed = await runtime.call("userscripts/remove", [created.record.id]);
  assert.equal(removed.ok, true);
  assert.equal(store.entries.size, 0);
  assert.equal(userScripts.registered.length, 0);
});

test("rejects unsupported methods", async () => {
  const { runtime } = createRig();
  await assert.rejects(() => runtime.call("userscripts/drop-tables", []), /Unsupported userscripts method/);
});
