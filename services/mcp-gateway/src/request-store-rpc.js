import { McpRequestStoreError } from "./request-store.js";

export const MCP_REQUEST_STORE_RPC_PROTOCOL = "greenways-mcp-request-store-rpc/1";

const ERROR_CODE = /^[a-z][a-z0-9-]{2,80}$/;
const MAX_ERROR_MESSAGE = 400;

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpRequestStoreError("request-store-recovery", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new McpRequestStoreError("request-store-recovery", `${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new McpRequestStoreError(
        "request-store-recovery",
        `${label} contains an unsupported field: ${key}`,
      );
    }
  }
  return input;
}

function clone(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    throw new McpRequestStoreError(
      "request-store-recovery",
      `${label} must be structured-cloneable`,
      { cause },
    );
  }
}

function errorRecord(value) {
  const input = closedKeys(value, new Set(["code", "message"]), "MCP request-store RPC error");
  if (typeof input.code !== "string" || !ERROR_CODE.test(input.code)) {
    throw new McpRequestStoreError("request-store-recovery", "MCP request-store RPC error code is invalid");
  }
  if (typeof input.message !== "string"
      || !input.message.trim()
      || input.message.length > MAX_ERROR_MESSAGE) {
    throw new McpRequestStoreError("request-store-recovery", "MCP request-store RPC error message is invalid");
  }
  return Object.freeze({ code: input.code, message: input.message.trim() });
}

export async function executeMcpRequestStoreRpc(operation) {
  if (typeof operation !== "function") throw new TypeError("MCP request-store RPC requires an operation");
  try {
    const value = await operation();
    return Object.freeze({
      protocol: MCP_REQUEST_STORE_RPC_PROTOCOL,
      ok: true,
      value: clone(value, "MCP request-store RPC value"),
    });
  } catch (error) {
    if (!(error instanceof McpRequestStoreError)) throw error;
    return Object.freeze({
      protocol: MCP_REQUEST_STORE_RPC_PROTOCOL,
      ok: false,
      error: Object.freeze({
        code: error.code,
        message: error.message,
      }),
    });
  }
}

export function unwrapMcpRequestStoreRpc(value) {
  const input = plainObject(value, "MCP request-store RPC response");
  if (input.protocol !== MCP_REQUEST_STORE_RPC_PROTOCOL || typeof input.ok !== "boolean") {
    throw new McpRequestStoreError("request-store-recovery", "MCP request-store RPC response is invalid");
  }
  if (input.ok) {
    closedKeys(input, new Set(["protocol", "ok", "value"]), "MCP request-store RPC response");
    return clone(input.value, "MCP request-store RPC value");
  }
  closedKeys(input, new Set(["protocol", "ok", "error"]), "MCP request-store RPC response");
  const failure = errorRecord(input.error);
  throw new McpRequestStoreError(failure.code, failure.message);
}
