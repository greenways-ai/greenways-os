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

function syncEntry({
  root = "sha256:action",
  eventHash = "sha256:inclusion",
  sequence = 1,
  previousHash = `sha256:${"0".repeat(64)}`,
} = {}) {
  return {
    protocol: "greenways-sync-entry/1",
    action: {
      protocol: "greenways-action/1",
      id: `action/${eventHash}`,
      root,
      signature: "signed-action",
    },
    inclusion: {
      protocol: "greenways-personal-chain/1",
      chainId: "identity/alice",
      keyId: "sha256:alice-key",
      sequence,
      previousHash,
      actionRoot: root,
      eventHash,
      signature: "signed-inclusion",
    },
  };
}

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
  const entry = syncEntry();
  await client.append([entry], { deviceToken: "scoped-token" });
  assert.equal(calls[1][0], "https://home.example/greenways/v1/actions");
  assert.equal(calls[1][1].headers.authorization, "Hestia scoped-token");
  assert.equal(calls[1][1].credentials, "omit");
  assert.equal(calls[1][1].redirect, "error");
  assert.equal(calls[1][1].referrerPolicy, "no-referrer");
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    protocol: "greenways-sync/1",
    entries: [entry],
  });
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
    client.append([
      syncEntry({ root: "sha256:first", eventHash: "sha256:first-inclusion" }),
      syncEntry({
        root: "sha256:second",
        eventHash: "sha256:second-inclusion",
        sequence: 2,
        previousHash: "sha256:first-inclusion",
      }),
    ], { deviceToken: "device" }),
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

test("refuses unsigned or mismatched outbox entries before network access", async () => {
  let requested = false;
  const client = new HestiaClient({
    origin: "https://home.example",
    request: async () => { requested = true; },
  });
  await assert.rejects(
    client.append([{ root: "sha256:legacy-action" }], { deviceToken: "device" }),
    /unsupported protocol/,
  );
  await assert.rejects(
    client.append([{
      ...syncEntry(),
      inclusion: { ...syncEntry().inclusion, actionRoot: "sha256:other" },
    }], { deviceToken: "device" }),
    /does not name its action/,
  );
  assert.equal(requested, false);
});

test("orders a contiguous personal-chain batch before sending it", async () => {
  let body;
  const first = syncEntry({ eventHash: "sha256:first" });
  const second = syncEntry({
    root: "sha256:second-action",
    eventHash: "sha256:second",
    sequence: 2,
    previousHash: first.inclusion.eventHash,
  });
  const client = new HestiaClient({
    origin: "https://home.example",
    request: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ accepted: 2 }) };
    },
  });
  await client.append([second, first], { deviceToken: "device" });
  assert.deepEqual(body.entries.map((entry) => entry.inclusion.sequence), [1, 2]);
  await assert.rejects(
    client.append([first, { ...second, inclusion: { ...second.inclusion, previousHash: "sha256:wrong" } }], { deviceToken: "device" }),
    /not one contiguous/,
  );
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
