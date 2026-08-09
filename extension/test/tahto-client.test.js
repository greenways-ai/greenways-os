import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TAHTO_HEALTH_PROTOCOL,
  TAHTO_LINK_PROTOCOL,
  TAHTO_NODE_PROTOCOL,
  TAHTO_STATUS_PROTOCOL,
  TahtoClient,
  createTahtoNodeRecord,
  normalizeTahtoDescriptor,
  normalizeTahtoNodeState,
  normalizeTahtoOrigin,
  removeTahtoNode,
  requestTahtoOriginAccess,
  revokeTahtoOriginAccess,
  setDefaultTahtoNode,
  tahtoPermissionPattern,
  upsertTahtoNode,
} from "../src/tahto-client.js";

function decodeHeader(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function descriptor(overrides = {}) {
  return {
    protocol: TAHTO_NODE_PROTOCOL,
    id: "greenways.tahto",
    name: "Tahto",
    role: "application-state-fabric",
    runtime: {
      applicationServer: "Hoplite",
      language: "Hara",
      namespace: "tahto.node.app",
      edge: "Nginx",
    },
    authority: {
      installation: "greenways-os",
      consent: "greenways-os",
      privateKeys: "greenways-os",
      custody: "tahto",
      meaning: "application-and-specification-packages",
    },
    boundaries: {
      conflicts: "preserve-divergent-heads",
      remoteExecutableCatalogue: false,
      hostedSpaceRequired: false,
      largeObjectBodies: "request-work-scoped-host-sources",
      signedRecords: "verified-provider-proofs",
      devicePairing: "identity-only-no-admin-grant",
      requestReplay: "durable-nonce-and-idempotency-evidence",
      metadataTransactions: "deterministic-plan-provider-cas",
      metadataHost: "generic-installed-hara-store-no-request-selection",
      objectHost: "generic-installed-hara-blob-no-request-selection",
      serviceDescriptors: "inert-digest-pinned-metadata",
      workerExecution: "application-owned-installed-provider",
      semanticSchemas: "exact-installed-package-roots",
    },
    routes: {
      discovery: "/.well-known/tahto",
      health: "/tahto/v1/health",
      status: "/tahto/v1/status",
      pairing: "/tahto/v1/pair",
    },
    components: {
      controlPlane: "ready",
      deviceIdentityReplay: "hara-kernel-ready:TAHTO-5",
      semanticFabric: "planned:T-SF-01",
      signatureProvider: "not-wired",
    },
    compatibility: { greenwaysBeacon: "one-release-route-alias" },
    ...overrides,
  };
}

function health(overrides = {}) {
  return {
    protocol: TAHTO_HEALTH_PROTOCOL,
    status: "ready",
    runtime: "hoplite",
    scope: "control-plane-and-generic-capability-kernels",
    ...overrides,
  };
}

function status(overrides = {}) {
  return {
    protocol: TAHTO_STATUS_PROTOCOL,
    node: { status: "ready", phase: "generic-capability-baseline", mode: "local" },
    fabric: {
      objectVault: "hara-kernel-ready",
      semanticFabric: "planned",
      signatureProvider: "not-wired",
    },
    hostedSpace: { required: false, adapter: "optional" },
    ...overrides,
  };
}

function json(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
    ...init,
  });
}

test("accepts loopback HTTP and remote HTTPS origins only", () => {
  assert.equal(normalizeTahtoOrigin("http://127.0.0.1:58100"), "http://127.0.0.1:58100");
  assert.equal(normalizeTahtoOrigin("http://localhost:58100"), "http://localhost:58100");
  assert.equal(normalizeTahtoOrigin("http://[::1]:58100"), "http://[::1]:58100");
  assert.equal(normalizeTahtoOrigin("https://tahto.example:8443"), "https://tahto.example:8443");
  assert.equal(tahtoPermissionPattern("https://tahto.example"), "https://tahto.example/*");
  assert.throws(() => normalizeTahtoOrigin("http://192.168.1.8:58100"), /must use HTTPS/);
  assert.throws(() => normalizeTahtoOrigin("https://tahto.example/status"), /without a path/);
  assert.throws(() => normalizeTahtoOrigin("https://user@tahto.example"), /credentials/);
});

test("requests and revokes only the canonical configured origin", async () => {
  const calls = [];
  const permissions = {
    contains: async (request) => { calls.push(["contains", request]); return false; },
    request: async (request) => { calls.push(["request", request]); return true; },
    remove: async (request) => { calls.push(["remove", request]); return true; },
  };
  await requestTahtoOriginAccess("http://127.0.0.1:58100", permissions);
  await revokeTahtoOriginAccess("http://127.0.0.1:58100", permissions);
  assert.deepEqual(calls, [
    ["contains", { origins: ["http://127.0.0.1:58100/*"] }],
    ["request", { origins: ["http://127.0.0.1:58100/*"] }],
    ["remove", { origins: ["http://127.0.0.1:58100/*"] }],
  ]);
});

test("strictly validates inert Tahto discovery", () => {
  const value = normalizeTahtoDescriptor(descriptor());
  assert.equal(value.runtime.applicationServer, "Hoplite");
  assert.equal(value.authority.privateKeys, "greenways-os");
  assert.equal(value.boundaries.remoteExecutableCatalogue, false);
  assert.equal(value.routes.status, "/tahto/v1/status");
  assert.equal(value.components.semanticFabric, "planned:T-SF-01");
  assert.throws(() => normalizeTahtoDescriptor(descriptor({ script: "https://evil.example/a.js" })), /executable field script/);
  assert.throws(() => normalizeTahtoDescriptor(descriptor({ routes: {
    discovery: "/.well-known/tahto",
    health: "/tahto/v1/health",
    status: "https://evil.example/status",
    pairing: "/tahto/v1/pair",
  } })), /must be \/tahto\/v1\/status/);
});

test("inspects discovery, health and status without credentials or redirects", async () => {
  const calls = [];
  const client = new TahtoClient({
    origin: "http://127.0.0.1:58100",
    request: async (url, options) => {
      calls.push([url, options]);
      if (url.endsWith("/.well-known/tahto")) return json(descriptor());
      if (url.endsWith("/health")) return json(health());
      return json(status());
    },
  });
  const inspected = await client.inspect();
  assert.equal(inspected.health.status, "ready");
  assert.equal(inspected.status.node.mode, "local");
  assert.deepEqual(calls.map(([url]) => url), [
    "http://127.0.0.1:58100/.well-known/tahto",
    "http://127.0.0.1:58100/tahto/v1/health",
    "http://127.0.0.1:58100/tahto/v1/status",
  ]);
  for (const [, options] of calls) {
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
  }
});

test("rejects non-JSON, oversized and malformed control responses", async () => {
  await assert.rejects(
    () => new TahtoClient({
      origin: "https://tahto.example",
      request: async () => new Response("hello", { status: 200, headers: { "content-type": "text/plain" } }),
    }).discover(),
    /did not return JSON/,
  );
  await assert.rejects(
    () => new TahtoClient({
      origin: "https://tahto.example",
      request: async () => new Response("x".repeat(1024 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }).discover(),
    /exceeded the 1 MiB/,
  );
});

test("stores multiple nodes with one explicit default", () => {
  const now = () => "2026-08-09T00:00:00.000Z";
  const local = createTahtoNodeRecord({
    origin: "http://127.0.0.1:58100",
    label: "Local fabric",
    descriptor: descriptor(),
    health: health(),
    status: status(),
  }, now);
  const remote = createTahtoNodeRecord({
    origin: "https://tahto.example",
    label: "Remote fabric",
    descriptor: descriptor(),
    health: health(),
    status: status(),
  }, now);
  let state = upsertTahtoNode(null, local);
  assert.equal(state.protocol, TAHTO_LINK_PROTOCOL);
  assert.equal(state.defaultOrigin, local.origin);
  state = upsertTahtoNode(state, remote);
  assert.equal(state.nodes.length, 2);
  state = setDefaultTahtoNode(state, remote.origin);
  assert.equal(state.defaultOrigin, remote.origin);
  state = removeTahtoNode(state, remote.origin);
  assert.equal(state.defaultOrigin, local.origin);
  assert.equal(normalizeTahtoNodeState(state).nodes.length, 1);
});

test("preserves first connection time while refreshing a node", () => {
  const first = createTahtoNodeRecord({
    origin: "https://tahto.example",
    descriptor: descriptor(), health: health(), status: status(),
  }, () => "2026-08-09T00:00:00.000Z");
  const second = createTahtoNodeRecord({
    origin: "https://tahto.example",
    descriptor: descriptor(), health: health(), status: status(),
  }, () => "2026-08-09T01:00:00.000Z");
  const state = upsertTahtoNode(upsertTahtoNode(null, first), second);
  assert.equal(state.nodes[0].connectedAt, "2026-08-09T00:00:00.000Z");
  assert.equal(state.nodes[0].checkedAt, "2026-08-09T01:00:00.000Z");
});

test("packages the Tahto status surface entirely inside Greenways OS", async () => {
  const [html, surface, css, manifestText] = await Promise.all([
    readFile(new URL("../src/launcher.html", import.meta.url), "utf8"),
    readFile(new URL("../src/tahto-surface.js", import.meta.url), "utf8"),
    readFile(new URL("../src/tahto.css", import.meta.url), "utf8"),
    readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.match(html, /href="tahto\.css"/);
  assert.match(html, /src="tahto-surface\.js"/);
  assert.match(surface, /Discovery is descriptive, not authority/);
  assert.match(surface, /requestTahtoOriginAccess/);
  assert.doesNotMatch(surface, /innerHTML\s*=\s*await\s+fetch/);
  assert.match(css, /var\(--gw-surface\)/);
  assert.ok(manifest.optional_host_permissions.includes("http://[::1]/*"));
});

test("pairing sends one inert header and binds only the returned identity", async () => {
  const calls = [];
  const keyring = {
    status: async () => null,
    create: async () => ({
      keyId: `sha256:${"a".repeat(64)}`,
      publicKey: "p256:public-key",
      algorithm: "p256-sha256",
      deviceId: null,
      nodeId: null,
    }),
    bind: async (origin, identity) => calls.push({ origin, identity }),
  };
  const request = async (url, options) => {
    const envelope = decodeHeader(options.headers["x-tahto-pairing"]);
    assert.equal(options.method, "POST");
    assert.equal(url, "https://tahto.example/tahto/v1/pair");
    assert.equal(envelope.invitation, "invite.secret");
    assert.equal("privateKey" in envelope, false);
    return new Response(JSON.stringify({
      protocol: "tahto.pairing-result/1",
      node: "node.home",
      device: envelope.device,
      administrator: false,
      grants: [],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await new TahtoClient({ origin: "https://tahto.example", request, keyring }).pair("invite.secret");
  assert.equal(result.administrator, false);
  assert.deepEqual(calls, [{
    origin: "https://tahto.example",
    identity: { deviceId: `device.${"a".repeat(24)}`, nodeId: "node.home" },
  }]);
});

test("semantic read signs the operation and rejects executable response fields", async () => {
  const keyring = { signRequest: async (_origin, request) => ({ protocol: "tahto.device-request/1", ...request }) };
  let executable = false;
  const request = async (_url, options) => {
    assert.equal(decodeHeader(options.headers["x-tahto-request"]).operation, "semantic.read");
    return new Response(JSON.stringify(executable ? {
      protocol: "tahto.semantic-result/1",
      operation: "semantic.read",
      status: "ready",
      value: { script: "alert(1)" },
    } : {
      protocol: "tahto.semantic-result/1",
      operation: "semantic.read",
      status: "ready",
      value: { stableId: "document/main" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new TahtoClient({ origin: "https://tahto.example", request, keyring });
  const coordinate = { application: "app.example", namespace: "profile.primary", collection: "archive" };
  const result = await client.read(coordinate, { stableId: "document/main" });
  assert.equal(result.value.stableId, "document/main");
  executable = true;
  await assert.rejects(() => client.read(coordinate), /executable field script/);
});
