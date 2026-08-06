import assert from "node:assert/strict";
import test from "node:test";
import { encodeEdn } from "../../services/packages/src/edn.js";
import {
  encodeBase64url,
  verifyRegistryEnvelope,
} from "../src/registry-client.js";

const encoder = new TextEncoder();

async function signedEnvelope({ expiresAt = "2026-08-07T00:00:00.000Z" } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const payload = encodeEdn({
    "index/protocol": "greenways-registry-index/1",
    "index/registry": "https://packages.greenways.ai/",
    "index/generated-at": "2026-08-06T00:00:00.000Z",
    "index/expires-at": expiresAt,
    "index/packages": {},
  });
  const payloadBytes = encoder.encode(payload);
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    pair.privateKey,
    payloadBytes,
  ));
  return {
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    source: encodeEdn({
      "registry/protocol": "greenways-registry/1",
      "registry/key-id": "fixture-root-1",
      "registry/algorithm": "ES256",
      "registry/signed": encodeBase64url(payloadBytes),
      "registry/signature": encodeBase64url(signature),
    }),
  };
}

test("verifies exact signed index bytes against a locally trusted P-256 key", async () => {
  const fixture = await signedEnvelope();
  const index = await verifyRegistryEnvelope(fixture.source, {
    trustedKeys: { "fixture-root-1": fixture.publicJwk },
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
  assert.equal(index.registry, "https://packages.greenways.ai/");
  assert.equal(index.keyId, "fixture-root-1");
  assert.deepEqual(index.packages, {});
});

test("rejects an expired index and an untrusted envelope key", async () => {
  const expired = await signedEnvelope({ expiresAt: "2026-08-06T01:00:00.000Z" });
  await assert.rejects(
    verifyRegistryEnvelope(expired.source, {
      trustedKeys: { "fixture-root-1": expired.publicJwk },
      now: () => new Date("2026-08-06T12:00:00.000Z"),
    }),
    /has expired/,
  );
  await assert.rejects(
    verifyRegistryEnvelope(expired.source, {
      trustedKeys: {},
      now: () => new Date("2026-08-06T00:30:00.000Z"),
    }),
    /key is not trusted/,
  );
});

test("rejects malformed base64url before signature verification", async () => {
  const fixture = await signedEnvelope();
  const malformed = fixture.source.replace(/:registry\/signature "[^"]+"/, ':registry/signature "a"');
  await assert.rejects(
    verifyRegistryEnvelope(malformed, {
      trustedKeys: { "fixture-root-1": fixture.publicJwk },
      now: () => new Date("2026-08-06T12:00:00.000Z"),
    }),
    /not base64url/,
  );
});
