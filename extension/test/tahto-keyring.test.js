import assert from "node:assert/strict";
import test from "node:test";
import { canonical, sha256 } from "../src/protocol.js";
import {
  TAHTO_DEVICE_REQUEST_PROTOCOL,
  TAHTO_KEY_ALGORITHM,
  TAHTO_PAIRING_INTENT_PROTOCOL,
  TAHTO_SIGNATURE_PROTOCOL,
  TahtoKeyring,
  publicJwkToSec1,
} from "../src/tahto-keyring.js";

function repository() {
  const records = new Map();
  return {
    records,
    get: async (store, key) => records.get(`${store}:${key}`),
    put: async (store, key, value) => { records.set(`${store}:${key}`, value); },
    delete: async (store, key) => { records.delete(`${store}:${key}`); },
  };
}

function decodeBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

test("creates one non-extractable P-256 device key per Tahto origin", async () => {
  const repo = repository();
  const keyring = new TahtoKeyring({ repository: repo, now: () => "2026-08-09T00:00:00.000Z" });
  const local = await keyring.create("http://127.0.0.1:58100");
  const remote = await keyring.create("https://tahto.example");
  assert.equal(local.algorithm, TAHTO_KEY_ALGORITHM);
  assert.equal(local.privateKeyExtractable, false);
  assert.equal("privateKey" in local, false);
  assert.notEqual(local.keyId, remote.keyId);
  assert.equal(publicJwkToSec1(local.publicKeyJwk).length, 65);
  assert.equal(publicJwkToSec1(local.publicKeyJwk)[0], 4);
  await assert.rejects(
    () => crypto.subtle.exportKey("jwk", repo.records.get("identity:tahto:http://127.0.0.1:58100").privateKey),
  );
  await assert.rejects(() => keyring.create("http://127.0.0.1:58100"), /already exists/);
});

test("binds a device identity and signs the exact canonical request envelope", async () => {
  const repo = repository();
  const keyring = new TahtoKeyring({ repository: repo, now: () => "2026-08-09T00:00:00.000Z" });
  await keyring.create("https://tahto.example");
  const key = await keyring.bind("https://tahto.example", { deviceId: "device.browser-a", nodeId: "node.home" });
  const signed = await keyring.signRequest("https://tahto.example", {
    operation: "semantic.read",
    application: "app.example",
    namespace: "profile.primary",
    collection: "archive",
    payload: { stableId: "document/main", limit: 32 },
  }, {
    nonce: "nonce-0123456789abcdef",
    idempotencyKey: "request-0123456789abcdef",
  });
  assert.equal(signed.protocol, TAHTO_DEVICE_REQUEST_PROTOCOL);
  assert.equal(signed.device, "device.browser-a");
  assert.equal(signed.publicKey, key.publicKey);
  assert.equal(signed.timestampSeconds, 1786233600);
  assert.equal(signed.signature.profile, TAHTO_SIGNATURE_PROTOCOL);
  assert.equal(signed.signature.algorithm, TAHTO_KEY_ALGORITHM);
  const { requestDigest: ignoredDigest, signature, ...unsigned } = signed;
  assert.equal(ignoredDigest.startsWith("sha256:"), true);
  const imported = await crypto.subtle.importKey(
    "jwk",
    key.publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert.equal(await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    imported,
    decodeBase64Url(signature.value),
    new TextEncoder().encode(`${TAHTO_DEVICE_REQUEST_PROTOCOL}\n${signed.requestDigest}`),
  ), true);
  assert.equal(canonical(unsigned).includes("semantic.read"), true);
});

test("signs only the exact server pairing intent with the unbound device key", async () => {
  const repo = repository();
  const keyring = new TahtoKeyring({ repository: repo, now: () => "2026-08-09T00:00:00.000Z" });
  const key = await keyring.create("https://tahto.example");
  const intent = {
    protocol: TAHTO_PAIRING_INTENT_PROTOCOL,
    invitation: "invite.live",
    node: "node.home",
    device: `device.${key.keyId.slice(7, 31)}`,
    "public-key": key.publicKey,
    algorithm: key.algorithm,
    "prepared-at": "2026-08-09T00:00:00.000Z",
    "expires-at": "2026-08-09T00:10:00.000Z",
  };
  const intentDigest = await sha256(canonical(intent));
  const signature = await keyring.signPairingIntent("https://tahto.example", intent, intentDigest);
  const imported = await crypto.subtle.importKey(
    "jwk", key.publicKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
  );
  assert.equal(await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, imported, decodeBase64Url(signature.value),
    new TextEncoder().encode(`${TAHTO_PAIRING_INTENT_PROTOCOL}\n${intentDigest}`),
  ), true);
  await assert.rejects(
    () => keyring.signPairingIntent("https://tahto.example", { ...intent, node: "node.other" }, intentDigest),
    /digest does not match/,
  );
});

test("requires pairing and rejects secret-shaped or non-portable signing payloads", async () => {
  const keyring = new TahtoKeyring({ repository: repository(), now: () => "2026-08-09T00:00:00.000Z" });
  await keyring.create("https://tahto.example");
  await assert.rejects(
    () => keyring.signRequest("https://tahto.example", {
      operation: "semantic.read",
      application: "app.example",
      namespace: "profile.primary",
      collection: "archive",
      payload: {},
    }),
    /not paired/,
  );
  await keyring.bind("https://tahto.example", { deviceId: "device.browser-a", nodeId: "node.home" });
  await assert.rejects(
    () => keyring.signRequest("https://tahto.example", {
      operation: "semantic.read",
      application: "app.example",
      namespace: "profile.primary",
      collection: "archive",
      payload: { token: "must-not-sign" },
    }),
    /forbidden field token/,
  );
  await assert.rejects(
    () => keyring.signRequest("https://tahto.example", {
      operation: "semantic/read",
      application: "app.example",
      namespace: "profile.primary",
      collection: "archive",
      payload: {},
    }),
    /dotted operation vocabulary/,
  );
});

test("removing one node key leaves other node keys intact", async () => {
  const keyring = new TahtoKeyring({ repository: repository(), now: () => "2026-08-09T00:00:00.000Z" });
  await keyring.create("http://127.0.0.1:58100");
  await keyring.create("https://tahto.example");
  assert.equal((await keyring.remove("http://127.0.0.1:58100")).removed, true);
  assert.equal(await keyring.status("http://127.0.0.1:58100"), null);
  assert.ok(await keyring.status("https://tahto.example"));
});
