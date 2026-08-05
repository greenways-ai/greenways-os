import assert from "node:assert/strict";
import test from "node:test";
import {
  main,
  normalizeHomeNodeAdminOrigin,
  parseHomeNodeArguments,
  runHomeNodeCli,
} from "../src/cli.js";
import { createHomeNodeServer } from "../src/server.js";

const TEST_NOW = "2026-08-05T00:00:00.000Z";

function captureStream() {
  let output = "";
  return {
    stream: {
      write(value) {
        output += String(value);
        return true;
      },
    },
    read() {
      return output;
    },
  };
}

function fakeNode() {
  let sequence = 0;
  const now = new Date(TEST_NOW);
  return {
    node: {
      id: "home.test",
      name: "Cedar Home",
      algorithm: "ECDSA-P256-SHA256",
      keyId: "sha256:cedar-home",
    },
    statePath: "/private/cedar/state.json",
    services: [
      {
        id: "historia",
        name: "Historia",
        kind: "memory",
        version: "1",
        capabilities: ["history.import"],
        status: "available",
      },
    ],
    devices: new Map([["browser.office", {
      id: "browser.office",
      name: "Office browser",
      publicKey: { kty: "EC", crv: "P-256", x: "private-from-admin", y: "private-from-admin" },
      pairedAt: TEST_NOW,
      lastSeenAt: TEST_NOW,
    }]]),
    usedNonces: new Map([["browser.office:nonce/used", now.getTime()]]),
    pairing: null,
    now: () => new Date(TEST_NOW),
    pairingAvailable() {
      return Boolean(this.pairing && new Date(this.pairing.expiresAt).getTime() >= now.getTime());
    },
    issuePairingCode() {
      sequence += 1;
      this.pairing = {
        code: `CEDAR-${sequence}`,
        issuedAt: TEST_NOW,
        expiresAt: "2026-08-05T00:10:00.000Z",
      };
      return this.pairing;
    },
    persistState() {},
    discovery() {
      return {
        protocol: "greenways-home/1",
        node: this.node,
        pairing: { available: this.pairingAvailable() },
        services: this.services,
      };
    },
  };
}

async function startNode() {
  const node = fakeNode();
  const app = createHomeNodeServer({ node, host: "127.0.0.1", port: 0 });
  await app.listen();
  return { app, node };
}

test("parses commands and restricts administration to a loopback origin", () => {
  assert.deepEqual(
    parseHomeNodeArguments(["status", "--json", "--port=58101"]),
    {
      command: "status",
      options: {
        json: true,
        help: false,
        version: false,
        port: "58101",
      },
      operands: [],
    },
  );
  assert.equal(normalizeHomeNodeAdminOrigin("http://127.0.0.1:58100"), "http://127.0.0.1:58100");
  assert.equal(normalizeHomeNodeAdminOrigin("http://localhost:58100"), "http://localhost:58100");
  assert.throws(
    () => normalizeHomeNodeAdminOrigin("https://home.example"),
    /loopback HTTP/,
  );
  assert.throws(
    () => normalizeHomeNodeAdminOrigin("http://192.168.1.50:58100"),
    /loopback only/,
  );
  assert.throws(
    () => normalizeHomeNodeAdminOrigin("http://127.0.0.1:58100/admin"),
    /without credentials or a path/,
  );
});

test("reports status and manages pairing, devices, services, and revocation", async (t) => {
  const { app, node } = await startNode();
  t.after(() => app.close());

  const statusOutput = captureStream();
  assert.equal(await runHomeNodeCli([
    "status",
    "--origin",
    app.origin,
    "--json",
  ], { stdout: statusOutput.stream }), 0);
  const status = JSON.parse(statusOutput.read());
  assert.equal(status.origin, app.origin);
  assert.equal(status.node.name, "Cedar Home");
  assert.equal(status.browsers.length, 1);
  assert.equal(status.browsers[0].publicKey, undefined);
  assert.equal(status.statePath, undefined);

  const pairingOutput = captureStream();
  assert.equal(await runHomeNodeCli([
    "pair",
    "--origin",
    app.origin,
    "--json",
  ], { stdout: pairingOutput.stream }), 0);
  const pairing = JSON.parse(pairingOutput.read());
  assert.equal(pairing.code, "CEDAR-1");

  const deviceOutput = captureStream();
  assert.equal(await runHomeNodeCli([
    "devices",
    "--origin",
    app.origin,
    "--json",
  ], { stdout: deviceOutput.stream }), 0);
  assert.deepEqual(JSON.parse(deviceOutput.read()).map((device) => device.id), ["browser.office"]);

  const serviceOutput = captureStream();
  assert.equal(await runHomeNodeCli([
    "services",
    "--origin",
    app.origin,
    "--json",
  ], { stdout: serviceOutput.stream }), 0);
  assert.deepEqual(JSON.parse(serviceOutput.read()).map((service) => service.id), ["historia"]);

  const revokeOutput = captureStream();
  assert.equal(await runHomeNodeCli([
    "revoke",
    "browser.office",
    "--origin",
    app.origin,
    "--json",
  ], { stdout: revokeOutput.stream }), 0);
  const revoked = JSON.parse(revokeOutput.read());
  assert.equal(revoked.deviceId, "browser.office");
  assert.equal(node.devices.has("browser.office"), false);
  assert.equal(node.usedNonces.has("browser.office:nonce/used"), false);
});

test("opens the local control plane without exposing a non-loopback URL", async () => {
  const output = captureStream();
  let opened = null;
  const result = await runHomeNodeCli([
    "open",
    "--origin",
    "http://127.0.0.1:58100",
  ], {
    stdout: output.stream,
    openExternal: async (url) => {
      opened = url;
    },
  });
  assert.equal(result, 0);
  assert.equal(opened, "http://127.0.0.1:58100/admin");
  assert.match(output.read(), /Opened http:\/\/127\.0\.0\.1:58100\/admin/);
});

test("maps run options onto the durable daemon environment", async () => {
  let received = null;
  const output = captureStream();
  const result = await runHomeNodeCli([
    "run",
    "--host",
    "127.0.0.1",
    "--port",
    "59000",
    "--state-path",
    "/tmp/greenways-home-state.json",
    "--name",
    "Cedar Home",
    "--id",
    "home.cedar",
  ], {
    env: { PRESERVE_ME: "yes" },
    stdout: output.stream,
    runNode: async (options) => {
      received = options;
    },
  });
  assert.equal(result, 0);
  assert.deepEqual(received.env, {
    PRESERVE_ME: "yes",
    HOST: "127.0.0.1",
    PORT: "59000",
    GREENWAYS_HOME_STATE_PATH: "/tmp/greenways-home-state.json",
    GREENWAYS_HOME_NAME: "Cedar Home",
    GREENWAYS_HOME_ID: "home.cedar",
  });
});

test("returns a concise non-zero result for unsafe or unreachable administration", async () => {
  const stderr = captureStream();
  assert.equal(await main([
    "status",
    "--origin",
    "https://home.example",
  ], { stderr: stderr.stream }), 2);
  assert.match(stderr.read(), /loopback HTTP/);

  const unavailable = captureStream();
  assert.equal(await main([
    "status",
    "--origin",
    "http://127.0.0.1:9",
  ], { stderr: unavailable.stream }), 3);
  assert.match(unavailable.read(), /not reachable/);
});
