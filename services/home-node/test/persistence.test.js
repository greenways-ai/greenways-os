import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  HomeLinkClient,
  createHomeDevice,
  createHomeLinkRecord,
  createSignedHomeRequest,
} from "../../../extension/src/home-link-client.js";
import { HomeNodeError } from "../src/home-node.js";
import {
  HOME_NODE_STATE_PROTOCOL,
  createPersistentHomeNode,
} from "../src/persistent-home-node.js";
import { createHomeNodeServer } from "../src/server.js";

const services = [
  {
    id: "hestia",
    name: "Hestia",
    kind: "evidence",
    version: "1",
    capabilities: ["evidence.sync"],
    status: "available",
  },
  {
    id: "historia",
    name: "Historia",
    kind: "memory",
    version: "1",
    capabilities: ["history.import"],
    status: "available",
  },
];

function temporaryState(t) {
  const root = mkdtempSync(join(tmpdir(), "greenways-home-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "private", "state.json");
}

test("persists node identity, browser grants, and replay nonces across restarts", async (t) => {
  const statePath = temporaryState(t);
  const firstNode = createPersistentHomeNode({
    statePath,
    id: "home.persistence-test",
    name: "Persistent Test Home",
    services,
    cryptoProvider: webcrypto,
  });
  const firstServer = createHomeNodeServer({ node: firstNode, host: "127.0.0.1", port: 0 });
  await firstServer.listen();

  const origin = firstServer.origin;
  const port = Number(new URL(origin).port);
  const firstClient = new HomeLinkClient({ origin, cryptoProvider: webcrypto });
  const pairingCode = firstNode.issuePairingCode().code;
  const discovery = await firstClient.discover();
  const device = await createHomeDevice("Persistent browser", webcrypto);
  const receipt = await firstClient.pair({ code: pairingCode, device, node: discovery.node });
  const connection = createHomeLinkRecord({ origin, receipt, device });

  const replayCandidate = await createSignedHomeRequest({
    device: connection.device,
    method: "POST",
    path: "/greenways/v1/status",
    body: { protocol: "greenways-home-presence/1", visible: true },
    nonce: "nonce/restart-replay",
    cryptoProvider: webcrypto,
  });
  await firstNode.status(replayCandidate);
  const keyId = firstNode.node.keyId;
  await firstServer.close();

  const written = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(written.protocol, HOME_NODE_STATE_PROTOCOL);
  assert.equal(written.node.keyId, keyId);
  assert.equal(written.devices.length, 1);
  assert.equal(written.usedNonces.some(({ key }) => key.endsWith(":nonce/restart-replay")), true);
  assert.equal(Object.hasOwn(written, "pairing"), false);
  if (process.platform !== "win32") {
    assert.equal(statSync(statePath).mode & 0o077, 0);
  }

  const secondNode = createPersistentHomeNode({
    statePath,
    services,
    cryptoProvider: webcrypto,
  });
  assert.equal(secondNode.node.keyId, keyId);
  assert.equal(secondNode.devices.size, 1);
  assert.equal(secondNode.pairingAvailable(), false);
  await assert.rejects(
    secondNode.status(replayCandidate),
    (error) => error instanceof HomeNodeError && error.code === "replayed-request",
  );

  const secondServer = createHomeNodeServer({
    node: secondNode,
    host: "127.0.0.1",
    port,
  });
  await secondServer.listen();
  try {
    assert.equal(secondServer.origin, origin);
    const secondClient = new HomeLinkClient({ origin, cryptoProvider: webcrypto });
    const status = await secondClient.status(connection, { visible: true });
    assert.equal(status.node.keyId, keyId);
    assert.deepEqual(status.browsers.map(({ name }) => name), ["Persistent browser"]);
    await secondClient.unpair(connection);
  } finally {
    await secondServer.close();
  }

  const thirdNode = createPersistentHomeNode({
    statePath,
    services,
    cryptoProvider: webcrypto,
  });
  assert.equal(thirdNode.node.keyId, keyId);
  assert.equal(thirdNode.devices.size, 0);
});

test("fails closed on identity drift, public-key tampering, and exposed state files", (t) => {
  const statePath = temporaryState(t);
  const node = createPersistentHomeNode({
    statePath,
    id: "home.fixed-identity",
    name: "Fixed Identity Home",
    services,
    cryptoProvider: webcrypto,
  });
  assert.match(node.node.keyId, /^sha256:[0-9a-f]{64}$/);

  assert.throws(
    () => createPersistentHomeNode({
      statePath,
      id: "home.different-identity",
      services,
      cryptoProvider: webcrypto,
    }),
    /does not match persisted id/,
  );

  if (process.platform !== "win32") {
    chmodSync(statePath, 0o644);
    assert.throws(
      () => createPersistentHomeNode({ statePath, services, cryptoProvider: webcrypto }),
      /must not grant group or world access/,
    );
    chmodSync(statePath, 0o600);
  }

  const tampered = JSON.parse(readFileSync(statePath, "utf8"));
  tampered.node.keyId = `sha256:${"0".repeat(64)}`;
  writeFileSync(statePath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
  assert.throws(
    () => createPersistentHomeNode({ statePath, services, cryptoProvider: webcrypto }),
    /public identity does not match its private key/,
  );
});
