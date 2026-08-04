import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createHomeDevice,
  createSignedHomeRequest,
  normalizeHomeOrigin,
  normalizePairingCode,
  normalizeServiceDescriptor,
} from "../src/home-link-client.js";
import { canonical } from "../src/protocol.js";

const encoder = new TextEncoder();

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url");
}

test("normalizes bounded home origins and one-time pairing codes", () => {
  assert.equal(normalizeHomeOrigin("http://localhost:58100"), "http://localhost:58100");
  assert.equal(normalizeHomeOrigin("https://home.example"), "https://home.example");
  assert.equal(normalizePairingCode("abcd efgh"), "ABCD-EFGH");
  assert.throws(() => normalizeHomeOrigin("http://10.0.0.20:58100"), /must use HTTPS/);
  assert.throws(() => normalizePairingCode("O0II-1111"), /unambiguous/);
});

test("rejects executable fields in home discovery service metadata", () => {
  const service = {
    id: "historia",
    name: "Historia",
    kind: "memory",
    version: "1",
    capabilities: ["history.import"],
    status: "available",
  };
  assert.equal(normalizeServiceDescriptor(service).id, "historia");
  assert.throws(
    () => normalizeServiceDescriptor({
      ...service,
      script: "https://home.example/historia.js",
    }),
    /unsupported field script/,
  );
});

test("signs method, path, nonce, time, and body hash with the browser device key", async () => {
  const device = await createHomeDevice("Test browser", webcrypto);
  const body = { protocol: "greenways-home-presence/1", visible: true };
  const signed = await createSignedHomeRequest({
    device,
    method: "POST",
    path: "/greenways/v1/status",
    body,
    now: new Date("2026-08-05T00:00:00.000Z"),
    nonce: "nonce/test",
    cryptoProvider: webcrypto,
  });
  assert.equal(device.privateKey.extractable, false);
  assert.equal(signed.envelope.method, "POST");
  assert.equal(signed.envelope.path, "/greenways/v1/status");
  assert.equal(signed.envelope.nonce, "nonce/test");
  const key = await webcrypto.subtle.importKey(
    "jwk",
    device.publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert.equal(await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decodeBase64Url(signed.signature),
    encoder.encode(canonical(signed.envelope)),
  ), true);
});

test("launcher packages Home Link locally rather than as remote UI", async () => {
  const [html, entry, css] = await Promise.all([
    readFile(new URL("../src/launcher.html", import.meta.url), "utf8"),
    readFile(new URL("../src/home-link-surface.js", import.meta.url), "utf8"),
    readFile(new URL("../src/home-link-surface.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /href="home-link-surface\.css"/);
  assert.match(html, /src="home-link-surface\.js"/);
  assert.match(entry, /createHomeDevice/);
  assert.match(entry, /Descriptions only/);
  assert.match(entry, /never evaluates remote JavaScript, Wasm, HAL/);
  assert.doesNotMatch(entry, /innerHTML\s*=\s*await\s+fetch/);
  assert.match(css, /var\(--gw-canvas\)/);
  assert.match(entry, /stopImmediatePropagation/);
});
