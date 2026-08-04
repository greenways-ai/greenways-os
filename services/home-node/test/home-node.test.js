import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  HomeLinkClient,
  createHomeDevice,
  createHomeLinkRecord,
  createSignedHomeRequest,
  normalizeHomeDiscovery,
  normalizeHomeOrigin,
  normalizeServiceDescriptor,
  verifyHomeNodeRecord,
} from "../../../extension/src/home-link-client.js";
import { GreenwaysHomeNode, HomeNodeError } from "../src/home-node.js";
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

test("home origins require HTTPS away from loopback", () => {
  assert.equal(normalizeHomeOrigin("http://127.0.0.1:58100"), "http://127.0.0.1:58100");
  assert.equal(normalizeHomeOrigin("https://home.example"), "https://home.example");
  assert.throws(() => normalizeHomeOrigin("http://192.168.1.20:58100"), /must use HTTPS/);
  assert.throws(() => normalizeHomeOrigin("https://home.example/path"), /only the home server origin/);
});

test("home discovery is signed inert metadata, not a remote app manifest", async () => {
  const node = new GreenwaysHomeNode({ id: "home.one", name: "Home One", services });
  const discovery = normalizeHomeDiscovery(node.discovery());
  await verifyHomeNodeRecord(discovery, null, webcrypto);
  assert.deepEqual(discovery.services.map(({ id }) => id), ["hestia", "historia"]);
  assert.throws(
    () => normalizeServiceDescriptor({ ...services[0], url: "https://home.example/hestia.js" }),
    /unsupported field url/,
  );
  assert.throws(
    () => normalizeHomeDiscovery({ ...discovery, executable: "https://home.example/app.js" }),
    /unsupported field executable/,
  );
  const tampered = normalizeHomeDiscovery({
    ...discovery,
    pairing: { available: !discovery.pairing.available },
  });
  await assert.rejects(
    verifyHomeNodeRecord(tampered, null, webcrypto),
    /signature is invalid/,
  );
});

test("browser devices keep a non-extractable signing key", async () => {
  const device = await createHomeDevice("Test browser", webcrypto);
  assert.match(device.id, /^browser\.[0-9a-f]{32}$/);
  assert.equal(device.privateKey.extractable, false);
  assert.equal(device.privateKey.type, "private");
  assert.equal(device.publicKey.d, undefined);
  await assert.rejects(
    webcrypto.subtle.exportKey("jwk", device.privateKey),
    /not extractable/i,
  );
});

test("home HTTP boundary accepts extension origins and rejects ordinary web origins", async (t) => {
  const node = new GreenwaysHomeNode({ id: "home.cors", name: "CORS Home", services });
  node.issuePairingCode();
  const app = createHomeNodeServer({ node, host: "127.0.0.1", port: 0 });
  await app.listen();
  t.after(() => app.close());

  const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const accepted = await fetch(`${app.origin}/.well-known/greenways-home`, {
    headers: { origin: extensionOrigin },
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("access-control-allow-origin"), extensionOrigin);

  const denied = await fetch(`${app.origin}/.well-known/greenways-home`, {
    headers: { origin: "https://unrelated.example" },
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "browser-origin-required");
});

test("two browsers pair by one-time code and authenticate without bearer secrets", async (t) => {
  const node = new GreenwaysHomeNode({ id: "home.test", name: "Test Home", services });
  const app = createHomeNodeServer({ node, host: "127.0.0.1", port: 0 });
  await app.listen();
  t.after(() => app.close());
  const client = new HomeLinkClient({ origin: app.origin, cryptoProvider: webcrypto });

  const firstCode = node.issuePairingCode().code;
  const firstDiscovery = await client.discover();
  const firstDevice = await createHomeDevice("Office browser", webcrypto);
  const firstReceipt = await client.pair({ code: firstCode, device: firstDevice, node: firstDiscovery.node });
  const first = createHomeLinkRecord({ origin: app.origin, receipt: firstReceipt, device: firstDevice });
  assert.equal(first.node.id, "home.test");
  assert.equal(first.scopes.includes("presence.read"), true);

  await assert.rejects(
    client.pair({ code: firstCode, device: await createHomeDevice("Replay browser", webcrypto), node: firstDiscovery.node }),
    /pairing failed: 409/,
  );

  const secondCode = node.issuePairingCode().code;
  const secondDiscovery = await client.discover();
  const secondDevice = await createHomeDevice("Laptop browser", webcrypto);
  const secondReceipt = await client.pair({ code: secondCode, device: secondDevice, node: secondDiscovery.node });
  const second = createHomeLinkRecord({ origin: app.origin, receipt: secondReceipt, device: secondDevice });

  const status = await client.status(first, { visible: true });
  assert.equal(status.browsers.length, 2);
  assert.equal(status.browsers.find(({ id }) => id === first.device.id).current, true);
  assert.equal(status.services.length, 2);

  const signed = await createSignedHomeRequest({
    device: first.device,
    method: "POST",
    path: "/greenways/v1/status",
    body: { protocol: "greenways-home-presence/1" },
    nonce: "nonce/replay-check",
    cryptoProvider: webcrypto,
  });
  await node.status(signed);
  await assert.rejects(node.status(signed), (error) => (
    error instanceof HomeNodeError && error.status === 409 && error.code === "replayed-request"
  ));
  const untampered = await createSignedHomeRequest({
    device: first.device,
    method: "POST",
    path: "/greenways/v1/status",
    body: { protocol: "greenways-home-presence/1" },
    nonce: "nonce/body-check",
    cryptoProvider: webcrypto,
  });
  await assert.rejects(
    node.status({ ...untampered, body: { protocol: "greenways-home-presence/1", changed: true } }),
    (error) => error instanceof HomeNodeError && error.code === "body-modified",
  );

  await client.unpair(second);
  const after = await client.status(first);
  assert.deepEqual(after.browsers.map(({ name }) => name), ["Office browser"]);
});
