import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_BRIDGE_RESULT_PROTOCOL,
  BROWSER_BRIDGE_STATUS_PROTOCOL,
  DaemonNativeBridge,
  classifyNativeDisconnect,
  validateBridgeStatus,
} from "../src/daemon-bridge.js";

const DIGEST = `sha256:${"0".repeat(64)}`;

function connectedStatus() {
  return {
    protocol: BROWSER_BRIDGE_STATUS_PROTOCOL,
    state: "connected",
    daemon: {
      protocol: "greenways-daemon-status/0-alpha",
      nodeId: "node/test",
      daemonVersion: "0.1.0",
      localProtocol: "greenways-local/0-alpha",
      generation: 2,
      stateRevision: 4,
      startedAtUnixMs: 1,
      observedAtUnixMs: 2,
      profileMode: "desktop",
      authorityMode: "daemon",
    },
    actor: {
      protocol: "greenways-local-client/0-alpha",
      id: "local/client/test",
      role: "browser-bridge",
      label: "Chrome browser bridge",
      createdAtUnixMs: 1,
      revokedAtUnixMs: null,
    },
    identity: {
      protocol: "greenways-profile-identity/0-alpha",
      id: "identity/test",
      handle: "chris",
      keyId: DIGEST,
      algorithm: "p256-sha256-fixed",
      createdAtUnixMs: 1,
    },
    session: {
      protocol: "greenways-local-session/0-alpha",
      clientId: "local/client/test",
      role: "browser-bridge",
      label: "Chrome browser bridge",
      openedAtUnixMs: 1,
      expiresAtUnixMs: 10,
      remainingRequests: 120,
    },
    error: null,
    observedAtUnixMs: 2,
  };
}

function fakePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  return {
    sent: [],
    disconnected: false,
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(message) { this.sent.push(message); },
    disconnect() { this.disconnected = true; },
    emit(message) { for (const listener of messageListeners) listener(message); },
    drop() { for (const listener of disconnectListeners) listener(); },
  };
}

test("validates the exact redacted connected snapshot", () => {
  const status = validateBridgeStatus(connectedStatus());
  assert.equal(status.state, "connected");
  assert.equal(status.identity.handle, "chris");
  assert.throws(() => validateBridgeStatus({
    ...connectedStatus(),
    session: { ...connectedStatus().session, id: "local/session/secret" },
  }), /session projection/);
});

test("connects through the exact native host and publishes status", async () => {
  const port = fakePort();
  const runtime = { id: "a".repeat(32), connectNative: (host) => {
    assert.equal(host, "ai.greenways.browser_bridge");
    return port;
  } };
  const bridge = new DaemonNativeBridge({
    runtime,
    random: { randomUUID: () => "01234567-89ab-cdef-0123-456789abcdef" },
    requestTimeoutMs: 1000,
  });
  const updates = [];
  bridge.subscribe((status) => updates.push(status.state));
  const pending = bridge.connect();
  assert.equal(port.sent.length, 1);
  assert.equal(port.sent[0].command, "connect");
  port.emit({
    protocol: BROWSER_BRIDGE_RESULT_PROTOCOL,
    type: "response",
    id: port.sent[0].id,
    ok: true,
    status: connectedStatus(),
    error: null,
  });
  const status = await pending;
  assert.equal(status.state, "connected");
  assert.deepEqual(updates, ["disconnected", "connecting", "connected"]);
});

test("classifies a missing installed native host distinctly", () => {
  assert.equal(classifyNativeDisconnect("Specified native messaging host not found."), "native-host-unavailable");
  assert.equal(classifyNativeDisconnect("Native host exited."), "disconnected");
});
