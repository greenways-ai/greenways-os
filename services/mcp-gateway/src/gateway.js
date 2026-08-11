import {
  MCP_REQUEST_RECORD_PROTOCOL,
  MCP_RESULT_PROTOCOL,
  canonical,
  normalizeConnection,
  normalizeRequest,
  sha256,
  toolDescriptor,
  validateBoundedPublicValue,
  validateDigest,
} from "./protocol.js";

const AVAILABILITY = new Set(["replicated", "device", "hybrid"]);
const PROVENANCE_KINDS = new Set(["authority", "snapshot", "receipt", "resource", "device"]);
const MAX_PROVENANCE = 16;

export class McpGatewayError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = "McpGatewayError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message, options) {
  throw new McpGatewayError(status, code, message, options);
}

function contract(operation) {
  try {
    return operation();
  } catch (cause) {
    if (cause instanceof McpGatewayError) throw cause;
    fail(500, cause?.code ?? "gateway-contract", cause?.message ?? "Gateway contract validation failed", { cause });
  }
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(500, "gateway-contract", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(500, "gateway-contract", `${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(500, "gateway-contract", `${label} contains an unsupported field: ${key}`);
  }
  return input;
}

function publicString(value, label, maximum = 240) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    fail(500, "gateway-contract", `${label} is invalid`);
  }
  return value.trim();
}

function canonicalTime(value, label) {
  const output = publicString(value, label, 80);
  if (!Number.isFinite(Date.parse(output)) || new Date(output).toISOString() !== output) {
    fail(500, "gateway-contract", `${label} is not a canonical UTC timestamp`);
  }
  return output;
}

function normalizeAuthority(value) {
  const input = closedKeys(value, new Set(["allowed", "reason", "evidence"]), "MCP authority decision");
  if (typeof input.allowed !== "boolean") fail(500, "gateway-contract", "MCP authority decision allowed must be boolean");
  return Object.freeze({
    allowed: input.allowed,
    reason: publicString(input.reason, "MCP authority decision reason", 120),
    evidence: input.evidence === undefined || input.evidence === null
      ? null
      : validateBoundedPublicValue(input.evidence, "MCP authority evidence"),
  });
}

function normalizeProvenance(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_PROVENANCE) {
    fail(500, "gateway-contract", "MCP result provenance must be a bounded array");
  }
  return Object.freeze(value.map((entry, index) => {
    const input = closedKeys(
      entry,
      new Set(["kind", "ref", "digest", "observedAt"]),
      `MCP result provenance ${index}`,
    );
    const kind = publicString(input.kind, `MCP result provenance ${index} kind`, 40);
    if (!PROVENANCE_KINDS.has(kind)) {
      fail(500, "gateway-contract", `MCP result provenance ${index} kind is unsupported`);
    }
    return Object.freeze({
      kind,
      ref: publicString(input.ref, `MCP result provenance ${index} ref`, 240),
      digest: input.digest === undefined || input.digest === null
        ? null
        : validateDigest(input.digest, `MCP result provenance ${index} digest`),
      observedAt: input.observedAt === undefined || input.observedAt === null
        ? null
        : canonicalTime(input.observedAt, `MCP result provenance ${index} observedAt`),
    });
  }));
}

function normalizeHandlerResult(value) {
  const input = closedKeys(
    value,
    new Set(["availability", "value", "provenance"]),
    "MCP read handler result",
  );
  const availability = publicString(input.availability, "MCP read handler availability", 40);
  if (!AVAILABILITY.has(availability)) {
    fail(500, "gateway-contract", "MCP read handler availability is unsupported");
  }
  return Object.freeze({
    availability,
    value: validateBoundedPublicValue(input.value),
    provenance: normalizeProvenance(input.provenance),
  });
}

function publicResult({ request, outcome, availability, value, error, provenance, completedAt }) {
  const result = Object.freeze({
    protocol: MCP_RESULT_PROTOCOL,
    requestId: request.requestId,
    connectionId: request.connectionId,
    tool: request.tool,
    outcome,
    availability,
    value,
    error,
    provenance,
    completedAt,
  });
  validateBoundedPublicValue(result, "MCP result");
  return result;
}

function activeConnection(connection, now) {
  if (connection.revokedAt) fail(401, "connection-revoked", "The MCP connection has been revoked");
  if (Date.parse(connection.expiresAt) <= now.getTime()) {
    fail(401, "connection-expired", "The MCP connection has expired");
  }
}

function unavailableResult(request, now) {
  return publicResult({
    request,
    outcome: "unavailable",
    availability: "device-offline",
    value: null,
    error: Object.freeze({
      code: "device-offline",
      message: "The selected Greenways device is offline; this read was not queued.",
    }),
    provenance: Object.freeze([]),
    completedAt: now.toISOString(),
  });
}

export class GreenwaysMcpGateway {
  constructor({ connectionStore, requestStore, handlers, authorize, now = () => new Date() }) {
    if (!connectionStore || typeof connectionStore.get !== "function") {
      throw new TypeError("MCP gateway requires a connection store");
    }
    if (!requestStore || typeof requestStore.get !== "function" || typeof requestStore.put !== "function") {
      throw new TypeError("MCP gateway requires an idempotent request store");
    }
    if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) {
      throw new TypeError("MCP gateway requires a closed read-handler map");
    }
    for (const [name, handler] of Object.entries(handlers)) {
      if (!toolDescriptor(name) || typeof handler !== "function") {
        throw new TypeError(`MCP gateway handler is invalid: ${name}`);
      }
    }
    if (typeof authorize !== "function") throw new TypeError("MCP gateway requires an independent authority gate");
    if (typeof now !== "function") throw new TypeError("MCP gateway requires a clock");
    this.connectionStore = connectionStore;
    this.requestStore = requestStore;
    this.handlers = Object.freeze({ ...handlers });
    this.authorize = authorize;
    this.now = now;
    this.inflight = new Map();
  }

  async execute(value) {
    let request;
    try {
      request = normalizeRequest(value, { now: this.now });
    } catch (cause) {
      fail(400, cause.code ?? "invalid-request", cause.message, { cause });
    }
    const digest = await sha256(canonical(request));
    const stored = await this.requestStore.get(request.requestId);
    if (stored) return this.replay(stored, digest);

    const running = this.inflight.get(request.requestId);
    if (running) {
      if (running.digest !== digest) fail(409, "request-id-collision", "MCP request ID was reused with different content");
      return running.promise;
    }

    const promise = this.executeFresh(request, digest);
    this.inflight.set(request.requestId, { digest, promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(request.requestId);
    }
  }

  replay(record, digest) {
    const input = closedKeys(record, new Set(["protocol", "requestId", "digest", "result"]), "Stored MCP request");
    if (input.protocol !== MCP_REQUEST_RECORD_PROTOCOL || input.requestId !== input.result?.requestId) {
      fail(500, "gateway-recovery", "Stored MCP request record is invalid");
    }
    if (input.digest !== digest) fail(409, "request-id-collision", "MCP request ID was reused with different content");
    return input.result;
  }

  async executeFresh(request, digest) {
    const rawConnection = await this.connectionStore.get(request.connectionId);
    if (!rawConnection) fail(401, "connection-unknown", "The MCP connection does not exist");
    let connection;
    try {
      connection = normalizeConnection(rawConnection);
    } catch (cause) {
      fail(500, "gateway-recovery", "Stored MCP connection is invalid", { cause });
    }
    if (connection.id !== request.connectionId) fail(401, "connection-mismatch", "The MCP connection does not match the request");
    const current = this.now();
    activeConnection(connection, current);
    if (!connection.tools.includes(request.tool)) {
      fail(403, "tool-not-granted", "The MCP connection does not grant this tool");
    }

    const descriptor = toolDescriptor(request.tool);
    if (descriptor.availability === "device-bound" && connection.route.status !== "online") {
      const result = unavailableResult(request, current);
      await this.requestStore.put({
        protocol: MCP_REQUEST_RECORD_PROTOCOL,
        requestId: request.requestId,
        digest,
        result,
      });
      return result;
    }

    const rawDecision = await this.authorize({ connection, request, tool: descriptor });
    const decision = contract(() => normalizeAuthority(rawDecision));
    if (!decision.allowed) fail(403, "authority-denied", `Greenways authority denied the tool: ${decision.reason}`);
    const handler = this.handlers[request.tool];
    if (!handler) fail(503, "tool-unavailable", "The granted MCP tool is not available on this gateway");
    const rawHandled = await handler(request.arguments, {
      identity: connection.identity,
      client: connection.client,
      route: connection.route,
      requestId: request.requestId,
      authority: decision,
    });
    const handled = contract(() => normalizeHandlerResult(rawHandled));
    const authorityProvenance = decision.evidence
      ? [Object.freeze({
        kind: "authority",
        ref: publicString(decision.evidence.ref ?? "greenways/authority", "MCP authority evidence ref", 240),
        digest: decision.evidence.digest ?? null,
        observedAt: decision.evidence.observedAt ?? null,
      })]
      : [];
    const result = contract(() => publicResult({
      request,
      outcome: "ok",
      availability: handled.availability,
      value: handled.value,
      error: null,
      provenance: Object.freeze([...authorityProvenance, ...handled.provenance]),
      completedAt: current.toISOString(),
    }));
    await this.requestStore.put({
      protocol: MCP_REQUEST_RECORD_PROTOCOL,
      requestId: request.requestId,
      digest,
      result,
    });
    return result;
  }
}
