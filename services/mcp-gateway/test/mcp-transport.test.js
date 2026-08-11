import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_AUTH_CONTEXT_PROTOCOL,
  MCP_READ_SCOPE,
  MCP_TOOL_ERROR_PROTOCOL,
  createMcpReadRequest,
  invokeMcpReadTool,
  normalizeMcpTransportIdentity,
} from "../src/mcp-transport.js";
import { MCP_RESULT_PROTOCOL } from "../src/protocol.js";

const authContext = {
  props: {
    protocol: MCP_AUTH_CONTEXT_PROTOCOL,
    connectionId: "mcp/connection/transport-0001",
  },
};
const serverContext = {
  http: {
    authInfo: {
      clientId: "chatgpt.greenways",
      scopes: [MCP_READ_SCOPE],
    },
  },
};
const now = () => new Date("2026-08-11T04:00:00.000Z");
const randomUUID = () => "01234567-89ab-cdef-0123-456789abcdef";

test("binds one exact OAuth client and connection into a short-lived read request", () => {
  const identity = normalizeMcpTransportIdentity(authContext, serverContext);
  assert.deepEqual(identity, {
    connectionId: "mcp/connection/transport-0001",
    clientId: "chatgpt.greenways",
    scopes: [MCP_READ_SCOPE],
  });

  const { request } = createMcpReadRequest("apps.get", { appId: "chats" }, {
    authContext,
    serverContext,
    now,
    randomUUID,
  });
  assert.deepEqual(request, {
    protocol: "greenways-mcp-request/0-alpha",
    requestId: "mcp/request/01234567-89ab-cdef-0123-456789abcdef",
    connectionId: "mcp/connection/transport-0001",
    tool: "apps.get",
    arguments: { appId: "chats" },
    issuedAt: "2026-08-11T04:00:00.000Z",
    expiresAt: "2026-08-11T04:01:30.000Z",
  });
});

test("requires verified Greenways read scope and closed authentication properties", () => {
  assert.throws(
    () => normalizeMcpTransportIdentity(authContext, {
      http: { authInfo: { clientId: "chatgpt.greenways", scopes: [] } },
    }),
    /does not grant Greenways reads/,
  );
  assert.throws(
    () => normalizeMcpTransportIdentity({
      props: { ...authContext.props, token: "forbidden" },
    }, serverContext),
    /unsupported field: token/,
  );
});

test("passes only the verified client binding to the gateway executor", async () => {
  let call;
  const result = await invokeMcpReadTool({
    tool: "greenways.status",
    args: {},
    authContext,
    serverContext,
    now,
    randomUUID,
    execute: async (request, transport) => {
      call = { request, transport };
      return {
        protocol: MCP_RESULT_PROTOCOL,
        requestId: request.requestId,
        connectionId: request.connectionId,
        tool: request.tool,
        outcome: "ok",
        availability: "replicated",
        value: { status: "ready" },
        error: null,
        provenance: [],
        completedAt: "2026-08-11T04:00:01.000Z",
      };
    },
  });
  assert.deepEqual(call.transport, { clientId: "chatgpt.greenways" });
  assert.equal(result.structuredContent.value.status, "ready");
  assert.equal(result.content[0].text, JSON.stringify(result.structuredContent));
});

test("returns stable MCP errors without exposing executor internals", async () => {
  const result = await invokeMcpReadTool({
    tool: "greenways.status",
    args: {},
    authContext,
    serverContext,
    now,
    randomUUID,
    execute: async () => {
      const error = new Error("bearer-and-provider-secret");
      error.code = "INTERNAL_SECRET";
      throw error;
    },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.protocol, MCP_TOOL_ERROR_PROTOCOL);
  assert.equal(result.structuredContent.code, "transport-failure");
  assert.doesNotMatch(result.content[0].text, /bearer|provider|secret/);
});
