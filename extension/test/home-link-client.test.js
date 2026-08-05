import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  createHomeDevice,
  createSignedHomeRequest,
  normalizeHomeDiscovery,
  normalizeHomeOrigin,
  normalizePairingCode,
  requestHomeOriginAccess,
  revokeHomeOriginAccess,
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
  const base = {
    protocol: "greenways-home/1",
    node: {
      id: "home.test",
      name: "Test Home",
      algorithm: "ECDSA-P256-SHA256",
      keyId: `sha256:${"0".repeat(64)}`,
      publicKey: {
        kty: "EC",
        crv: "P-256",
        x: "x",
        y: "y",
        ext: true,
        key_ops: ["verify"],
      },
    },
    pairing: { available: true },
    services: [{
      id: "historia",
      name: "Historia",
      kind: "memory",
      version: "1",
      capabilities: ["history.import"],
      status: "available",
    }],
    issuedAt: "2026-08-05T00:00:00.000Z",
    signature: "signature",
  };
  assert.equal(normalizeHomeDiscovery(base).services[0].id, "historia");
  assert.throws(
    () => normalizeHomeDiscovery({
      ...base,
      services: [{ ...base.services[0], script: "https://home.example/historia.js" }],
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

test("requests and revokes the browser match-pattern origin", async () => {
  const operations = [];
  const permissions = {
    request: async (value) => {
      operations.push(["request", value]);
      return true;
    },
    remove: async (value) => {
      operations.push(["remove", value]);
      return true;
    },
  };
  await requestHomeOriginAccess("http://127.0.0.1:58100", permissions);
  await revokeHomeOriginAccess("http://127.0.0.1:58100", permissions);
  assert.deepEqual(operations, [
    ["request", { origins: ["http://127.0.0.1:58100/*"] }],
    ["remove", { origins: ["http://127.0.0.1:58100/*"] }],
  ]);
});

test("browser runtime binds receiver-sensitive APIs before modules capture them", async () => {
  const runtime = await readFile(new URL("../src/browser-runtime.js", import.meta.url), "utf8");
  const browserGlobal = {
    marker: "browser-global",
    calls: 0,
    fetch() {
      assert.equal(this.marker, "browser-global");
      this.calls += 1;
      return "ok";
    },
  };
  runInNewContext(runtime, browserGlobal);
  const capturedFetch = browserGlobal.fetch;
  assert.equal(capturedFetch.call({ marker: "wrong-receiver" }), "ok");
  assert.equal(browserGlobal.calls, 1);
});

test("launcher packages legacy Home Link locally as a migration surface", async () => {
  const [html, entry, css] = await Promise.all([
    readFile(new URL("../src/launcher.html", import.meta.url), "utf8"),
    readFile(new URL("../src/home-link-surface.js", import.meta.url), "utf8"),
    readFile(new URL("../src/home-link-surface.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /href="home-link-surface\.css"/);
  assert.match(html, /src="home-link-surface\.js"/);
  assert.ok(
    html.indexOf('src="browser-runtime.js"') < html.indexOf('src="home-link-surface.js"'),
    "browser runtime must bind receiver-sensitive APIs before Home Link loads",
  );
  assert.match(entry, /createHomeDevice/);
  assert.match(entry, /LEGACY SERVICE DESCRIPTORS/);
  assert.match(entry, /Compatibility only/);
  assert.match(entry, /never evaluates remote JavaScript, Wasm, HAL/);
  assert.match(entry, /Greenways Beacon is the Hoplite gateway/);
  assert.doesNotMatch(entry, /innerHTML\s*=\s*await\s+fetch/);
  assert.match(css, /var\(--gw-canvas\)/);
  assert.match(entry, /stopImmediatePropagation/);
});
