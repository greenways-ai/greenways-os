import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_BRIDGE_PROTOCOL,
  BROWSER_BRIDGE_RESULT_PROTOCOL,
  BrowserBridgeHost,
  validateBridgeRequest,
} from "../src/host.js";

const request = (command) => ({
  protocol: BROWSER_BRIDGE_PROTOCOL,
  type: "request",
  id: `bridge/request/${command}00000001`,
  command,
});

const projection = {
  daemon: { protocol: "greenways-daemon-status/0-alpha", nodeId: "node/test" },
  actor: { protocol: "greenways-local-client/0-alpha", role: "browser-bridge" },
  identity: null,
  session: { protocol: "greenways-local-session/0-alpha", role: "browser-bridge" },
};

test("accepts only the three closed native commands", () => {
  assert.equal(validateBridgeRequest(request("connect")).command, "connect");
  assert.throws(() => validateBridgeRequest({ ...request("connect"), command: "invoke" }), {
    code: "protocol-mismatch",
  });
  assert.throws(() => validateBridgeRequest({ ...request("status"), extra: true }), {
    code: "protocol-mismatch",
  });
});

test("connects, refreshes, and disconnects without projecting credentials", async () => {
  let closed = 0;
  let snapshots = 0;
  const connection = {
    async snapshot() { snapshots += 1; return projection; },
    close() { closed += 1; },
  };
  const host = new BrowserBridgeHost({
    socketPath: "/tmp/greenwaysd.sock",
    credentialPath: "/tmp/browser-bridge.json",
    now: () => 123,
    connectDaemon: async () => ({ connection, snapshot: projection }),
  });

  const connected = await host.handle(request("connect"));
  assert.equal(connected.protocol, BROWSER_BRIDGE_RESULT_PROTOCOL);
  assert.equal(connected.ok, true);
  assert.equal(connected.status.state, "connected");
  assert.equal(JSON.stringify(connected).includes("token"), false);

  const refreshed = await host.handle(request("status"));
  assert.equal(refreshed.status.state, "connected");
  assert.equal(snapshots, 1);

  const disconnected = await host.handle(request("disconnect"));
  assert.equal(disconnected.status.state, "disconnected");
  assert.equal(closed, 1);
});

test("contains daemon failures behind bounded connection states", async () => {
  const host = new BrowserBridgeHost({
    socketPath: "/tmp/greenwaysd.sock",
    credentialPath: "/tmp/browser-bridge.json",
    now: () => 123,
    connectDaemon: async () => {
      const error = new Error("socket unavailable");
      error.code = "daemon-unavailable";
      throw error;
    },
  });
  const result = await host.handle(request("connect"));
  assert.equal(result.ok, true);
  assert.equal(result.status.state, "daemon-unavailable");
  assert.equal(result.status.error.code, "daemon-unavailable");
});
