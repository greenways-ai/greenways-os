export const MCP_GATEWAY_PROTOCOL = "greenways-mcp-gateway/1";
export const MCP_CONNECTION_PROTOCOL = "greenways-mcp-connection/1";
export const MCP_REQUEST_PROTOCOL = "greenways-mcp-request/1";
export const MCP_RESULT_PROTOCOL = "greenways-mcp-result/1";
export const MCP_REQUEST_RECORD_PROTOCOL = "greenways-mcp-request-record/1";

const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESULT_BYTES = 256 * 1024;
const MAX_REQUEST_LIFETIME_MS = 2 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 60 * 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,180}$/;
const CONNECTION_ID = /^mcp\/connection\/[A-Za-z0-9._:-]{8,160}$/;
const REQUEST_ID = /^mcp\/request\/[A-Za-z0-9._:-]{8,160}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ROUTE_KINDS = new Set(["beacon", "home-node", "replica"]);
const ROUTE_STATES = new Set(["online", "offline", "unknown"]);
const WORK_STATES = new Set(["queued", "running", "completed", "failed", "cancelled"]);
const SECRET_KEYS = new Set([
  "apikey",
  "authorization",
  "bearertoken",
  "cookie",
  "credential",
  "password",
  "privatekey",
  "secret",
  "sessiontoken",
  "token",
]);

export const MCP_READ_TOOLS = Object.freeze([
  Object.freeze({
    name: "greenways.status",
    description: "Read bounded Greenways identity, route, and service availability without exposing kernel internals.",
    availability: "replicated",
  }),
  Object.freeze({
    name: "apps.list",
    description: "List reviewed Greenways applications visible to the paired identity.",
    availability: "replicated",
  }),
  Object.freeze({
    name: "apps.get",
    description: "Read one reviewed Greenways application descriptor by stable application ID.",
    availability: "replicated",
  }),
  Object.freeze({
    name: "work.list",
    description: "List bounded workflow items visible to the paired identity.",
    availability: "replicated",
  }),
  Object.freeze({
    name: "work.get",
    description: "Read one workflow item and its attributable state by stable work ID.",
    availability: "replicated",
  }),
  Object.freeze({
    name: "resources.search",
    description: "Search attributable Greenways resources using a bounded query.",
    availability: "hybrid",
  }),
  Object.freeze({
    name: "resources.read",
    description: "Read one bounded resource projection by stable resource ID.",
    availability: "hybrid",
  }),
  Object.freeze({
    name: "receipts.get",
    description: "Read one bounded receipt and its provenance references by stable receipt ID.",
    availability: "replicated",
  }),
  Object.freeze({
    name: "chats.search",
    description: "Search the paired user's private local chat archive when the selected device is online.",
    availability: "device-bound",
  }),
]);

const TOOL_BY_NAME = new Map(MCP_READ_TOOLS.map((tool) => [tool.name, tool]));

function error(message, code = "invalid-request") {
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

function string(value, label, maximum = 180, { empty = false } = {}) {
  if (typeof value !== "string") throw error(`${label} must be a string`);
  const output = value.trim();
  if (!empty && !output) throw error(`${label} cannot be empty`);
  if (output.length > maximum) throw error(`${label} exceeds ${maximum} characters`, "request-too-large");
  return output;
}

function optionalString(value, label, maximum = 180) {
  return value === undefined || value === null || value === ""
    ? null
    : string(value, label, maximum);
}

function id(value, label, pattern = ID) {
  const output = string(value, label);
  if (!pattern.test(output)) throw error(`${label} is invalid`);
  return output;
}

function integer(value, label, fallback, minimum, maximum) {
  const output = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(output) || output < minimum || output > maximum) {
    throw error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return output;
}

function canonicalTime(value, label) {
  const output = string(value, label, 80);
  const parsed = new Date(output);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== output) {
    throw error(`${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function optionalTime(value, label) {
  return value === undefined || value === null ? null : canonicalTime(value, label);
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export async function sha256(value, cryptoProvider = globalThis.crypto) {
  if (!cryptoProvider?.subtle) throw error("Web Crypto is unavailable", "runtime-unavailable");
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(await cryptoProvider.subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function normalizedSecretKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function assertNoSecretFields(value, label = "Value", depth = 0) {
  if (depth > 24) throw error(`${label} exceeds the maximum nesting depth`, "request-too-large");
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${label}[${index}]`, depth + 1));
    return;
  }
  plainObject(value, label);
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEYS.has(normalizedSecretKey(key))) {
      throw error(`${label} contains forbidden secret-shaped field: ${key}`, "secret-material-forbidden");
    }
    assertNoSecretFields(entry, `${label}.${key}`, depth + 1);
  }
}

function identity(value) {
  const input = closedKeys(value, new Set(["id", "keyId"]), "MCP connection identity");
  const keyId = string(input.keyId, "MCP connection identity key id", 80);
  if (!DIGEST.test(keyId)) throw error("MCP connection identity key id is invalid");
  return Object.freeze({
    id: id(input.id, "MCP connection identity id"),
    keyId,
  });
}

function client(value) {
  const input = closedKeys(value, new Set(["id", "name"]), "MCP connection client");
  return Object.freeze({
    id: id(input.id, "MCP connection client id"),
    name: string(input.name, "MCP connection client name", 100),
  });
}

function route(value) {
  const input = closedKeys(value, new Set(["kind", "id", "status"]), "MCP connection route");
  const kind = string(input.kind, "MCP connection route kind", 32);
  const status = string(input.status, "MCP connection route status", 32);
  if (!ROUTE_KINDS.has(kind)) throw error("MCP connection route kind is unsupported");
  if (!ROUTE_STATES.has(status)) throw error("MCP connection route status is unsupported");
  return Object.freeze({ kind, id: id(input.id, "MCP connection route id"), status });
}

export function toolDescriptor(name) {
  return TOOL_BY_NAME.get(name) ?? null;
}

export function normalizeConnection(value) {
  const input = closedKeys(
    value,
    new Set([
      "protocol", "id", "identity", "client", "tools", "route",
      "issuedAt", "expiresAt", "revokedAt",
    ]),
    "MCP connection",
  );
  if (input.protocol !== MCP_CONNECTION_PROTOCOL) throw error("MCP connection protocol is unsupported");
  if (!Array.isArray(input.tools) || !input.tools.length || input.tools.length > MCP_READ_TOOLS.length) {
    throw error("MCP connection tools must be a non-empty bounded array");
  }
  const tools = input.tools.map((entry, index) => {
    const name = string(entry, `MCP connection tool ${index}`, 80);
    if (!TOOL_BY_NAME.has(name)) throw error(`MCP connection tool is unsupported: ${name}`);
    return name;
  });
  if (new Set(tools).size !== tools.length) throw error("MCP connection tools must be unique");
  const issuedAt = canonicalTime(input.issuedAt, "MCP connection issuedAt");
  const expiresAt = canonicalTime(input.expiresAt, "MCP connection expiresAt");
  const revokedAt = optionalTime(input.revokedAt, "MCP connection revokedAt");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt)) throw error("MCP connection expiry must follow issuance");
  if (revokedAt && Date.parse(revokedAt) < Date.parse(issuedAt)) {
    throw error("MCP connection revocation cannot precede issuance");
  }
  const output = Object.freeze({
    protocol: MCP_CONNECTION_PROTOCOL,
    id: id(input.id, "MCP connection id", CONNECTION_ID),
    identity: identity(input.identity),
    client: client(input.client),
    tools: Object.freeze(tools),
    route: route(input.route),
    issuedAt,
    expiresAt,
    revokedAt,
  });
  assertNoSecretFields(output, "MCP connection");
  return output;
}

function pagination(input, label) {
  return {
    limit: integer(input.limit, `${label} limit`, 20, 1, 100),
    cursor: optionalString(input.cursor, `${label} cursor`, 512),
  };
}

function normalizeArguments(tool, value) {
  const label = `${tool} arguments`;
  if (tool === "greenways.status") {
    closedKeys(value, new Set(), label);
    return Object.freeze({});
  }
  if (tool === "apps.list") {
    const input = closedKeys(value, new Set(["limit", "cursor"]), label);
    return Object.freeze(pagination(input, label));
  }
  if (tool === "apps.get") {
    const input = closedKeys(value, new Set(["appId"]), label);
    return Object.freeze({ appId: id(input.appId, `${label} appId`) });
  }
  if (tool === "work.list") {
    const input = closedKeys(value, new Set(["status", "limit", "cursor"]), label);
    const status = optionalString(input.status, `${label} status`, 32);
    if (status && !WORK_STATES.has(status)) throw error(`${label} status is unsupported`);
    return Object.freeze({ status, ...pagination(input, label) });
  }
  if (tool === "work.get") {
    const input = closedKeys(value, new Set(["workId"]), label);
    return Object.freeze({ workId: id(input.workId, `${label} workId`) });
  }
  if (tool === "resources.search") {
    const input = closedKeys(value, new Set(["query", "kind", "limit", "cursor"]), label);
    return Object.freeze({
      query: string(input.query, `${label} query`, 1024),
      kind: optionalString(input.kind, `${label} kind`, 80),
      ...pagination(input, label),
    });
  }
  if (tool === "resources.read") {
    const input = closedKeys(value, new Set(["resourceId"]), label);
    return Object.freeze({ resourceId: id(input.resourceId, `${label} resourceId`) });
  }
  if (tool === "receipts.get") {
    const input = closedKeys(value, new Set(["receiptId"]), label);
    return Object.freeze({ receiptId: id(input.receiptId, `${label} receiptId`) });
  }
  if (tool === "chats.search") {
    const input = closedKeys(value, new Set(["query", "limit", "cursor"]), label);
    return Object.freeze({
      query: string(input.query, `${label} query`, 1024),
      ...pagination(input, label),
    });
  }
  throw error(`Unsupported MCP tool: ${tool}`, "method-denied");
}

export function normalizeRequest(value, { now = () => new Date() } = {}) {
  const input = closedKeys(
    value,
    new Set(["protocol", "requestId", "connectionId", "tool", "arguments", "issuedAt", "expiresAt"]),
    "MCP request",
  );
  if (input.protocol !== MCP_REQUEST_PROTOCOL) throw error("MCP request protocol is unsupported");
  const tool = string(input.tool, "MCP request tool", 80);
  if (!TOOL_BY_NAME.has(tool)) throw error(`MCP request tool is unsupported: ${tool}`, "method-denied");
  const issuedAt = canonicalTime(input.issuedAt, "MCP request issuedAt");
  const expiresAt = canonicalTime(input.expiresAt, "MCP request expiresAt");
  const issuedTime = Date.parse(issuedAt);
  const expiresTime = Date.parse(expiresAt);
  const currentTime = now().getTime();
  if (expiresTime <= issuedTime || expiresTime - issuedTime > MAX_REQUEST_LIFETIME_MS) {
    throw error("MCP request lifetime is invalid", "expired-request");
  }
  if (issuedTime > currentTime + MAX_CLOCK_SKEW_MS || expiresTime <= currentTime) {
    throw error("MCP request is outside its accepted time window", "expired-request");
  }
  const output = Object.freeze({
    protocol: MCP_REQUEST_PROTOCOL,
    requestId: id(input.requestId, "MCP request id", REQUEST_ID),
    connectionId: id(input.connectionId, "MCP request connection id", CONNECTION_ID),
    tool,
    arguments: normalizeArguments(tool, input.arguments ?? {}),
    issuedAt,
    expiresAt,
  });
  assertNoSecretFields(output, "MCP request");
  if (byteLength(output) > MAX_REQUEST_BYTES) throw error("MCP request exceeds its byte limit", "request-too-large");
  return output;
}

export function validateDigest(value, label = "Digest") {
  const output = string(value, label, 80);
  if (!DIGEST.test(output)) throw error(`${label} is invalid`);
  return output;
}

export function validateBoundedPublicValue(value, label = "MCP result value") {
  if (value === undefined) throw error(`${label} is required`, "result-invalid");
  assertNoSecretFields(value, label);
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw error(`${label} must be JSON serializable`, "result-invalid");
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_RESULT_BYTES) {
    throw error(`${label} exceeds its byte limit`, "result-too-large");
  }
  return value;
}
