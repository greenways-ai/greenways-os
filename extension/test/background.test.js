import assert from "node:assert/strict";
import test from "node:test";
import { createInstalledAppChecker, createMessageHandler, resolveAppUrl } from "../src/background.js";

const runtime = { getURL: (path) => `chrome-extension://greenways/${path}` };

test("generic app launches resolve only through the fixed bundled catalog", () => {
  assert.equal(
    resolveAppUrl("greenways-home", runtime),
    "chrome-extension://greenways/src/studio.html#home",
  );
  assert.equal(resolveAppUrl("historia", runtime), "http://127.0.0.1:4319/");
  assert.equal(resolveAppUrl("hara-playground", runtime), "https://playground.hara-lang.org/");
  assert.throws(() => resolveAppUrl("https://attacker.example", runtime), /lowercase app identifier/);
  assert.throws(() => resolveAppUrl("not-installed", runtime), /Unknown Greenways app/);
  assert.throws(() => resolveAppUrl("hestia-connector", runtime), /opens inside/);
});

test("Chrome 116 message listener responds asynchronously and keeps legacy routes", async () => {
  const calls = [];
  const tabs = {
    create: async ({ url }) => {
      calls.push(url);
      return { id: calls.length };
    },
  };
  const handler = createMessageHandler({ runtime, tabs });

  const genericResponse = new Promise((resolve) => {
    assert.equal(handler({ type: "greenways/open-app", appId: "greenways-worlds" }, {}, resolve), true);
  });
  assert.deepEqual(await genericResponse, { ok: true, tabId: 1 });

  const legacyResponse = new Promise((resolve) => {
    assert.equal(handler({ type: "greenways/open-studio" }, {}, resolve), true);
  });
  assert.deepEqual(await legacyResponse, { ok: true, tabId: 2 });
  assert.deepEqual(calls, [
    "chrome-extension://greenways/src/world.html",
    "chrome-extension://greenways/src/studio.html#home",
  ]);
  const rejectedResponse = new Promise((resolve) => {
    assert.equal(handler({ type: "greenways/open-app", appId: "unbundled" }, {}, resolve), true);
  });
  assert.match((await rejectedResponse).error, /Unknown Greenways app/);
  assert.equal(handler({ type: "unrelated" }, {}, () => {}), false);
});

test("generic routes allow system apps but reject optional apps until installed", async () => {
  const calls = [];
  const handler = createMessageHandler({
    runtime,
    tabs: { create: async ({ url }) => { calls.push(url); return { id: calls.length }; } },
    isAppInstalled: async (appId) => appId === "hara-playground",
  });

  const systemResponse = new Promise((resolve) => {
    assert.equal(handler({ type: "greenways/open-app", appId: "greenways-home" }, {}, resolve), true);
  });
  assert.equal((await systemResponse).ok, true);

  const installedResponse = new Promise((resolve) => {
    assert.equal(handler({ type: "greenways/open-app", appId: "hara-playground" }, {}, resolve), true);
  });
  assert.equal((await installedResponse).ok, true);

  const deniedResponse = new Promise((resolve) => {
    assert.equal(handler({ type: "greenways/open-app", appId: "historia" }, {}, resolve), true);
  });
  assert.match((await deniedResponse).error, /Historia is not installed/);
  assert.deepEqual(calls, [
    "chrome-extension://greenways/src/studio.html#home",
    "https://playground.hara-lang.org/",
  ]);
});

test("default installation checker reads optional apps from the durable apps store", async () => {
  const reads = [];
  const checker = createInstalledAppChecker({
    get: async (storeName, appId) => {
      reads.push([storeName, appId]);
      return appId === "historia" ? { id: appId } : undefined;
    },
  });

  assert.equal(await checker("greenways-worlds"), true);
  assert.deepEqual(reads, []);
  assert.equal(await checker("historia"), true);
  assert.equal(await checker("hara-playground"), false);
  assert.deepEqual(reads, [
    ["apps", "historia"],
    ["apps", "hara-playground"],
  ]);
});