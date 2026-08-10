import assert from "node:assert/strict";
import test from "node:test";
import { createAppWindowCoordinator } from "../src/app-window.js";

function storage(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(record) { Object.assign(values, record); },
    async remove(key) { delete values[key]; },
  };
}

const runtime = { getURL: (path) => `chrome-extension://greenways/${path}` };

test("creates and remembers one compact app window", async () => {
  const calls = [];
  const sessionStorage = storage();
  const coordinator = createAppWindowCoordinator({
    runtime,
    sessionStorage,
    windows: {
      create: async (options) => { calls.push(options); return { id: 41 }; },
      onRemoved: { addListener() {} },
    },
    tabs: { create: async () => assert.fail("tab fallback should not run") },
  });
  assert.deepEqual(await coordinator.open(), { mode: "window", windowId: 41 });
  assert.equal(sessionStorage.values.greenwaysAppWindowId, 41);
  assert.deepEqual(calls, [{
    url: "chrome-extension://greenways/src/launcher.html#home",
    type: "popup",
    focused: true,
    width: 920,
    height: 680,
  }]);
});

test("focuses an existing window and recovers stale ids", async () => {
  const sessionStorage = storage({ greenwaysAppWindowId: 12 });
  const updates = [];
  const coordinator = createAppWindowCoordinator({
    runtime,
    sessionStorage,
    windows: {
      get: async (id) => ({ id }),
      update: async (id, options) => { updates.push([id, options]); return { id }; },
      create: async () => assert.fail("existing window should be reused"),
      onRemoved: { addListener() {} },
    },
    tabs: { create: async () => assert.fail("tab fallback should not run") },
  });
  assert.deepEqual(await coordinator.open(), { mode: "focused", windowId: 12 });
  assert.deepEqual(updates, [[12, { focused: true }]]);

  const staleStorage = storage({ greenwaysAppWindowId: 99 });
  const recovered = createAppWindowCoordinator({
    runtime,
    sessionStorage: staleStorage,
    windows: {
      get: async () => { throw new Error("missing"); },
      update: async () => assert.fail("stale window should not update"),
      create: async () => ({ id: 13 }),
      onRemoved: { addListener() {} },
    },
    tabs: { create: async () => assert.fail("tab fallback should not run") },
  });
  assert.deepEqual(await recovered.open(), { mode: "window", windowId: 13 });
  assert.equal(staleStorage.values.greenwaysAppWindowId, 13);
});

test("falls back to a launcher tab when app windows are unavailable", async () => {
  const calls = [];
  const coordinator = createAppWindowCoordinator({
    runtime,
    sessionStorage: storage(),
    windows: {
      create: async () => { throw new Error("unsupported"); },
      onRemoved: { addListener() {} },
    },
    tabs: { create: async (options) => { calls.push(options); return { id: 8 }; } },
  });
  assert.deepEqual(await coordinator.open(), { mode: "tab", tabId: 8 });
  assert.deepEqual(calls, [{ url: "chrome-extension://greenways/src/launcher.html#home" }]);
});
