import assert from "node:assert/strict";
import test from "node:test";
import { GreenwaysMcpGateway, McpGatewayError } from "../src/gateway.js";
import { MemoryRecordStore } from "../src/memory-store.js";
import {
  MCP_CONNECTION_PROTOCOL,
  MCP_REQUEST_PROTOCOL,
  MCP_READ_TOOLS,
} from "../src/protocol.js";

const NOW = new Date("2026-08-11T03:30:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;

function connection() {
  return {
    protocol: MCP_CONNECTION_PROTOCOL,
    id: "mcp/connection/recovery-0001",
    identity: { id: "identity/alice", keyId: DIGEST },
    client: { id: "chatgpt.greenways", name: "Greenways for ChatGPT" },
    tools: MCP_READ_TOOLS.map(({ name }) => name),
    route: { kind: "beacon", id: "beacon/personal", status: "online" },
    issuedAt: "2026-08-11T03:00:00.000Z",
    expiresAt: "2026-08-11T04:00:00.000Z",
    revokedAt: null,
  };
}

function request(tool, argumentsValue = {}) {
  return {
    protocol: MCP_REQUEST_PROTOCOL,
    requestId: "mcp/request/recovery-0001",
    connectionId: "mcp/connection/recovery-0001",
    tool,
    arguments: argumentsValue,
    issuedAt: "2026-08-11T03:29:30.000Z",
    expiresAt: "2026-08-11T03:31:00.000Z",
  };
}

function gateway({ handlers, authorize } = {}) {
  const requestStore = new MemoryRecordStore();
  return {
    requestStore,
    gateway: new GreenwaysMcpGateway({
      connectionStore: new MemoryRecordStore([connection()]),
      requestStore,
      handlers,
      authorize: authorize ?? (async () => ({
        allowed: true,
        reason: "active-local-grant",
        evidence: {
          ref: "grant/mcp/read/recovery",
          digest: DIGEST,
          observedAt: NOW.toISOString(),
        },
      })),
      now: () => new Date(NOW),
    }),
  };
}

function hasCode(error, code) {
  return error instanceof McpGatewayError && error.code === code;
}

test("rejects a corrupted stored result instead of replaying unverified bytes", async () => {
  const rig = gateway({
    handlers: {
      "apps.get": async ({ appId }) => ({
        availability: "replicated",
        value: { id: appId, name: "Chats" },
        provenance: [],
      }),
    },
  });
  const input = request("apps.get", { appId: "chats" });
  await rig.gateway.execute(input);
  const record = await rig.requestStore.get(input.requestId);
  await rig.requestStore.put({
    ...record,
    result: {
      ...record.result,
      tool: "work.get",
      value: { apiKey: "must-not-replay" },
    },
  });

  await assert.rejects(
    rig.gateway.execute(input),
    (error) => hasCode(error, "gateway-recovery")
      && !error.message.includes("must-not-replay"),
  );
});

test("contains authority and semantic-handler failures behind stable gateway errors", async () => {
  const authorityFailure = gateway({
    handlers: {
      "greenways.status": async () => ({ availability: "replicated", value: {}, provenance: [] }),
    },
    authorize: async () => {
      throw new Error("bearer-secret-must-not-leak");
    },
  });
  await assert.rejects(
    authorityFailure.gateway.execute(request("greenways.status")),
    (error) => hasCode(error, "authority-unavailable")
      && !error.message.includes("bearer-secret-must-not-leak"),
  );

  const handlerFailure = gateway({
    handlers: {
      "greenways.status": async () => {
        throw new Error("provider-secret-must-not-leak");
      },
    },
  });
  await assert.rejects(
    handlerFailure.gateway.execute(request("greenways.status")),
    (error) => hasCode(error, "tool-failed")
      && !error.message.includes("provider-secret-must-not-leak"),
  );
});


test("binds replay and execution to the authenticated MCP client", async () => {
  const rig = gateway({
    handlers: {
      "greenways.status": async () => ({ availability: "replicated", value: {}, provenance: [] }),
    },
  });
  const input = request("greenways.status");
  await assert.rejects(
    rig.gateway.execute(input, { clientId: "other.client" }),
    (error) => hasCode(error, "client-mismatch"),
  );
  const accepted = await rig.gateway.execute(input, { clientId: "chatgpt.greenways" });
  assert.equal(accepted.outcome, "ok");
  await assert.rejects(
    rig.gateway.execute(input, { clientId: "other.client" }),
    (error) => hasCode(error, "request-id-collision"),
  );
});
