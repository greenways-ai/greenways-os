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
const RESULT_AVAILABILITY = new Set([...AVAILABILITY, "device-offline"]);
const RESULT_OUTCOMES = new Set(["ok", "unavailable"]);
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

function normalizeAuthorityEvidence(value) {
  const input = closedKeys(
    value,
    new Set(["ref", "digest", "observedAt"]),
    "MCP authority evidence",
  );
  return Object.freeze({
    ref: publicString(input.ref, "MCP authority evidence ref", 240),
    digest: input.digest === undefined || input.digest === null
      ? null
      : validateDigest(input.digest, "MCP authority evidence digest"),
    observedAt: input.observedAt === undefined || input.observedAt === null
      ? null
      : canonicalTime(input.observedAt, "MCP authority evidence observedAt"),
  });
}

function normalizeAuthority(value) {
  const input = closedKeys(value, new Set(["allowed", "reason", "evidence"]), "MCP authority decision");
  if (typeof input.allowed !== "boolean") fail(500, "gateway-contract", "MCP authority decision allowed must be boolean");
  return Object.freeze({
    allowed: input.allowed,
    reason: publicString(input.reason, "MCP authority decision reason", 120),
    evidence: input.evidence === undefined || input.evidence === null
      ? null
      : normalizeAuthorityEvidence(input.evidence),
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

function normalizeStoredError(value) {
  if (value === null) return null;
  const input = closedKeys(value, new Set(["code", "message"]), "Stored MCP result error");
  return Object.freeze({
    code: publicString(input.code, "Stored MCP result error code", 80),
    message: publicString(input.message, "Stored MCP result error message", 400),
  });
}

function normalizeStoredResult(value, request) {
  const input = closedKeys(
    value,
    new Set([
      "protocol", "requestId", "connectionId", "tool", "outcome",
      "availability", "value", "error", "provenance", "completedAt",
    ]),
    "Stored MCP result",
  );
  if (input.protocol !== MCP_RESULT_PROTOCOL
      || input.requestId !== request.requestId
      || input.connectionId !== request.connectionId
      || input.tool !== request.tool) {
    fail(500, "gateway-recovery", "Stored MCP result identity is invalid");
  }
  const outcome = publicString(input.outcome, "Stored MCP result outcome", 40);
  const availability = publicString(input.availability, "Stored MCP result availability", 40);
  if (!RESULT_OUTCOMES.has(outcome) || !RESULT_AVAILABILITY.has(availability)) {
    fail(500, "gateway-recovery", "Stored MCP result state is invalid");
  }
  const storedError = normalizeStoredError(input.error);
  if ((outcome === "ok" && storedError !== null)
      || (outcome === "unavailable"
        && (availability !== "device-offline" || input.value !== null || storedError === null))) {
    fail(500, "gateway-recovery", "Stored MCP result outcome is inconsistent");
  }
  const output = Object.freeze({
    protocol: MCP_RESULT_PROTOCOL,
    requestId: request.requestId,
    connectionId: request.connectionId,
    tool: request.tool,
    outcome,
    availability,
    value: validateBoundedPublicValue(input.value, "Stored MCP result value"),
    error: storedError,
    provenance: normalizeProvenance(input.provenance),
    completedAt: canonicalTime(input.completedAt, "Stored MCP result completedAt"),
  });
  validateBoundedPublicValue(output, "Stored MCP result");
  return output;
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
    let digest;
    try {
      digest = await sha256(canonical(request));
    } catch (cause) {
      fail(500, cause?.code ?? "runtime-unavailable", "MCP request digesting failed", { cause });
    }
    let stored;
    try {
      stored = await this.requestStore.get(request.requestId);
    } catch (cause) {
      fail(503, "gateway-storage-unavailable", "MCP request storage is unavailable", { cause });
    }
    if (stored) return this.replay(stored, digest, request);

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

  replay(record, digest, request) {
    try {
      const input = closedKeys(record, new Set(["protocol", "requestId", "digest", "result"]), "Stored MCP request");
      if (input.protocol !== MCP_REQUEST_RECORD_PROTOCOL || input.requestId !== request.requestId) {
        fail(500, "gateway-recovery", "Stored MCP request record is invalid");
      }
      const storedDigest = validateDigest(input.digest, "Stored MCP request digest");
      if (storedDigest !== digest) fail(409, "request-id-collision", "MCP request ID was reused with different content");
      return normalizeStoredResult(input.result, request);
    } catch (cause) {
      if (cause instanceof McpGatewayError
          && new Set(["request-id-collision", "gateway-recovery"]).has(cause.code)) {
        throw cause;
      }
      fail(500, "gateway-recovery", "Stored MCP request result is invalid", { cause });
    }
  }

  async storeResult(requestId, digest, result) {
    try {
      await this.requestStore.put({
        protocol: MCP_REQUEST_RECORD_PROTOCOL,
        requestId,
        digest,
        result,
      });
    } catch (cause) {
      fail(503, "gateway-storage-unavailable", "MCP request result could not be stored", { cause });
    }
  }

  async executeFresh(request, digest) {
    let rawConnection;
    try {
      rawConnection = await this.connectionStore.get(request.connectionId);
    } catch (cause) {
      fail(503, "gateway-storage-unavailable", "MCP connection storage is unavailable", { cause });
    }
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
      await this.storeResult(request.requestId, digest, result);
      return result;
    }

    let rawDecision;
    try {
      rawDecision = await this.authorize({ connection, request, tool: descriptor });
    } catch (cause) {
      fail(503, "authority-unavailable", "Greenways authority could not validate the MCP request", { cause });
    }
    const decision = contract(() => normalizeAuthority(rawDecision));
    if (!decision.allowed) fail(403, "authority-denied", `Greenways authority denied the tool: ${decision.reason}`);
    const handler = this.handlers[request.tool];
    if (!handler) fail(503, "tool-unavailable", "The granted MCP tool is not available on this gateway");
    let rawHandled;
    try {
      rawHandled = await handler(request.arguments, {
        identity: connection.identity,
        client: connection.client,
        route: connection.route,
        requestId: request.requestId,
        authority: decision,
      });
    } catch (cause) {
      fail(502, "tool-failed", "The Greenways MCP read handler failed", { cause });
    }
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
    await this.storeResult(request.requestId, digest, result);
    return result;
  }
}
