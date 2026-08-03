import { test } from "node:test";
import assert from "node:assert/strict";
import { HestiaClient, requestOriginAccess, resolveIdentity } from "../src/hestia-client.js";
import { canonical, sha256 } from "../src/protocol.js";

test("Hestia discovery and append use the bounded v1 endpoints", async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    calls.push([url, options]);
    if (url.endsWith("/.well-known/hestia")) {
      return { ok: true, json: async () => ({ protocol: "hestia-node/1" }) };
    }
    return { ok: true, json: async () => ({ accepted: 1, receipts: [] }) };
  };
  const client = new HestiaClient({ origin: "https://home.example/path", request });
  assert.equal((await client.discover()).protocol, "hestia-node/1");
  await client.append([{ root: "sha256:action" }], { deviceToken: "scoped-token" });
  assert.equal(calls[1][0], "https://home.example/greenways/v1/actions");
  assert.equal(calls[1][1].headers.authorization, "Hestia scoped-token");
});

test("id.greenways.ai responses are content verified", async () => {
  const body = {
    protocol: "greenways-identity-resolution/1",
    identityId: "identity/alice",
    handle: "alice",
    publicKey: { kty: "EC" }
  };
  const card = { ...body, resolutionRoot: await sha256(canonical(body)) };
  const resolved = await resolveIdentity("identity/alice", {
    request: async () => ({ ok: true, json: async () => card })
  });
  assert.equal(resolved.handle, "alice");
  await assert.rejects(
    resolveIdentity("identity/alice", {
      request: async () => ({ ok: true, json: async () => ({ ...card, handle: "mallory" }) })
    }),
    /modified/
  );
});

test("Hestia origin access is requested only when pairing", async () => {
  const calls = [];
  const permissions = {
    contains: async (request) => { calls.push(["contains", request]); return false; },
    request: async (request) => { calls.push(["request", request]); return true; }
  };
  await requestOriginAccess("https://home.example/path", permissions);
  assert.deepEqual(calls, [
    ["contains", { origins: ["https://home.example/*"] }],
    ["request", { origins: ["https://home.example/*"] }]
  ]);
});
