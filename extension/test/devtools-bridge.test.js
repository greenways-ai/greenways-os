import assert from "node:assert/strict";
import test from "node:test";
import {
  DEVTOOLS_BRIDGE_PROTOCOL,
  DevtoolsNativeBridge,
} from "../src/devtools-bridge.js";

function eventPort() {
  const messages = [];
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    messages,
    messageListeners,
    disconnectListeners,
    disconnected: false,
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    postMessage(message) { messages.push(message); },
    disconnect() { this.disconnected = true; },
    emit(message) { for (const listener of messageListeners) listener(message); },
    close() { for (const listener of disconnectListeners) listener(); },
  };
}

function deterministicCrypto() {
  return { getRandomValues(bytes) { bytes.fill(7); return bytes; } };
}

test("starts an authenticated loopback bridge and reveals its token only to DevTools", async () => {
  const port = eventPort();
  const runtime = { connectNative: () => port, lastError: null };
  const bridge = new DevtoolsNativeBridge({
    runtime,
    random: deterministicCrypto(),
    handleRequest: async () => ({ ready: true }),
    readyTimeoutMs: 100,
  });
  const pending = bridge.start({ port: 46379 });
  assert.equal(port.messages[0].type, "configure");
  assert.equal(port.messages[0].address, "127.0.0.1");
  assert.match(port.messages[0].token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(bridge.snapshot().token, null);
  port.emit({ protocol: DEVTOOLS_BRIDGE_PROTOCOL, type: "ready", address: "127.0.0.1", port: 46379, clients: 0 });
  const active = await pending;
  assert.equal(active.state, "active");
  assert.equal(active.address, "127.0.0.1");
  assert.equal(active.token, port.messages[0].token);
  assert.equal(bridge.snapshot().token, null);
});

test("forwards only allowlisted native requests and returns bounded responses", async () => {
  const port = eventPort();
  const received = [];
  const bridge = new DevtoolsNativeBridge({
    runtime: { connectNative: () => port, lastError: null },
    random: deterministicCrypto(),
    handleRequest: async (request) => { received.push(request); return { output: "42" }; },
    readyTimeoutMs: 100,
  });
  const pending = bridge.start();
  port.emit({ protocol: DEVTOOLS_BRIDGE_PROTOCOL, type: "ready", address: "127.0.0.1", port: 46379, clients: 0 });
  await pending;
  await port.emit({
    protocol: DEVTOOLS_BRIDGE_PROTOCOL,
    type: "request",
    id: "resp/request-0001",
    command: "eval",
    payload: { namespace: "gw.devtools", source: "(+ 20 22)" },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received.length, 1);
  assert.deepEqual(port.messages.at(-1), {
    protocol: DEVTOOLS_BRIDGE_PROTOCOL,
    type: "response",
    id: "resp/request-0001",
    ok: true,
    result: { output: "42" },
  });

  port.emit({
    protocol: DEVTOOLS_BRIDGE_PROTOCOL,
    type: "request",
    id: "resp/request-0002",
    command: "shell",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(bridge.snapshot().error, /not allowlisted/);
});

test("stopping invalidates the session token", async () => {
  const port = eventPort();
  const bridge = new DevtoolsNativeBridge({
    runtime: { connectNative: () => port, lastError: null },
    random: deterministicCrypto(),
    handleRequest: async () => null,
    readyTimeoutMs: 100,
  });
  const pending = bridge.start();
  port.emit({ protocol: DEVTOOLS_BRIDGE_PROTOCOL, type: "ready", address: "127.0.0.1", port: 46379, clients: 1 });
  await pending;
  const stopped = bridge.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.token, null);
  assert.equal(port.disconnected, true);
  assert.equal(port.messages.at(-1).type, "shutdown");
});


test("rejects a native host that reports a different listening endpoint", async () => {
  const port = eventPort();
  const runtime = { connectNative: () => port, lastError: null };
  const bridge = new DevtoolsNativeBridge({ runtime, handleRequest: async () => null, readyTimeoutMs: 50 });
  const started = bridge.start({ port: 46379 });
  port.emit({
    protocol: DEVTOOLS_BRIDGE_PROTOCOL,
    type: "ready",
    address: "127.0.0.1",
    port: 46380,
    clients: 0,
  });
  await assert.rejects(started, /unexpected listening endpoint/);
  assert.equal(bridge.snapshot().state, "failed");
  assert.equal(bridge.snapshot().token, null);
});
