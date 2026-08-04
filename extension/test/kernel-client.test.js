import assert from "node:assert/strict";
import test from "node:test";
import {
  KERNEL_MESSAGE_TYPES,
  KERNEL_PROTOCOL,
  KernelClient,
  validateKernelResponse,
} from "../src/kernel-client.js";

const CONTEXT_ID = "context/0000000000000001";
const OTHER_CONTEXT_ID = "context/0000000000000002";
const BROWSER_CONTEXT_ID = "document/00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "request/0000000000000001";
const RUNTIME_ID = "greenways-test-extension";
const HOST_SENDER = Object.freeze({ id: RUNTIME_ID });

class RuntimeEvent {
  constructor() {
    this.listeners = new Set();
  }

  addListener(listener) {
    this.listeners.add(listener);
  }

  removeListener(listener) {
    this.listeners.delete(listener);
  }

  emit(message, sendResponse = () => {}, sender = HOST_SENDER) {
    return [...this.listeners].map((listener) => listener(message, sender, sendResponse));
  }
}

class FakeRuntime {
  constructor(handler) {
    this.id = RUNTIME_ID;
    this.handler = handler;
    this.onMessage = new RuntimeEvent();
    this.messages = [];
    this.lastError = null;
  }

  sendMessage(message, callback) {
    this.messages.push(message);
    queueMicrotask(async () => {
      try {
        callback(await this.handler(message));
      } catch (error) {
        this.lastError = { message: error.message };
        callback(undefined);
        this.lastError = null;
      }
    });
  }
}

function response(value = {}) {
  const context = "state" in value && value.contextId === undefined
    ? { contextId: CONTEXT_ID }
    : {};
  return { protocol: KERNEL_PROTOCOL, ok: true, ...context, ...value };
}

function clientWith(runtime, { effectCalls = [], ids = [CONTEXT_ID, REQUEST_ID] } = {}) {
  return new KernelClient({
    runtime,
    clientKind: "launcher",
    randomId: () => ids.shift(),
    effects: {
      async run(effects, context) {
        effectCalls.push({ effects, context });
      },
    },
  });
}

test("attaches through callback messaging and exposes a Hara-session-compatible snapshot", async () => {
  const runtime = new FakeRuntime((message) => {
    assert.equal(message.type, KERNEL_MESSAGE_TYPES.ATTACH);
    assert.equal(message.protocol, KERNEL_PROTOCOL);
    assert.equal(message.contextId, CONTEXT_ID);
    assert.equal(message.clientKind, "launcher");
    return response({
      contextId: BROWSER_CONTEXT_ID,
      state: { apps: { installed: [] } },
      globalRevision: 2,
      contextRevision: 0,
    });
  });
  const client = clientWith(runtime);
  const seen = [];
  client.subscribe((state, event) => seen.push([state, event]));

  assert.equal(await client.start(), client);
  assert.deepEqual(client.state, { apps: { installed: [] } });
  assert.equal(client.globalRevision, 2);
  assert.equal(client.contextRevision, 0);
  assert.equal(client.contextId, BROWSER_CONTEXT_ID);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1].method, "app/bootstrap");
  assert.equal(seen[0][1].source, "attach");

  const late = [];
  client.subscribe((state, event) => late.push([state, event.source]));
  assert.deepEqual(late, [[client.state, "snapshot"]]);
});

test("calls stateless Hara methods without executing their returned effect plans", async () => {
  const effectCalls = [];
  const runtime = new FakeRuntime((message) => {
    if (message.type === KERNEL_MESSAGE_TYPES.ATTACH) {
      return response({ state: {}, globalRevision: 0, contextRevision: 0 });
    }
    assert.deepEqual(message, {
      protocol: KERNEL_PROTOCOL,
      type: KERNEL_MESSAGE_TYPES.CALL,
      contextId: CONTEXT_ID,
      clientKind: "launcher",
      method: "world/open",
      args: ["greenways/world", "main", "dev"],
    });
    return response({ value: { state: { status: "resolving" }, effects: [{ effect: "github", method: "resolve-world" }] } });
  });
  const client = clientWith(runtime, { effectCalls });

  const result = await client.call("world/open", ["greenways/world", "main", "dev"]);
  assert.equal(result.state.status, "resolving");
  assert.equal(effectCalls.length, 0);
});

test("dispatch receives an empty effect plan after the host executes its targeted effect", async () => {
  const order = [];
  let client;
  let runtime;
  runtime = new FakeRuntime(async (message) => {
    if (message.type === KERNEL_MESSAGE_TYPES.ATTACH) {
      return response({ state: { apps: { installed: [] } }, globalRevision: 0, contextRevision: 0 });
    }
    assert.equal(message.type, KERNEL_MESSAGE_TYPES.DISPATCH);
    assert.equal(message.requestId, REQUEST_ID);
    assert.equal(message.method, "apps/install");
    const effectReply = new Promise((resolve) => {
      const returns = runtime.onMessage.emit({
        protocol: KERNEL_PROTOCOL,
        type: KERNEL_MESSAGE_TYPES.EFFECT,
        contextId: CONTEXT_ID,
        requestId: REQUEST_ID,
        method: "apps/install",
        effects: [{ effect: "ui", method: "open-surface", args: ["historia"] }],
        tentativeState: { apps: { installed: [{ id: "historia" }] } },
      }, resolve);
      assert.deepEqual(returns, [true]);
    });
    assert.equal((await effectReply).ok, true);
    return response({
      state: { apps: { installed: [{ id: "historia" }] } },
      globalRevision: 1,
      contextRevision: 1,
      result: {
        state: { apps: { installed: [{ id: "historia" }] } },
        effects: [],
      },
    });
  });
  client = new KernelClient({
    runtime,
    clientKind: "launcher",
    randomId: (() => {
      const ids = [CONTEXT_ID, REQUEST_ID];
      return () => ids.shift();
    })(),
    effects: {
      async run(effects, context) {
        if (effects.length) {
          order.push(["effect", context.session.state.apps.installed[0].id, effects[0].method]);
        } else {
          order.push(["dispatch-effects", effects.length]);
        }
      },
    },
  });
  client.subscribe((_state, event) => order.push(["listener", event.method]));

  const result = await client.dispatch("apps/install", [{ id: "historia" }]);
  assert.equal(result.state.apps.installed[0].id, "historia");
  assert.deepEqual(order, [
    ["listener", "app/bootstrap"],
    ["effect", "historia", "open-surface"],
    ["dispatch-effects", 0],
    ["listener", "apps/install"],
  ]);
  assert.equal(client.globalRevision, 1);
  assert.equal(client.contextRevision, 1);
});

test("broadcasts never regress revisions and foreign contexts merge only global installs", async () => {
  const runtime = new FakeRuntime(() => response({
    state: {
      value: "attached",
      apps: { installed: [{ id: "greenways-home" }] },
      surface: { active: "studio" },
    },
    globalRevision: 1,
    contextRevision: 1,
  }));
  const client = clientWith(runtime);
  const seen = [];
  client.subscribe((state) => seen.push({
    value: state.value,
    apps: state.apps.installed.map(({ id }) => id),
    surface: state.surface.active,
  }));
  await client.start();

  runtime.onMessage.emit({
    protocol: KERNEL_PROTOCOL,
    type: KERNEL_MESSAGE_TYPES.UPDATE,
    contextId: CONTEXT_ID,
    state: {
      value: "new",
      apps: { installed: [{ id: "greenways-home" }] },
      surface: { active: "studio" },
    },
    globalRevision: 4,
    contextRevision: 2,
  });
  runtime.onMessage.emit({
    protocol: KERNEL_PROTOCOL,
    type: KERNEL_MESSAGE_TYPES.UPDATE,
    contextId: CONTEXT_ID,
    state: {
      value: "stale-global",
      apps: { installed: [] },
      surface: { active: "foreign" },
    },
    globalRevision: 3,
    contextRevision: 3,
  });
  runtime.onMessage.emit({
    protocol: KERNEL_PROTOCOL,
    type: KERNEL_MESSAGE_TYPES.UPDATE,
    contextId: OTHER_CONTEXT_ID,
    state: { value: "foreign", surface: { active: "foreign" } },
    globalInstalled: [{ id: "greenways-home" }, { id: "historia" }],
    globalRevision: 5,
    contextRevision: 5,
  });

  assert.deepEqual(seen, [
    { value: "attached", apps: ["greenways-home"], surface: "studio" },
    { value: "new", apps: ["greenways-home"], surface: "studio" },
    { value: "new", apps: ["greenways-home", "historia"], surface: "studio" },
  ]);
  assert.equal(client.state.value, "new");
  assert.equal(client.state.surface.active, "studio");
  assert.equal(client.globalRevision, 5);
  assert.equal(client.contextRevision, 2);
});

test("a foreign app removal clears its active packaged surface but preserves non-app surfaces", async () => {
  const runtime = new FakeRuntime(() => response({
    state: {
      apps: {
        installed: [{ id: "greenways-home" }, { id: "hestia-connector" }],
        active: "hestia-connector",
      },
      surface: {
        active: "hestia-connector",
        payload: { appId: "hestia-connector" },
      },
    },
    globalRevision: 1,
    contextRevision: 2,
  }));
  const client = clientWith(runtime);
  await client.start();

  runtime.onMessage.emit({
    protocol: KERNEL_PROTOCOL,
    type: KERNEL_MESSAGE_TYPES.UPDATE,
    contextId: OTHER_CONTEXT_ID,
    globalInstalled: [{ id: "greenways-home" }],
    globalRevision: 2,
    contextRevision: 9,
  });

  assert.equal(client.state.apps.active, null);
  assert.deepEqual(client.state.surface, { active: null, payload: null });

  client.state = {
    ...client.state,
    surface: { active: "studio", payload: { id: "touchpoint/studio" } },
  };
  runtime.onMessage.emit({
    protocol: KERNEL_PROTOCOL,
    type: KERNEL_MESSAGE_TYPES.UPDATE,
    contextId: OTHER_CONTEXT_ID,
    globalInstalled: [{ id: "greenways-home" }, { id: "historia" }],
    globalRevision: 3,
    contextRevision: 10,
  });

  assert.equal(client.state.surface.active, "studio");
  assert.deepEqual(client.state.surface.payload, { id: "touchpoint/studio" });
});

test("targeted effect broadcasts use Chrome 116 sendResponse semantics", async () => {
  const effectCalls = [];
  const runtime = new FakeRuntime(() => response({ state: {}, globalRevision: 0, contextRevision: 0 }));
  const client = clientWith(runtime, { effectCalls });
  await client.start();

  const forgedReturns = runtime.onMessage.emit({
    protocol: KERNEL_PROTOCOL,
    type: KERNEL_MESSAGE_TYPES.EFFECT,
    contextId: CONTEXT_ID,
    requestId: "effect/forged",
    effects: [{ effect: "ui", method: "open-surface", args: ["forged"] }],
  }, () => {}, {
    id: RUNTIME_ID,
    documentId: "00000000-0000-4000-8000-000000000099",
    tab: { id: 99 },
  });
  assert.deepEqual(forgedReturns, [false]);
  assert.equal(effectCalls.length, 0);

  const reply = new Promise((resolve) => {
    const returns = runtime.onMessage.emit({
      protocol: KERNEL_PROTOCOL,
      type: KERNEL_MESSAGE_TYPES.EFFECT,
      contextId: CONTEXT_ID,
      requestId: "effect/one",
      method: "surface/open",
      effects: [{ effect: "ui", method: "open-surface", args: ["studio"] }],
      tentativeState: { surface: { active: "studio" } },
    }, resolve);
    assert.deepEqual(returns, [true]);
  });

  assert.deepEqual(await reply, { protocol: KERNEL_PROTOCOL, ok: true, requestId: "effect/one" });
  assert.equal(effectCalls.length, 1);
  assert.equal(effectCalls[0].context.session, client);
  assert.equal(effectCalls[0].effects[0].method, "open-surface");
  assert.equal(client.state.surface.active, "studio");
});

test("a rollback restores tentative state even when committed revisions did not advance", async () => {
  const effectCalls = [];
  const original = { apps: { installed: [] }, surface: { active: null } };
  const runtime = new FakeRuntime(() => response({
    state: original,
    globalRevision: 3,
    contextRevision: 7,
  }));
  const client = clientWith(runtime, { effectCalls });
  const events = [];
  client.subscribe((state, event) => events.push([state.surface.active, event.source]));
  await client.start();

  const effectReply = new Promise((resolve) => {
    const returns = runtime.onMessage.emit({
      protocol: KERNEL_PROTOCOL,
      type: KERNEL_MESSAGE_TYPES.EFFECT,
      contextId: CONTEXT_ID,
      requestId: "effect/rollback",
      method: "apps/open",
      effects: [{ effect: "ui", method: "open-surface", args: ["hestia-connector"] }],
      tentativeState: {
        apps: { installed: [{ id: "hestia-connector" }] },
        surface: { active: "hestia-connector" },
      },
    }, resolve);
    assert.deepEqual(returns, [true]);
  });
  assert.equal((await effectReply).ok, true);
  assert.equal(client.state.surface.active, "hestia-connector");

  runtime.onMessage.emit({
    protocol: KERNEL_PROTOCOL,
    type: KERNEL_MESSAGE_TYPES.UPDATE,
    contextId: CONTEXT_ID,
    rollback: true,
    state: original,
    globalRevision: 3,
    contextRevision: 7,
  });

  assert.equal(client.state.surface.active, null);
  assert.equal(client.globalRevision, 3);
  assert.equal(client.contextRevision, 7);
  assert.deepEqual(events, [[null, "attach"], [null, "rollback"]]);
});

test("an explicit refresh replaces tentative state at the same committed revisions", async () => {
  const original = { apps: { installed: [] }, surface: { active: null } };
  const runtime = new FakeRuntime(() => response({
    state: original,
    globalRevision: 3,
    contextRevision: 7,
  }));
  const client = clientWith(runtime);
  const events = [];
  client.subscribe((state, event) => events.push([state.surface.active, event.source]));
  await client.start();

  const effectReply = new Promise((resolve) => {
    runtime.onMessage.emit({
      protocol: KERNEL_PROTOCOL,
      type: KERNEL_MESSAGE_TYPES.EFFECT,
      contextId: CONTEXT_ID,
      requestId: "effect/interrupted",
      method: "apps/open",
      effects: [{ effect: "ui", method: "open-surface", args: ["hestia-connector"] }],
      tentativeState: {
        apps: { installed: [{ id: "hestia-connector" }] },
        surface: { active: "hestia-connector" },
      },
    }, resolve);
  });
  assert.equal((await effectReply).ok, true);
  assert.equal(client.state.surface.active, "hestia-connector");

  runtime.onMessage.emit({
    protocol: KERNEL_PROTOCOL,
    type: KERNEL_MESSAGE_TYPES.UPDATE,
    contextId: CONTEXT_ID,
    state: { apps: { installed: [] }, surface: { active: "stale-broadcast" } },
    globalRevision: 3,
    contextRevision: 7,
  });
  assert.equal(client.state.surface.active, "hestia-connector");

  assert.deepEqual(await client.refresh(), original);
  assert.equal(client.state.surface.active, null);
  assert.equal(client.globalRevision, 3);
  assert.equal(client.contextRevision, 7);
  assert.deepEqual(events, [[null, "attach"], [null, "refresh"]]);
});

test("an explicit refresh still rejects any older revision", async () => {
  let attach = 0;
  const current = { value: "current" };
  const runtime = new FakeRuntime(() => {
    attach += 1;
    if (attach === 1) return response({ state: current, globalRevision: 3, contextRevision: 7 });
    if (attach === 2) return response({ state: { value: "older-global" }, globalRevision: 2, contextRevision: 8 });
    return response({ state: { value: "older-context" }, globalRevision: 4, contextRevision: 6 });
  });
  const client = clientWith(runtime);
  const events = [];
  client.subscribe((state, event) => events.push([state.value, event.source]));
  await client.start();

  assert.deepEqual(await client.refresh(), current);
  assert.deepEqual(await client.refresh(), current);
  assert.deepEqual(client.state, current);
  assert.equal(client.globalRevision, 3);
  assert.equal(client.contextRevision, 7);
  assert.deepEqual(events, [["current", "attach"]]);
});

test("destroy removes broadcast handling and rejects later work", async () => {
  const runtime = new FakeRuntime(() => response({ state: {}, globalRevision: 0, contextRevision: 0 }));
  const client = clientWith(runtime);
  await client.start();
  assert.equal(runtime.onMessage.listeners.size, 1);

  client.destroy();
  assert.equal(runtime.onMessage.listeners.size, 0);
  await assert.rejects(client.call("app/capabilities"), /destroyed/);
  await assert.rejects(client.dispatch("surface/close"), /destroyed/);
});

test("validates versioned failure responses", () => {
  assert.throws(() => validateKernelResponse(undefined), /returned no response/);
  assert.throws(() => validateKernelResponse({ protocol: "other/1", ok: true }), /unsupported protocol/);
  let error;
  try {
    validateKernelResponse({
      protocol: KERNEL_PROTOCOL,
      ok: false,
      code: "APP_NOT_INSTALLED",
      error: "App is not installed",
    });
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /App is not installed/);
  assert.equal(error.code, "APP_NOT_INSTALLED");
});
