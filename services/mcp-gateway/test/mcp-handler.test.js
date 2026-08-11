import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_AUTH_CONTEXT_PROTOCOL,
  MCP_READ_SCOPE,
} from "../src/mcp-transport.js";
import { createGreenwaysMcpHandler } from "../src/mcp-handler.js";
import { MCP_READ_TOOLS, MCP_RESULT_PROTOCOL } from "../src/protocol.js";

function statelessRequest(method, params = {}, { url = "https://mcp.greenways.ai/mcp" } = {}) {
  const name = typeof params.name === "string" ? params.name : undefined;
  return new Request(url, {
    method: "POST",
    headers: {
      Host: new URL(url).host,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": method,
      ...(name ? { "Mcp-Name": name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": {
            name: "Greenways transport test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

const authContext = {
  props: {
    protocol: MCP_AUTH_CONTEXT_PROTOCOL,
    connectionId: "mcp/connection/handler-0001",
  },
};
const authInfo = {
  clientId: "chatgpt.greenways",
  scopes: [MCP_READ_SCOPE],
};
const now = () => new Date("2026-08-11T04:10:00.000Z");
let sequence = 0;
const randomUUID = () => `01234567-89ab-cdef-0123-${String(sequence++).padStart(12, "0")}`;

function handler(execute) {
  return createGreenwaysMcpHandler({
    execute,
    now,
    randomUUID,
    authContext,
    allowedHostnames: ["mcp.greenways.ai"],
    allowedOriginHostnames: [],
  });
}

test("publishes only the nine closed read tools with non-destructive annotations", async () => {
  const transport = handler(async () => { throw new Error("must not execute"); });
  const response = await transport.fetch(statelessRequest("tools/list"), { authInfo });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.result.tools.map(({ name }) => name), MCP_READ_TOOLS.map(({ name }) => name));
  for (const tool of body.result.tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }
});

test("serves a stateless tool call through the authenticated Greenways executor", async () => {
  let call;
  const transport = handler(async (request, context) => {
    call = { request, context };
    return {
      protocol: MCP_RESULT_PROTOCOL,
      requestId: request.requestId,
      connectionId: request.connectionId,
      tool: request.tool,
      outcome: "ok",
      availability: "replicated",
      value: { id: request.arguments.appId, name: "Chats" },
      error: null,
      provenance: [],
      completedAt: "2026-08-11T04:10:01.000Z",
    };
  });
  const response = await transport.fetch(statelessRequest("tools/call", {
    name: "apps.get",
    arguments: { appId: "chats" },
  }), { authInfo });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result.isError, undefined);
  assert.equal(body.result.structuredContent.value.id, "chats");
  assert.equal(call.request.connectionId, "mcp/connection/handler-0001");
  assert.deepEqual(call.context, { clientId: "chatgpt.greenways" });
});

test("fails a tool safely when OAuth scope is absent and rejects the legacy lane", async () => {
  const transport = handler(async () => { throw new Error("must not execute"); });
  const denied = await transport.fetch(statelessRequest("tools/call", {
    name: "greenways.status",
    arguments: {},
  }), { authInfo: { ...authInfo, scopes: [] } });
  const deniedBody = await denied.json();
  assert.equal(deniedBody.result.isError, true);
  assert.equal(deniedBody.result.structuredContent.code, "transport-denied");

  const legacy = new Request("https://mcp.greenways.ai/mcp", {
    method: "POST",
    headers: {
      Host: "mcp.greenways.ai",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy", version: "1" },
      },
    }),
  });
  assert.equal((await transport.fetch(legacy, { authInfo })).status, 400);
});

test("uses the exact /mcp route with no broad browser CORS projection", async () => {
  const transport = handler(async () => { throw new Error("must not execute"); });
  const missing = await transport.fetch(statelessRequest("server/discover", {}, {
    url: "https://mcp.greenways.ai/other",
  }), { authInfo });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("Access-Control-Allow-Origin"), null);
});
