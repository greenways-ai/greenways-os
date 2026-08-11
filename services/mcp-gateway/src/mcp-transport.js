import { McpGatewayError } from "./gateway.js";
import {
  MCP_REQUEST_PROTOCOL,
  MCP_RESULT_PROTOCOL,
  assertNoSecretFields,
  toolDescriptor,
  validateBoundedPublicValue,
} from "./protocol.js";

export const MCP_AUTH_CONTEXT_PROTOCOL = "greenways-mcp-auth-context/1";
export const MCP_TOOL_ERROR_PROTOCOL = "greenways-mcp-tool-error/1";
export const MCP_READ_SCOPE = "greenways.read";

const CONNECTION_ID = /^mcp\/connection\/[A-Za-z0-9._:-]{8,160}$/;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,200}$/;
const AUTH_PROP_KEYS = new Set(["protocol", "connectionId"]);
const MAX_SCOPES = 32;
const REQUEST_LIFETIME_MS = 90_000;

const PUBLIC_ERRORS = Object.freeze({
  "invalid-request": "The Greenways MCP request was invalid.",
  "request-too-large": "The Greenways MCP request exceeded its size limit.",
  "expired-request": "The Greenways MCP request expired.",
  "request-id-collision": "The Greenways MCP request ID was reused with different content.",
  "connection-unknown": "The Greenways MCP connection was not found.",
  "connection-mismatch": "The Greenways MCP connection did not match this request.",
  "connection-expired": "The Greenways MCP connection expired.",
  "connection-revoked": "The Greenways MCP connection was revoked.",
  "client-mismatch": "The authenticated MCP client did not match the Greenways connection.",
  "tool-not-granted": "The Greenways MCP connection does not grant this tool.",
  "tool-unavailable": "The requested Greenways MCP tool is unavailable.",
  "tool-failed": "The Greenways MCP tool could not complete the read.",
  "authority-denied": "Greenways authority denied this tool request.",
  "authority-unavailable": "Greenways authority could not validate this tool request.",
  "gateway-storage-unavailable": "Greenways MCP storage is unavailable.",
  "gateway-recovery": "Greenways MCP could not safely recover the stored result.",
  "secret-material-forbidden": "The Greenways MCP result contained forbidden secret-shaped material.",
  "result-invalid": "The Greenways MCP result was invalid.",
  "result-too-large": "The Greenways MCP result exceeded its size limit.",
  "device-offline": "The selected Greenways device is offline.",
});

function error(message, code = "transport-invalid") {
  const output = new Error(message);
  output.code = code;
  return output;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw error(`${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw error(`${label} contains an unsupported field: ${key}`);
  }
  return input;
}

function string(value, label, maximum = 200) {
  if (typeof value !== "string") throw error(`${label} must be a string`);
  const output = value.trim();
  if (!output || output.length > maximum) throw error(`${label} is invalid`);
  return output;
}

function canonicalNow(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw error("Greenways MCP transport clock is invalid", "transport-unavailable");
  }
  return new Date(value.getTime());
}

function secureRequestId(randomUUID) {
  const value = string(randomUUID(), "Greenways MCP random request ID", 80);
  if (!/^[0-9a-f-]{16,80}$/i.test(value)) {
    throw error("Greenways MCP request randomness is invalid", "transport-unavailable");
  }
  return `mcp/request/${value}`;
}

function normalizeScopes(value) {
  if (!Array.isArray(value) || value.length > MAX_SCOPES) {
    throw error("Authenticated MCP scopes are invalid", "transport-denied");
  }
  const scopes = value.map((entry, index) => string(entry, `Authenticated MCP scope ${index}`, 120));
  if (new Set(scopes).size !== scopes.length) {
    throw error("Authenticated MCP scopes must be unique", "transport-denied");
  }
  if (!scopes.includes(MCP_READ_SCOPE)) {
    throw error("The authenticated MCP token does not grant Greenways reads", "transport-denied");
  }
  return Object.freeze(scopes);
}

export function normalizeMcpTransportIdentity(authContext, serverContext) {
  const props = closedKeys(
    plainObject(authContext, "MCP authentication context").props,
    AUTH_PROP_KEYS,
    "MCP authentication properties",
  );
  if (props.protocol !== MCP_AUTH_CONTEXT_PROTOCOL) {
    throw error("MCP authentication properties use an unsupported protocol", "transport-denied");
  }
  const connectionId = string(props.connectionId, "MCP authentication connection ID", 180);
  if (!CONNECTION_ID.test(connectionId)) {
    throw error("MCP authentication connection ID is invalid", "transport-denied");
  }

  const authInfo = plainObject(
    plainObject(serverContext, "MCP server context").http?.authInfo,
    "MCP HTTP authentication information",
  );
  const clientId = string(authInfo.clientId, "MCP OAuth client ID", 200);
  if (!CLIENT_ID.test(clientId)) {
    throw error("MCP OAuth client ID is invalid", "transport-denied");
  }
  const scopes = normalizeScopes(authInfo.scopes);
  return Object.freeze({ connectionId, clientId, scopes });
}

export function createMcpReadRequest(tool, args, {
  authContext,
  serverContext,
  now = () => new Date(),
  randomUUID = () => globalThis.crypto.randomUUID(),
} = {}) {
  if (!toolDescriptor(tool)) throw error(`Unsupported Greenways MCP tool: ${tool}`, "transport-denied");
  const identity = normalizeMcpTransportIdentity(authContext, serverContext);
  const issued = canonicalNow(now);
  const request = Object.freeze({
    protocol: MCP_REQUEST_PROTOCOL,
    requestId: secureRequestId(randomUUID),
    connectionId: identity.connectionId,
    tool,
    arguments: plainObject(args ?? {}, `${tool} arguments`),
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + REQUEST_LIFETIME_MS).toISOString(),
  });
  assertNoSecretFields(request, "MCP transport request");
  return Object.freeze({ request, identity });
}

function normalizeGatewayResult(value, request) {
  const input = plainObject(value, "Greenways MCP gateway result");
  if (input.protocol !== MCP_RESULT_PROTOCOL
      || input.requestId !== request.requestId
      || input.connectionId !== request.connectionId
      || input.tool !== request.tool) {
    throw error("Greenways MCP gateway returned a mismatched result", "transport-contract");
  }
  return validateBoundedPublicValue(input, "Greenways MCP gateway result");
}

function successToolResult(result) {
  return Object.freeze({
    content: Object.freeze([Object.freeze({
      type: "text",
      text: JSON.stringify(result),
    })]),
    structuredContent: result,
  });
}

function publicError(errorValue) {
  if (errorValue instanceof McpGatewayError && PUBLIC_ERRORS[errorValue.code]) {
    return Object.freeze({ code: errorValue.code, message: PUBLIC_ERRORS[errorValue.code] });
  }
  if (errorValue?.code === "transport-denied") {
    return Object.freeze({ code: "transport-denied", message: "The MCP transport identity was not authorized." });
  }
  if (errorValue?.code === "transport-unavailable") {
    return Object.freeze({ code: "transport-unavailable", message: "The Greenways MCP transport is unavailable." });
  }
  return Object.freeze({ code: "transport-failure", message: "The Greenways MCP tool failed safely." });
}

export function mcpToolError(errorValue) {
  const failure = publicError(errorValue);
  const value = Object.freeze({
    protocol: MCP_TOOL_ERROR_PROTOCOL,
    ok: false,
    code: failure.code,
    message: failure.message,
  });
  return Object.freeze({
    isError: true,
    content: Object.freeze([Object.freeze({
      type: "text",
      text: JSON.stringify(value),
    })]),
    structuredContent: value,
  });
}

export async function invokeMcpReadTool({
  tool,
  args,
  execute,
  authContext,
  serverContext,
  now,
  randomUUID,
}) {
  try {
    if (typeof execute !== "function") throw error("Greenways MCP executor is unavailable", "transport-unavailable");
    const { request, identity } = createMcpReadRequest(tool, args, {
      authContext,
      serverContext,
      now,
      randomUUID,
    });
    const result = await execute(request, { clientId: identity.clientId });
    return successToolResult(normalizeGatewayResult(result, request));
  } catch (cause) {
    return mcpToolError(cause);
  }
}
