import assert from "node:assert/strict";
import test from "node:test";
import { getAppManifest } from "../src/app-catalog.js";
import {
  createInstalledAppChecker,
  createMessageHandler,
  principalFromSender,
  resolveAppUrl,
} from "../src/background.js";

const runtime = { id: "greenways", getURL: (path) => `chrome-extension://greenways/${path}` };
const senderFor = (path, documentId = `document:${path}`) => ({
  id: runtime.id,
  url: runtime.getURL(path),
  documentId,
  frameId: 0,
  tab: { incognito: false },
});

test("generic app launches resolve only through the fixed bundled catalog", () => {
  assert.equal(
    resolveAppUrl("greenways-worlds", runtime),
    "chrome-extension://greenways/src/world.html",
  );
  assert.throws(() => resolveAppUrl("historia", runtime), /Unknown Greenways app/);
  assert.equal(resolveAppUrl("hara-playground", runtime), "https://playground.hara-lang.org/");
  assert.throws(() => resolveAppUrl("https://attacker.example", runtime), /lowercase app identifier/);
  assert.throws(() => resolveAppUrl("not-installed", runtime), /Unknown Greenways app/);
  assert.throws(() => resolveAppUrl("chats", runtime), /opens inside/);
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
    assert.equal(handler(
      { type: "greenways/open-app", appId: "greenways-worlds" },
      senderFor("src/launcher.html"),
      resolve,
    ), true);
  });
  assert.deepEqual(await genericResponse, { ok: true, tabId: 1 });

  const legacyResponse = new Promise((resolve) => {
    assert.equal(handler(
      { type: "greenways/open-studio" },
      senderFor("src/studio.html"),
      resolve,
    ), true);
  });
  assert.deepEqual(await legacyResponse, { ok: true, tabId: 2 });
  assert.deepEqual(calls, [
    "chrome-extension://greenways/src/world.html",
    "chrome-extension://greenways/src/studio.html#home",
  ]);
  const rejectedResponse = new Promise((resolve) => {
    assert.equal(handler(
      { type: "greenways/open-app", appId: "unbundled" },
      senderFor("src/launcher.html"),
      resolve,
    ), true);
  });
  assert.match((await rejectedResponse).error, /Unknown Greenways app/);
  assert.equal(handler({ type: "unrelated" }, {}, () => {}), false);
});

test("generic routes allow system apps but reject optional apps until installed", async () => {
  const calls = [];
  const handler = createMessageHandler({
    runtime,
    tabs: { create: async ({ url }) => { calls.push(url); return { id: calls.length }; } },
    isAppInstalled: async (appId) => appId === "chats",
  });

  const systemResponse = new Promise((resolve) => {
    assert.equal(handler(
      { type: "greenways/open-app", appId: "greenways-worlds" },
      senderFor("src/launcher.html"),
      resolve,
    ), true);
  });
  assert.equal((await systemResponse).ok, true);

  const installedResponse = new Promise((resolve) => {
    assert.equal(handler(
      { type: "greenways/open-app", appId: "chats" },
      senderFor("src/launcher.html"),
      resolve,
    ), true);
  });
  assert.match((await installedResponse).error, /opens inside/);

  const deniedResponse = new Promise((resolve) => {
    assert.equal(handler(
      { type: "greenways/open-app", appId: "historia" },
      senderFor("src/launcher.html"),
      resolve,
    ), true);
  });
  assert.match((await deniedResponse).error, /Unknown Greenways app/);
  assert.deepEqual(calls, ["chrome-extension://greenways/src/world.html"]);
});

test("default installation checker reads optional apps from the durable apps store", async () => {
  const reads = [];
  const checker = createInstalledAppChecker({
    get: async (storeName, appId) => {
      reads.push([storeName, appId]);
      return appId === "chats" ? getAppManifest(appId) : undefined;
    },
  });

  assert.equal(await checker("greenways-worlds"), true);
  assert.deepEqual(reads, []);
  assert.equal(await checker("chats"), true);
  assert.equal(await checker("userscripts"), false);
  assert.deepEqual(reads, [
    ["apps", "chats"],
    ["apps", "userscripts"],
  ]);
});

test("legacy optional-app launches require the exact approved manifest", async () => {
  const checker = createInstalledAppChecker({
    get: async () => ({ ...getAppManifest("chats"), version: "0.0.1" }),
  });
  assert.equal(await checker("chats"), false);
});

test("derives kernel roles from exact active packaged documents", async () => {
  const activeRuntime = {
    ...runtime,
    getContexts: async ({ documentIds }) => [{
      documentId: documentIds[0],
      contextType: "TAB",
      incognito: false,
    }],
  };
  const sender = senderFor("src/launcher.html", "document:active-launcher");
  assert.deepEqual(
    await principalFromSender(
      senderFor("src/devtools.html", "document:active-devtools"),
      { type: "greenways/kernel/attach", clientKind: "devtools" },
      activeRuntime,
    ),
    { kind: "devtools", clientId: "document/document:active-devtools" },
  );
  assert.deepEqual(
    await principalFromSender(sender, {
      type: "greenways/kernel/attach",
      clientKind: "launcher",
      contextId: "context/launcher-auth-0001",
    }, activeRuntime),
    { kind: "launcher", clientId: "document/document:active-launcher" },
  );
  await assert.rejects(
    principalFromSender(sender, {
      type: "greenways/kernel/call",
      clientKind: "launcher",
      contextId: "context/another-document-0001",
    }, activeRuntime),
    /context does not match/,
  );
  await assert.rejects(
    principalFromSender(sender, { clientKind: "world" }, activeRuntime),
    /role does not match/,
  );
  await assert.rejects(
    principalFromSender({ ...sender, id: "another-extension" }, {}, activeRuntime),
    /not this extension/,
  );
  await assert.rejects(
    principalFromSender({ ...sender, url: runtime.getURL("src/verifier.html") }, {}, activeRuntime),
    /not a kernel caller/,
  );
  await assert.rejects(
    principalFromSender({ ...sender, tab: { incognito: true } }, {}, activeRuntime),
    /incognito/,
  );
  await assert.rejects(
    principalFromSender(sender, {}, { ...activeRuntime, getContexts: async () => [] }),
    /not an active extension context/,
  );
});

test("launcher opens the fixed root DevTools app without package installation", async () => {
  const calls = [];
  const handler = createMessageHandler({
    runtime,
    tabs: { create: async ({ url }) => { calls.push(url); return { id: 91 }; } },
  });
  const response = await new Promise((resolve) => {
    assert.equal(handler(
      { type: "greenways/open-root-app", appId: "greenways-devtools" },
      senderFor("src/launcher.html"),
      resolve,
    ), true);
  });
  assert.deepEqual(response, { ok: true, tabId: 91 });
  assert.deepEqual(calls, ["chrome-extension://greenways/src/devtools.html"]);
});

test("only the root DevTools page controls the native RESP bridge", async () => {
  const calls = [];
  const bridge = {
    snapshot: ({ revealToken }) => ({ state: "active", token: revealToken ? "session-token" : null }),
    start: async ({ port }) => { calls.push(["start", port]); return { state: "active", port, token: "session-token" }; },
    stop: () => { calls.push(["stop"]); return { state: "stopped", token: null }; },
  };
  const handler = createMessageHandler({ runtime, getDevtoolsBridge: () => bridge });
  const start = await new Promise((resolve) => handler(
    { type: "greenways/devtools-bridge/start", port: 46379 },
    senderFor("src/devtools.html"),
    resolve,
  ));
  assert.equal(start.ok, true);
  assert.equal(start.bridge.token, "session-token");
  assert.deepEqual(calls, [["start", 46379]]);

  const denied = await new Promise((resolve) => handler(
    { type: "greenways/devtools-bridge/status" },
    senderFor("src/launcher.html"),
    resolve,
  ));
  assert.match(denied.error, /Only the root DevTools app/);
});
