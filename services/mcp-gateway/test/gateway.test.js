import assert from "node:assert/strict";
import test from "node:test";
import { GreenwaysMcpGateway, McpGatewayError } from "../src/gateway.js";
import { MemoryRecordStore } from "../src/memory-store.js";
import {
  MCP_CONNECTION_PROTOCOL,
  MCP_REQUEST_PROTOCOL,
  MCP_RESULT_PROTOCOL,
  MCP_READ_TOOLS,
} from "../src/protocol.js";

const NOW = new Date("2026-08-11T03:30:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;

function connection(overrides = {}) {
  return {
    protocol: MCP_CONNECTION_PROTOCOL,
    id: "mcp/connection/example-0001",
    identity: {
      id: "identity/alice",
      keyId: DIGEST,
    },
    client: {
      id: "chatgpt.greenways",
      name: "Greenways for ChatGPT",
    },
    tools: MCP_READ_TOOLS.map(({ name }) => name),
    route: {
      kind: "beacon",
      id: "beacon/personal",
      status: "online",
    },
    issuedAt: "2026-08-11T03:00:00.000Z",
    expiresAt: "2026-08-11T04:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function request(tool, argumentsValue = {}, overrides = {}) {
  return {
    protocol: MCP_REQUEST_PROTOCOL,
    requestId: "mcp/request/example-0001",
    connectionId: "mcp/connection/example-0001",
    tool,
    arguments: argumentsValue,
    issuedAt: "2026-08-11T03:29:30.000Z",
    expiresAt: "2026-08-11T03:31:00.000Z",
    ...overrides,
  };
}

function rig({ connectionValue = connection(), handlers = {}, authorize } = {}) {
  const connectionStore = new MemoryRecordStore([connectionValue]);
  const requestStore = new MemoryRecordStore();
  const authorityCalls = [];
  const gateway = new GreenwaysMcpGateway({
    connectionStore,
    requestStore,
    handlers,
    authorize: authorize ?? (async (context) => {
      authorityCalls.push(context);
      return {
        allowed: true,
        reason: "active-local-grant",
        evidence: {
          ref: "grant/mcp/read/example",
          digest: DIGEST,
          observedAt: NOW.toISOString(),
        },
      };
    }),
    now: () => new Date(NOW),
  });
  return { gateway, requestStore, authorityCalls };
}

function assertGatewayError(error, code) {
  return error instanceof McpGatewayError && error.code === code;
}

test("executes a closed read tool through independent Greenways authority", async () => {
  const calls = [];
  const { gateway, authorityCalls } = rig({
    handlers: {
      "greenways.status": async (args, context) => {
        calls.push({ args, context });
        return {
          availability: "replicated",
          value: {
            identityId: context.identity.id,
            route: context.route.status,
            services: ["tahto", "hestia"],
          },
          provenance: [{
            kind: "snapshot",
            ref: "tahto/snapshot/example",
            digest: DIGEST,
            observedAt: NOW.toISOString(),
          }],
        };
      },
    },
  });

  const result = await gateway.execute(request("greenways.status"));
  assert.equal(result.protocol, MCP_RESULT_PROTOCOL);
  assert.equal(result.outcome, "ok");
  assert.equal(result.availability, "replicated");
  assert.equal(result.value.identityId, "identity/alice");
  assert.equal(result.provenance[0].kind, "authority");
  assert.equal(result.provenance[1].kind, "snapshot");
  assert.equal(authorityCalls.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].context.client.id, "chatgpt.greenways");
});

test("a transport connection cannot expand its tool allowlist or bypass local authority", async () => {
  const limited = connection({ tools: ["greenways.status"] });
  const denied = rig({
    connectionValue: limited,
    handlers: { "apps.get": async () => ({ availability: "replicated", value: {}, provenance: [] }) },
  });
  await assert.rejects(
    denied.gateway.execute(request("apps.get", { appId: "chats" })),
    (error) => assertGatewayError(error, "tool-not-granted"),
  );

  const staleAuthority = rig({
    handlers: { "greenways.status": async () => ({ availability: "replicated", value: {}, provenance: [] }) },
    authorize: async () => ({ allowed: false, reason: "stale-local-grant", evidence: null }),
  });
  await assert.rejects(
    staleAuthority.gateway.execute(request("greenways.status")),
    (error) => assertGatewayError(error, "authority-denied"),
  );
});

test("replays identical request IDs, rejects collisions, and deduplicates concurrent delivery", async () => {
  let calls = 0;
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  const { gateway } = rig({
    handlers: {
      "apps.get": async ({ appId }) => {
        calls += 1;
        if (calls === 1) await started;
        return {
          availability: "replicated",
          value: { id: appId, name: "Chats" },
          provenance: [],
        };
      },
    },
  });
  const input = request("apps.get", { appId: "chats" });
  const first = gateway.execute(input);
  const second = gateway.execute(input);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.deepEqual(left, right);
  assert.equal(calls, 1);
  assert.deepEqual(await gateway.execute(input), left);
  assert.equal(calls, 1);

  await assert.rejects(
    gateway.execute(request("apps.get", { appId: "userscripts" })),
    (error) => assertGatewayError(error, "request-id-collision"),
  );
});

test("represents an offline device-bound read without pretending it was queued", async () => {
  let calls = 0;
  const { gateway, authorityCalls } = rig({
    connectionValue: connection({
      route: { kind: "beacon", id: "beacon/personal", status: "offline" },
    }),
    handlers: {
      "chats.search": async () => {
        calls += 1;
        return { availability: "device", value: [], provenance: [] };
      },
    },
  });
  const result = await gateway.execute(request("chats.search", { query: "architecture" }));
  assert.equal(result.outcome, "unavailable");
  assert.equal(result.availability, "device-offline");
  assert.equal(result.error.code, "device-offline");
  assert.equal(calls, 0);
  assert.equal(authorityCalls.length, 0);
});

test("replicated reads remain available when the paired device route is offline", async () => {
  let calls = 0;
  const { gateway, authorityCalls } = rig({
    connectionValue: connection({
      route: { kind: "beacon", id: "beacon/personal", status: "offline" },
    }),
    handlers: {
      "apps.list": async ({ limit }) => {
        calls += 1;
        return { availability: "replicated", value: { items: [], limit }, provenance: [] };
      },
    },
  });
  const result = await gateway.execute(request("apps.list", {}));
  assert.equal(result.outcome, "ok");
  assert.equal(result.value.limit, 20);
  assert.equal(calls, 1);
  assert.equal(authorityCalls.length, 1);
});

test("fails closed for expired or revoked connections", async () => {
  const expired = rig({
    connectionValue: connection({ expiresAt: "2026-08-11T03:20:00.000Z" }),
    handlers: { "greenways.status": async () => ({ availability: "replicated", value: {}, provenance: [] }) },
  });
  await assert.rejects(
    expired.gateway.execute(request("greenways.status")),
    (error) => assertGatewayError(error, "connection-expired"),
  );

  const revoked = rig({
    connectionValue: connection({ revokedAt: "2026-08-11T03:10:00.000Z" }),
    handlers: { "greenways.status": async () => ({ availability: "replicated", value: {}, provenance: [] }) },
  });
  await assert.rejects(
    revoked.gateway.execute(request("greenways.status")),
    (error) => assertGatewayError(error, "connection-revoked"),
  );
});

test("rejects unknown arguments, secret-shaped values, and oversized result projections", async () => {
  const unknown = rig({
    handlers: { "apps.get": async () => ({ availability: "replicated", value: {}, provenance: [] }) },
  });
  await assert.rejects(
    unknown.gateway.execute(request("apps.get", { appId: "chats", url: "https://attacker.example" })),
    (error) => assertGatewayError(error, "invalid-request"),
  );

  const secret = rig({
    handlers: {
      "greenways.status": async () => ({
        availability: "replicated",
        value: { apiKey: "must-not-leave-the-gateway" },
        provenance: [],
      }),
    },
  });
  await assert.rejects(
    secret.gateway.execute(request("greenways.status")),
    (error) => assertGatewayError(error, "secret-material-forbidden"),
  );

  const oversized = rig({
    handlers: {
      "greenways.status": async () => ({
        availability: "replicated",
        value: { text: "x".repeat(300 * 1024) },
        provenance: [],
      }),
    },
  });
  await assert.rejects(
    oversized.gateway.execute(request("greenways.status")),
    (error) => assertGatewayError(error, "result-too-large"),
  );
});
