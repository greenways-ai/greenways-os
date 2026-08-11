import assert from "node:assert/strict";
import test from "node:test";
import { getAppManifest, getBuiltinAppCatalog } from "../src/app-catalog.js";
import {
  createInstalledAppChecker,
  createMessageHandler,
  installActionAccess,
  installTahtoMonitoring,
  principalFromSender,
  resolveAppUrl,
} from "../src/background.js";

await getBuiltinAppCatalog();

test("toolbar action opens the launcher in a browser tab", async () => {
  let listener;
  const calls = [];
  const access = installActionAccess({
    runtime: { getURL: (path) => `chrome-extension://greenways/${path}` },
    action: { onClicked: { addListener(value) { listener = value; } } },
    sidePanel: { setPanelBehavior: async (options) => calls.push(["behavior", options]) },
    tabs: { create: async (options) => calls.push(["tab", options]) },
  });
  await access.openLauncher({ id: 7 });
  assert.equal(typeof listener, "function");
  assert.deepEqual(calls, [
    ["behavior", { openPanelOnActionClick: false }],
    ["tab", { url: "chrome-extension://greenways/src/launcher.html#home" }],
  ]);
});

test("Tahto monitoring checks on startup and only on its named alarm", async () => {
  const startup = [];
  const alarm = [];
  const checks = [];
  let schedules = 0;
  installTahtoMonitoring({
    runtime: { onStartup: { addListener(listener) { startup.push(listener); } } },
    alarms: { onAlarm: { addListener(listener) { alarm.push(listener); } } },
    monitor: {
      async check(source) { checks.push(source); },
      async schedule() { schedules += 1; },
    },
    report(error) { throw error; },
  });
  startup[0]();
  alarm[0]({ name: "not-tahto" });
  alarm[0]({ name: "greenways:tahto-monitor" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(schedules, 1);
  assert.deepEqual(checks, ["startup", "background"]);
});

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
  const routedDevtoolsSender = {
    ...senderFor("src/devtools.html", "document:routed-devtools"),
    url: runtime.getURL("src/devtools.html#developer"),
  };
  assert.deepEqual(
    await principalFromSender(
      routedDevtoolsSender,
      { type: "greenways/kernel/attach", clientKind: "devtools" },
      {
        ...runtime,
        getContexts: async () => [{
          documentId: "document:routed-devtools",
          documentUrl: runtime.getURL("src/devtools.html#kernel"),
          contextType: "TAB",
          incognito: false,
        }],
      },
    ),
    { kind: "devtools", clientId: "document/document:routed-devtools" },
  );
  await assert.rejects(
    principalFromSender(
      routedDevtoolsSender,
      { type: "greenways/kernel/attach", clientKind: "devtools" },
      {
        ...runtime,
        getContexts: async () => [{
          documentId: "document:routed-devtools",
          documentUrl: runtime.getURL("src/launcher.html#developer"),
          contextType: "TAB",
          incognito: false,
        }],
      },
    ),
    /not an active extension context/,
  );
  assert.deepEqual(
    await principalFromSender(sender, {
      type: "greenways/kernel/attach",
      clientKind: "launcher",
      contextId: "context/launcher-auth-0001",
    }, activeRuntime),
    { kind: "launcher", clientId: "document/document:active-launcher" },
  );
  const arcSender = {
    ...sender,
    documentId: undefined,
    tab: { id: 42 },
  };
  const arcRuntime = {
    ...runtime,
    getContexts: async (filter) => {
      assert.deepEqual(filter, {
        contextTypes: ["TAB", "SIDE_PANEL"],
        documentUrls: [runtime.getURL("src/launcher.html")],
        tabIds: [42],
      });
      return [{
        documentId: "document:arc-launcher",
        documentUrl: runtime.getURL("src/launcher.html"),
        contextType: "TAB",
        tabId: 42,
        incognito: false,
      }];
    },
  };
  assert.deepEqual(
    await principalFromSender(arcSender, {
      type: "greenways/kernel/attach",
      clientKind: "launcher",
    }, arcRuntime),
    { kind: "launcher", clientId: "document/document:arc-launcher" },
  );
  assert.deepEqual(
    await principalFromSender(arcSender, {
      type: "greenways/kernel/attach",
      clientKind: "launcher",
      contextId: "context/arc-launcher-0001",
    }, runtime),
    { kind: "launcher", clientId: "context/arc-launcher-0001" },
  );
  await assert.rejects(
    principalFromSender(arcSender, {
      type: "greenways/kernel/attach",
      clientKind: "launcher",
      contextId: "attacker-selected",
    }, runtime),
    /no active document identity/,
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

test("routes ChatGPT provider page events without granting the page kernel identity", async () => {
  const calls = [];
  const handler = createMessageHandler({
    runtime,
    getKernelHost: async () => ({
      async handleChatgptProviderPageMessage(message, sender) {
        calls.push([message.operation, sender.url]);
        return { ok: true, protocol: "greenways-chatgpt-provider/0-alpha", command: null };
      },
    }),
  });
  const response = await new Promise((resolve) => {
    assert.equal(handler({
      type: "greenways/chatgpt-provider",
      protocol: "greenways-chatgpt-provider/0-alpha",
      operation: "hello",
      sessionId: null,
      payload: {},
    }, {
      id: runtime.id,
      url: "https://chatgpt.com/",
      frameId: 0,
      tab: { id: 7, incognito: false },
    }, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [["hello", "https://chatgpt.com/"]]);
});
