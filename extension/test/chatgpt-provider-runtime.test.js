import assert from "node:assert/strict";
import test from "node:test";
import {
  CHATGPT_PROVIDER_MESSAGE_TYPE,
  CHATGPT_PROVIDER_PROTOCOL,
  createChatgptProviderRuntime,
} from "../src/chatgpt-provider-runtime.js";

function memoryStore() {
  const records = new Map();
  return {
    get: async (id) => records.get(id),
    put: async (record) => { records.set(record.id, structuredClone(record)); },
    delete: async (id) => records.delete(id),
    values: async () => [...records.values()].map((value) => structuredClone(value)),
  };
}

function pageMessage(operation, sessionId, payload = {}) {
  return {
    type: CHATGPT_PROVIDER_MESSAGE_TYPE,
    protocol: CHATGPT_PROVIDER_PROTOCOL,
    operation,
    sessionId,
    payload,
  };
}

const sender = {
  id: "greenways",
  frameId: 0,
  documentId: "document-chatgpt-0001",
  url: "https://chatgpt.com/c/example",
  tab: { id: 7, incognito: false },
};

test("runs an explicit foreground ChatGPT session without pressing Send", async () => {
  let registered = [];
  const sent = [];
  let authorityChecks = 0;
  const runtime = createChatgptProviderRuntime({
    store: memoryStore(),
    runtime: { id: "greenways" },
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      unregisterContentScripts: async () => { registered = []; },
      registerContentScripts: async (records) => { registered = records; },
    },
    tabs: {
      query: async () => [{ id: 7, incognito: false }],
      update: async () => {},
      sendMessage: async (tabId, message) => { sent.push([tabId, message]); },
      create: async () => { throw new Error("an existing ChatGPT tab should be reused"); },
    },
    assertAuthority: async () => { authorityChecks += 1; },
    now: (() => {
      let second = 0;
      return () => new Date(`2026-08-11T00:00:${String(second++).padStart(2, "0")}.000Z`);
    })(),
  });

  assert.equal((await runtime.call("chatgpt-provider/status")).enabled, false);
  assert.equal((await runtime.call("chatgpt-provider/set-enabled", [true])).enabled, true);

  const created = await runtime.call("chatgpt-provider/create", [{
    prompt: "Explain this Hara form.",
    title: "Hara help",
    callerAppId: "hara-playground",
  }]);
  assert.equal(created.session.state, "created");
  assert.equal(created.session.provider, "webapp.chatgpt");
  assert.equal(sent.length, 1);
  assert.equal(sent[0][1].operation, "stage");
  assert.ok(!Object.hasOwn(sent[0][1], "send"));

  const hello = await runtime.handlePageMessage(pageMessage("hello", null, {
    conversationId: "example",
  }), sender);
  assert.equal(hello.command.operation, "stage");
  assert.equal(hello.command.session.prompt, "Explain this Hara form.");

  const sessionId = created.session.id;
  assert.equal((await runtime.handlePageMessage(pageMessage("staged", sessionId, {
    conversationId: "example",
  }), sender)).session.state, "staged");
  assert.equal((await runtime.handlePageMessage(pageMessage("ready", sessionId, {
    conversationId: "example",
    assistantMessageId: "assistant-1",
    output: "It evaluates a visible rule.",
  }), sender)).session.state, "ready");
  const returned = await runtime.handlePageMessage(pageMessage("returned", sessionId, {
    conversationId: "example",
    assistantMessageId: "assistant-1",
    output: "It evaluates a visible rule.",
  }), sender);
  assert.equal(returned.session.state, "returned");
  assert.equal(returned.session.output, "It evaluates a visible rule.");
  assert.match(returned.session.outputDigest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(authorityChecks >= 6);

  const disabled = await runtime.call("chatgpt-provider/set-enabled", [false]);
  assert.equal(disabled.enabled, false);
});

test("rejects unapproved pages and changed return payloads", async () => {
  let registered = [];
  const runtime = createChatgptProviderRuntime({
    store: memoryStore(),
    runtime: { id: "greenways" },
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      unregisterContentScripts: async () => { registered = []; },
      registerContentScripts: async (records) => { registered = records; },
    },
    tabs: {
      query: async () => [{ id: 7, incognito: false }],
      update: async () => {},
      sendMessage: async () => {},
      create: async () => ({ id: 7 }),
    },
  });
  await runtime.call("chatgpt-provider/set-enabled", [true]);
  const { session } = await runtime.call("chatgpt-provider/create", [{ prompt: "Prompt" }]);
  await assert.rejects(
    runtime.handlePageMessage(pageMessage("hello", null), {
      ...sender,
      url: "https://attacker.example/",
    }),
    /unapproved origin/,
  );
  await runtime.handlePageMessage(pageMessage("hello", null), sender);
  await runtime.handlePageMessage(pageMessage("staged", session.id), sender);
  await runtime.handlePageMessage(pageMessage("ready", session.id, {
    assistantMessageId: "assistant-1",
    output: "Reviewed output",
  }), sender);
  await assert.rejects(
    runtime.handlePageMessage(pageMessage("returned", session.id, {
      assistantMessageId: "assistant-1",
      output: "Changed output",
    }), sender),
    /does not match the reviewed candidate/,
  );
});


test("opens another ChatGPT tab rather than overlapping an active session", async () => {
  let registered = [];
  let nextTab = 9;
  const runtime = createChatgptProviderRuntime({
    store: memoryStore(),
    runtime: { id: "greenways" },
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      unregisterContentScripts: async () => { registered = []; },
      registerContentScripts: async (records) => { registered = records; },
    },
    tabs: {
      query: async () => [{ id: 7, incognito: false }],
      update: async () => {},
      sendMessage: async () => {},
      create: async () => ({ id: nextTab++ }),
    },
  });
  await runtime.call("chatgpt-provider/set-enabled", [true]);
  const first = await runtime.call("chatgpt-provider/create", [{ prompt: "First" }]);
  assert.equal(first.session.tabId, 7);
  const second = await runtime.call("chatgpt-provider/create", [{ prompt: "Second" }]);
  assert.equal(second.session.tabId, 9);
});

test("replays identical broker requests, rejects collisions, and expires stale sessions", async () => {
  let registered = [];
  let clock = new Date("2026-08-11T03:00:00.000Z");
  const store = memoryStore();
  const runtime = createChatgptProviderRuntime({
    store,
    runtime: { id: "greenways" },
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      unregisterContentScripts: async () => { registered = []; },
      registerContentScripts: async (records) => { registered = records; },
    },
    tabs: {
      query: async () => [{ id: 7, incognito: false }],
      update: async () => {},
      sendMessage: async () => {},
      create: async () => ({ id: 9 }),
    },
    now: () => new Date(clock),
  });
  await runtime.call("chatgpt-provider/set-enabled", [true]);
  const request = {
    prompt: "USER:\nExplain this form.",
    title: "Hara Playground request",
    callerAppId: "hara-playground",
    callerOrigin: "https://playground.hara-lang.org",
    callerGrantId: "grant/hara-playground/model-generate/0001",
    requestId: "request/0123456789abcdef",
    model: "chatgpt-auto",
    expiresAt: "2026-08-11T03:15:00.000Z",
  };
  const first = await runtime.call("chatgpt-provider/create", [request]);
  const replayed = await runtime.call("chatgpt-provider/create", [request]);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.session.id, first.session.id);
  assert.equal(
    (await runtime.call("chatgpt-provider/get-request", [request.requestId])).session.id,
    first.session.id,
  );
  await assert.rejects(
    runtime.call("chatgpt-provider/create", [{ ...request, prompt: "Changed" }]),
    (error) => error.code === "REQUEST_ID_REUSE",
  );
  clock = new Date("2026-08-11T03:16:00.000Z");
  const expired = await runtime.call("chatgpt-provider/get-request", [request.requestId]);
  assert.equal(expired.session.state, "expired");
  const cancelled = await runtime.call("chatgpt-provider/cancel-request", [request.requestId]);
  assert.equal(cancelled.session.state, "expired");
});
