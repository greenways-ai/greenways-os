import { McpPairingError } from "./mcp-pairing.js";

export const MCP_PAIRING_STORE_RPC_PROTOCOL = "greenways-mcp-pairing-store-rpc/1";

const ERROR_CODE = /^[a-z][a-z0-9-]{2,80}$/;
const MAX_ERROR_MESSAGE = 400;

function recovery(message, options) {
  throw new McpPairingError(500, "pairing-recovery", message, options);
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
  const input = closedKeys(value, new Set(["status", "code", "message"]), "MCP pairing-store RPC error");
  if (!Number.isInteger(input.status) || input.status < 400 || input.status > 599) {
    recovery("MCP pairing-store RPC error status is invalid");
  }
  if (typeof input.code !== "string" || !ERROR_CODE.test(input.code)) {
    recovery("MCP pairing-store RPC error code is invalid");
  }
  if (typeof input.message !== "string"
      || !input.message.trim()
      || input.message.length > MAX_ERROR_MESSAGE) {
    recovery("MCP pairing-store RPC error message is invalid");
  }
  return Object.freeze({
    status: input.status,
    code: input.code,
    message: input.message.trim(),
  });
}

export async function executeMcpPairingStoreRpc(operation) {
  if (typeof operation !== "function") throw new TypeError("MCP pairing-store RPC requires an operation");
  try {
    const value = await operation();
    return Object.freeze({
      protocol: MCP_PAIRING_STORE_RPC_PROTOCOL,
      ok: true,
      value: clone(value, "MCP pairing-store RPC value"),
    });
  } catch (error) {
    if (!(error instanceof McpPairingError)) throw error;
    return Object.freeze({
      protocol: MCP_PAIRING_STORE_RPC_PROTOCOL,
      ok: false,
      error: Object.freeze({
        status: error.status,
        code: error.code,
        message: error.message,
      }),
    });
  }
}

export function unwrapMcpPairingStoreRpc(value) {
  const input = plainObject(value, "MCP pairing-store RPC response");
  if (input.protocol !== MCP_PAIRING_STORE_RPC_PROTOCOL || typeof input.ok !== "boolean") {
    recovery("MCP pairing-store RPC response is invalid");
  }
  if (input.ok) {
    closedKeys(input, new Set(["protocol", "ok", "value"]), "MCP pairing-store RPC response");
    return clone(input.value, "MCP pairing-store RPC value");
  }
  closedKeys(input, new Set(["protocol", "ok", "error"]), "MCP pairing-store RPC response");
  const failure = errorRecord(input.error);
  throw new McpPairingError(failure.status, failure.code, failure.message);
}
