import { McpDeliveryError } from "./mcp-delivery.js";

export const MCP_DELIVERY_STORE_RPC_PROTOCOL = "greenways-mcp-delivery-store-rpc/1";

const ERROR_CODE = /^[a-z][a-z0-9-]{2,80}$/;
const MAX_ERROR_MESSAGE = 400;

function recovery(message, options) {
  throw new McpDeliveryError(500, "delivery-recovery", message, options);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    recovery(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    recovery(`${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) recovery(`${label} contains an unsupported field: ${key}`);
  }
  return input;
}

function clone(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    recovery(`${label} must be structured-cloneable`, { cause });
  }
}

function errorRecord(value) {
  const input = closedKeys(value, new Set(["status", "code", "message"]), "MCP delivery RPC error");
  if (!Number.isInteger(input.status) || input.status < 400 || input.status > 599) {
    recovery("MCP delivery RPC error status is invalid");
  }
  if (typeof input.code !== "string" || !ERROR_CODE.test(input.code)) {
    recovery("MCP delivery RPC error code is invalid");
  }
  if (typeof input.message !== "string"
      || !input.message.trim()
      || input.message.length > MAX_ERROR_MESSAGE) {
    recovery("MCP delivery RPC error message is invalid");
  }
  return Object.freeze({
    status: input.status,
    code: input.code,
    message: input.message.trim(),
  });
}

export async function executeMcpDeliveryStoreRpc(operation) {
  if (typeof operation !== "function") throw new TypeError("MCP delivery RPC requires an operation");
  try {
    const value = await operation();
    return Object.freeze({
      protocol: MCP_DELIVERY_STORE_RPC_PROTOCOL,
      ok: true,
      value: clone(value, "MCP delivery RPC value"),
    });
  } catch (error) {
    if (!(error instanceof McpDeliveryError)) throw error;
    return Object.freeze({
      protocol: MCP_DELIVERY_STORE_RPC_PROTOCOL,
      ok: false,
      error: Object.freeze({
        status: error.status,
        code: error.code,
        message: error.message,
      }),
    });
  }
}

export function unwrapMcpDeliveryStoreRpc(value) {
  const input = plainObject(value, "MCP delivery RPC response");
  if (input.protocol !== MCP_DELIVERY_STORE_RPC_PROTOCOL || typeof input.ok !== "boolean") {
    recovery("MCP delivery RPC response is invalid");
  }
  if (input.ok) {
    closedKeys(input, new Set(["protocol", "ok", "value"]), "MCP delivery RPC response");
    return clone(input.value, "MCP delivery RPC value");
  }
  closedKeys(input, new Set(["protocol", "ok", "error"]), "MCP delivery RPC response");
  const failure = errorRecord(input.error);
  throw new McpDeliveryError(failure.status, failure.code, failure.message);
}
