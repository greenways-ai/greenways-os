import { McpServer } from "@modelcontextprotocol/server";
import { getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import {
  MCP_READ_TOOLS,
  MCP_RESULT_PROTOCOL,
} from "./protocol.js";
import { invokeMcpReadTool } from "./mcp-transport.js";

export const GREENWAYS_MCP_SERVER = Object.freeze({
  name: "Greenways OS",
  version: "0.1.0",
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,180}$/;
const CURSOR = z.string().max(512).optional();
const LIMIT = z.number().int().min(1).max(100).optional();
const READ_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const PROVENANCE_SCHEMA = z.strictObject({
  kind: z.enum(["authority", "snapshot", "receipt", "resource", "device"]),
  ref: z.string().min(1).max(240),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  observedAt: z.iso.datetime().nullable(),
});

const RESULT_SCHEMA = z.strictObject({
  protocol: z.literal(MCP_RESULT_PROTOCOL),
  requestId: z.string().min(1).max(180),
  connectionId: z.string().min(1).max(180),
  tool: z.string().min(1).max(80),
  outcome: z.enum(["ok", "unavailable"]),
  availability: z.enum(["replicated", "device", "hybrid", "device-offline"]),
  value: z.unknown(),
  error: z.strictObject({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(400),
  }).nullable(),
  provenance: z.array(PROVENANCE_SCHEMA).max(16),
  completedAt: z.iso.datetime(),
});

const PAGINATION = {
  limit: LIMIT,
  cursor: CURSOR,
};

export const MCP_TOOL_INPUT_SCHEMAS = Object.freeze({
  "greenways.status": z.strictObject({}),
  "apps.list": z.strictObject({ ...PAGINATION }),
  "apps.get": z.strictObject({ appId: z.string().regex(ID) }),
  "work.list": z.strictObject({
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
    ...PAGINATION,
  }),
  "work.get": z.strictObject({ workId: z.string().regex(ID) }),
  "resources.search": z.strictObject({
    query: z.string().min(1).max(1024),
    kind: z.string().min(1).max(80).optional(),
    ...PAGINATION,
  }),
  "resources.read": z.strictObject({ resourceId: z.string().regex(ID) }),
  "receipts.get": z.strictObject({ receiptId: z.string().regex(ID) }),
  "chats.search": z.strictObject({
    query: z.string().min(1).max(1024),
    ...PAGINATION,
  }),
});

function descriptorByName(name) {
  const descriptor = MCP_READ_TOOLS.find((entry) => entry.name === name);
  if (!descriptor) throw new Error(`Missing Greenways MCP descriptor: ${name}`);
  return descriptor;
}

export function createGreenwaysMcpServer({
  execute,
  now = () => new Date(),
  randomUUID = () => globalThis.crypto.randomUUID(),
  getAuthContext = getMcpAuthContext,
} = {}) {
  if (typeof execute !== "function") throw new TypeError("Greenways MCP server requires an executor");
  if (typeof now !== "function") throw new TypeError("Greenways MCP server requires a clock");
  if (typeof randomUUID !== "function") throw new TypeError("Greenways MCP server requires secure request IDs");
  if (typeof getAuthContext !== "function") throw new TypeError("Greenways MCP server requires an authentication context reader");

  const server = new McpServer(GREENWAYS_MCP_SERVER);
  for (const name of Object.keys(MCP_TOOL_INPUT_SCHEMAS)) {
    const descriptor = descriptorByName(name);
    server.registerTool(
      name,
      {
        description: descriptor.description,
        inputSchema: MCP_TOOL_INPUT_SCHEMAS[name],
        outputSchema: RESULT_SCHEMA,
        annotations: READ_ANNOTATIONS,
      },
      async (args, context) => invokeMcpReadTool({
        tool: name,
        args,
        execute,
        authContext: getAuthContext(),
        serverContext: context,
        now,
        randomUUID,
      }),
    );
  }
  return server;
}
