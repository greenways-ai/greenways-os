import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  HestiaClient,
  normalizeHestiaOrigin,
  requestOriginAccess,
  revokeOriginAccess,
  resolveIdentity,
} from "../src/hestia-client.js";
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

test("requires HTTPS for non-loopback Hestia nodes", () => {
  assert.equal(normalizeHestiaOrigin("http://127.0.0.1:58080/path"), "http://127.0.0.1:58080");
  assert.equal(normalizeHestiaOrigin("http://localhost:58080"), "http://localhost:58080");
  assert.equal(normalizeHestiaOrigin("https://home.example/path"), "https://home.example");
  assert.throws(() => normalizeHestiaOrigin("http://home.example"), /must use HTTPS/);
  assert.throws(() => normalizeHestiaOrigin("https://owner:secret@home.example"), /cannot contain credentials/);
});

test("keeps partial Hestia acknowledgements in the caller's local outbox", async () => {
  const client = new HestiaClient({
    origin: "https://home.example",
    request: async () => ({ ok: true, json: async () => ({ accepted: 1 }) }),
  });
  await assert.rejects(
    client.append([{ root: "sha256:first" }, { root: "sha256:second" }], { deviceToken: "device" }),
    /accepted 1 of 2 records; the local outbox was retained/,
  );
});

test("requires a scoped token before sending a Hestia batch", async () => {
  let requested = false;
  const client = new HestiaClient({
    origin: "https://home.example",
    request: async () => { requested = true; },
  });
  await assert.rejects(client.append([], { deviceToken: "" }), /device token is required/);
  assert.equal(requested, false);
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
    request: async (request) => { calls.push(["request", request]); return true; }
  };
  await requestOriginAccess("https://home.example/path", permissions);
  assert.deepEqual(calls, [
    ["request", { origins: ["https://home.example/*"] }]
  ]);
});

test("Hestia origin access is revoked on connector disconnect", async () => {
  const calls = [];
  const permissions = {
    remove: async (request) => { calls.push(request); return true; },
  };
  assert.equal(await revokeOriginAccess("https://home.example/path", permissions), true);
  assert.deepEqual(calls, [{ origins: ["https://home.example/*"] }]);
  await assert.rejects(
    revokeOriginAccess("https://home.example", {
      remove: async () => false,
      contains: async () => true,
    }),
    /could not be revoked/,
  );
});

test("Greenways Home routes Hestia management through the optional connector", async () => {
  const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(source, /launcher\.html#app-hestia-connector/);
  assert.doesNotMatch(source, /HestiaClient|requestOriginAccess|greenways\/v1\/actions/);
});
