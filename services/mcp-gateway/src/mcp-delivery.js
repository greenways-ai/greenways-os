import {
  canonical,
  normalizeRequest,
  toolDescriptor,
  validateBoundedPublicValue,
  validateDigest,
} from "./protocol.js";

export const MCP_DELIVERY_PROTOCOL = "greenways-mcp-delivery/1";
export const MCP_DELIVERY_LEASE_PROTOCOL = "greenways-mcp-delivery-lease/1";
export const MCP_DELIVERY_DEFAULT_LEASE_MS = 30 * 1000;

const DELIVERY_ID = /^mcp\/delivery\/[A-Za-z0-9._:-]{8,160}$/;
const DELIVERY_LEASE_ID = /^mcp\/delivery-lease\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE_ID = /^(beacon|home-node)\/[A-Za-z0-9][A-Za-z0-9._:/-]{2,160}$/;
const CONNECTION_ID = /^mcp\/connection\/[A-Za-z0-9._:-]{8,160}$/;
const GENERAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,180}$/;
const DELIVERY_STATES = new Set(["queued", "leased", "completed"]);
const AVAILABILITY = new Set(["replicated", "device", "hybrid"]);
const PROVENANCE_KINDS = new Set(["authority", "snapshot", "receipt", "resource", "device"]);
const MAX_PROVENANCE = 16;
const MAX_LEASE_MS = 2 * 60 * 1000;

export class McpDeliveryError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = "McpDeliveryError";
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message, options) {
  throw new McpDeliveryError(status, code, message, options);
}

function plainObject(value, label, status = 500) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(status, "delivery-invalid", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(status, "delivery-invalid", `${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label, status = 500) {
  const input = plainObject(value, label, status);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      fail(status, "delivery-invalid", `${label} contains an unsupported field: ${key}`);
    }
  }
  return input;
}

function string(value, label, maximum = 240, status = 500) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    fail(status, "delivery-invalid", `${label} is invalid`);
  }
  return value.trim();
}

function identifier(value, label, pattern = GENERAL_ID, status = 500) {
  const output = string(value, label, 180, status);
  if (!pattern.test(output)) fail(status, "delivery-invalid", `${label} is invalid`);
  return output;
}

function canonicalTime(value, label, status = 500) {
  const output = string(value, label, 80, status);
  if (!Number.isFinite(Date.parse(output)) || new Date(output).toISOString() !== output) {
    fail(status, "delivery-invalid", `${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function optionalTime(value, label, status = 500) {
  return value === null || value === undefined ? null : canonicalTime(value, label, status);
}

function clone(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    fail(500, "delivery-recovery", `${label} must be structured-cloneable`, { cause });
  }
}

function repositoryDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(500, "delivery-recovery", "MCP delivery repository clock is invalid");
  }
  return value;
}

function leaseLifetime(value) {
  const output = value === undefined ? MCP_DELIVERY_DEFAULT_LEASE_MS : value;
  if (!Number.isSafeInteger(output) || output < 1000 || output > MAX_LEASE_MS) {
    fail(500, "delivery-recovery", "MCP delivery lease lifetime is invalid");
  }
  return output;
}

export function normalizeMcpDeliveryRouteId(value, status = 500) {
  return identifier(value, "MCP delivery route id", ROUTE_ID, status);
}

export function normalizeMcpDeliveryId(value, status = 500) {
  return identifier(value, "MCP delivery id", DELIVERY_ID, status);
}

export function normalizeMcpDeliveryLeaseId(value, status = 500) {
  return identifier(value, "MCP delivery lease id", DELIVERY_LEASE_ID, status).toLowerCase();
}

export function mcpDeliveryIdForRequest(requestIdValue) {
  const requestId = identifier(
    requestIdValue,
    "MCP delivery request id",
    /^mcp\/request\/[A-Za-z0-9._:-]{8,160}$/,
    500,
  );
  return `mcp/delivery/${requestId.slice("mcp/request/".length)}`;
}

function normalizeRoute(value) {
  const input = closedKeys(value, new Set(["kind", "id"]), "MCP delivery route");
  const kind = string(input.kind, "MCP delivery route kind", 32);
  if (!new Set(["beacon", "home-node"]).has(kind)) {
    fail(500, "delivery-invalid", "MCP delivery route kind is unsupported");
  }
  const id = normalizeMcpDeliveryRouteId(input.id);
  if (!id.startsWith(`${kind}/`)) {
    fail(500, "delivery-invalid", "MCP delivery route id is not bound to its kind");
  }
  return Object.freeze({ kind, id });
}

function normalizeIdentity(value) {
  const input = closedKeys(value, new Set(["id", "keyId"]), "MCP delivery identity");
  return Object.freeze({
    id: identifier(input.id, "MCP delivery identity id"),
    keyId: validateDigest(input.keyId, "MCP delivery identity key id"),
  });
}

function normalizeClient(value) {
  const input = closedKeys(value, new Set(["id", "name"]), "MCP delivery client");
  return Object.freeze({
    id: identifier(input.id, "MCP delivery client id"),
    name: string(input.name, "MCP delivery client name", 100),
  });
}

function normalizeAuthority(value) {
  const input = closedKeys(
    value,
    new Set(["ref", "digest", "observedAt"]),
    "MCP delivery authority evidence",
  );
  return Object.freeze({
    ref: string(input.ref, "MCP delivery authority ref", 240),
    digest: input.digest === null || input.digest === undefined
      ? null
      : validateDigest(input.digest, "MCP delivery authority digest"),
    observedAt: optionalTime(input.observedAt, "MCP delivery authority observedAt"),
  });
}

function normalizeProvenance(value) {
  if (!Array.isArray(value) || value.length > MAX_PROVENANCE) {
    fail(500, "delivery-invalid", "MCP delivery result provenance must be a bounded array");
  }
  return Object.freeze(value.map((entry, index) => {
    const input = closedKeys(
      entry,
      new Set(["kind", "ref", "digest", "observedAt"]),
      `MCP delivery provenance ${index}`,
    );
    const kind = string(input.kind, `MCP delivery provenance ${index} kind`, 40);
    if (!PROVENANCE_KINDS.has(kind)) {
      fail(500, "delivery-invalid", `MCP delivery provenance ${index} kind is unsupported`);
    }
    return Object.freeze({
      kind,
      ref: string(input.ref, `MCP delivery provenance ${index} ref`, 240),
      digest: input.digest === null || input.digest === undefined
        ? null
        : validateDigest(input.digest, `MCP delivery provenance ${index} digest`),
      observedAt: optionalTime(input.observedAt, `MCP delivery provenance ${index} observedAt`),
    });
  }));
}

export function normalizeMcpDeliveryResult(value) {
  const input = closedKeys(
    value,
    new Set(["availability", "value", "provenance"]),
    "MCP delivery result",
  );
  const availability = string(input.availability, "MCP delivery result availability", 40);
  if (!AVAILABILITY.has(availability)) {
    fail(500, "delivery-invalid", "MCP delivery result availability is unsupported");
  }
  return Object.freeze({
    availability,
    value: validateBoundedPublicValue(input.value, "MCP delivery result value"),
    provenance: normalizeProvenance(input.provenance ?? []),
  });
}

export function normalizeMcpDeliveryLease(value) {
  if (value === null || value === undefined) return null;
  const input = closedKeys(
    value,
    new Set(["protocol", "id", "consumerId", "claimedAt", "expiresAt"]),
    "MCP delivery lease",
  );
  if (input.protocol !== MCP_DELIVERY_LEASE_PROTOCOL) {
    fail(500, "delivery-recovery", "MCP delivery lease protocol is unsupported");
  }
  const claimedAt = canonicalTime(input.claimedAt, "MCP delivery lease claimedAt");
  const expiresAt = canonicalTime(input.expiresAt, "MCP delivery lease expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) {
    fail(500, "delivery-recovery", "MCP delivery lease expiry must follow acquisition");
  }
  return Object.freeze({
    protocol: MCP_DELIVERY_LEASE_PROTOCOL,
    id: normalizeMcpDeliveryLeaseId(input.id),
    consumerId: normalizeMcpDeliveryRouteId(input.consumerId),
    claimedAt,
    expiresAt,
  });
}

function structuralRequest(value) {
  const input = plainObject(value, "MCP delivery request");
  const issuedAt = canonicalTime(input.issuedAt, "MCP delivery request issuedAt");
  try {
    return normalizeRequest(input, { now: () => new Date(issuedAt) });
  } catch (cause) {
    fail(500, "delivery-recovery", "Stored MCP delivery request is invalid", { cause });
  }
}

function immutableRecord(record) {
  return {
    protocol: record.protocol,
    id: record.id,
    digest: record.digest,
    route: record.route,
    request: record.request,
    identity: record.identity,
    client: record.client,
    authority: record.authority,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

export function normalizeMcpDeliveryRecord(value) {
  const input = closedKeys(
    value,
    new Set([
      "protocol", "id", "digest", "route", "request", "identity", "client",
      "authority", "createdAt", "expiresAt", "state", "lease", "result", "completedAt",
    ]),
    "MCP delivery record",
  );
  if (input.protocol !== MCP_DELIVERY_PROTOCOL || !DELIVERY_STATES.has(input.state)) {
    fail(500, "delivery-recovery", "MCP delivery record protocol or state is invalid");
  }
  const request = structuralRequest(input.request);
  const createdAt = canonicalTime(input.createdAt, "MCP delivery createdAt");
  const expiresAt = canonicalTime(input.expiresAt, "MCP delivery expiresAt");
  if (input.id !== mcpDeliveryIdForRequest(request.requestId)
      || input.expiresAt !== request.expiresAt
      || Date.parse(createdAt) < Date.parse(request.issuedAt)
      || Date.parse(expiresAt) <= Date.parse(createdAt)) {
    fail(500, "delivery-recovery", "MCP delivery identity or lifetime is invalid");
  }
  const route = normalizeRoute(input.route);
  const descriptor = toolDescriptor(request.tool);
  if (!descriptor || descriptor.availability !== "device-bound") {
    fail(500, "delivery-recovery", "MCP delivery accepts device-bound tools only");
  }
  const lease = normalizeMcpDeliveryLease(input.lease);
  const result = input.result === null || input.result === undefined
    ? null
    : normalizeMcpDeliveryResult(input.result);
  const completedAt = optionalTime(input.completedAt, "MCP delivery completedAt");
  if ((input.state === "queued" && (lease || result || completedAt))
      || (input.state === "leased" && (!lease || result || completedAt))
      || (input.state === "completed" && (!lease || !result || !completedAt))) {
    fail(500, "delivery-recovery", "MCP delivery mutable state is inconsistent");
  }
  if (lease) {
    if (Date.parse(lease.claimedAt) < Date.parse(createdAt)
        || Date.parse(lease.expiresAt) > Date.parse(expiresAt)) {
      fail(500, "delivery-recovery", "MCP delivery lease is outside the delivery lifetime");
    }
  }
  if (completedAt && (Date.parse(completedAt) < Date.parse(lease.claimedAt)
      || Date.parse(completedAt) > Date.parse(expiresAt))) {
    fail(500, "delivery-recovery", "MCP delivery completion is outside its lifetime");
  }
  const output = Object.freeze({
    protocol: MCP_DELIVERY_PROTOCOL,
    id: normalizeMcpDeliveryId(input.id),
    digest: validateDigest(input.digest, "MCP delivery digest"),
    route,
    request,
    identity: normalizeIdentity(input.identity),
    client: normalizeClient(input.client),
    authority: normalizeAuthority(input.authority),
    createdAt,
    expiresAt,
    state: input.state,
    lease,
    result,
    completedAt,
  });
  validateBoundedPublicValue(output, "MCP delivery record");
  return output;
}

function currentRecord(value) {
  return value === null || value === undefined ? null : normalizeMcpDeliveryRecord(value);
}

function transition(record, changed, extra = {}) {
  return Object.freeze({
    record: record === null ? null : clone(record, "MCP delivery transition"),
    changed,
    ...extra,
  });
}

export function enqueueMcpDeliveryState(currentValue, queuedValue) {
  const queued = normalizeMcpDeliveryRecord(queuedValue);
  if (queued.state !== "queued") {
    fail(500, "delivery-recovery", "New MCP delivery records must be queued");
  }
  const current = currentRecord(currentValue);
  if (!current) return transition(queued, true);
  if (current.id !== queued.id || current.route.id !== queued.route.id) {
    fail(500, "delivery-recovery", "MCP delivery repository identity changed");
  }
  if (current.digest !== queued.digest
      || canonical(immutableRecord(current)) !== canonical(immutableRecord(queued))) {
    fail(409, "delivery-id-collision", "MCP delivery ID was reused with different content");
  }
  return transition(current, false);
}

export function claimMcpDeliveryState(
  currentValue,
  claimValue,
  nowValue,
  lifetimeMs = MCP_DELIVERY_DEFAULT_LEASE_MS,
) {
  const current = currentRecord(currentValue);
  if (!current) fail(404, "delivery-missing", "MCP delivery does not exist");
  const input = closedKeys(
    claimValue,
    new Set(["routeId", "consumerId", "leaseId"]),
    "MCP delivery claim",
  );
  const routeId = normalizeMcpDeliveryRouteId(input.routeId);
  if (current.route.id !== routeId) {
    fail(500, "delivery-recovery", "MCP delivery route identity changed");
  }
  const observed = repositoryDate(nowValue);
  if (Date.parse(current.expiresAt) <= observed.getTime()) {
    fail(410, "delivery-expired", "MCP delivery expired before it could be claimed");
  }
  if (current.state === "completed") {
    return transition(current, false, { disposition: "completed" });
  }
  if (current.state === "leased" && Date.parse(current.lease.expiresAt) > observed.getTime()) {
    return transition(current, false, { disposition: "pending" });
  }
  const lease = normalizeMcpDeliveryLease({
    protocol: MCP_DELIVERY_LEASE_PROTOCOL,
    id: normalizeMcpDeliveryLeaseId(input.leaseId),
    consumerId: normalizeMcpDeliveryRouteId(input.consumerId),
    claimedAt: observed.toISOString(),
    expiresAt: new Date(Math.min(
      observed.getTime() + leaseLifetime(lifetimeMs),
      Date.parse(current.expiresAt),
    )).toISOString(),
  });
  const next = normalizeMcpDeliveryRecord({
    ...current,
    state: "leased",
    lease,
    result: null,
    completedAt: null,
  });
  return transition(next, true, { disposition: "acquired" });
}

export function completeMcpDeliveryState(currentValue, completionValue, nowValue) {
  const current = currentRecord(currentValue);
  if (!current) fail(404, "delivery-missing", "MCP delivery does not exist");
  const input = closedKeys(
    completionValue,
    new Set(["routeId", "deliveryId", "digest", "leaseId", "result"]),
    "MCP delivery completion",
  );
  const routeId = normalizeMcpDeliveryRouteId(input.routeId);
  const deliveryId = normalizeMcpDeliveryId(input.deliveryId);
  const leaseId = normalizeMcpDeliveryLeaseId(input.leaseId);
  const digest = validateDigest(input.digest, "MCP delivery completion digest");
  const observed = repositoryDate(nowValue);
  if (current.route.id !== routeId || current.id !== deliveryId) {
    fail(500, "delivery-recovery", "MCP delivery completion identity changed");
  }
  if (current.digest !== digest) {
    fail(409, "delivery-id-collision", "MCP delivery digest changed before completion");
  }
  if (current.state !== "leased"
      || current.lease.id !== leaseId
      || Date.parse(current.lease.expiresAt) <= observed.getTime()
      || Date.parse(current.expiresAt) <= observed.getTime()) {
    fail(409, "delivery-lease-stale", "MCP delivery lease is no longer current");
  }
  const next = normalizeMcpDeliveryRecord({
    ...current,
    state: "completed",
    result: normalizeMcpDeliveryResult(input.result),
    completedAt: observed.toISOString(),
  });
  return transition(next, true);
}

export function releaseMcpDeliveryState(currentValue, releaseValue) {
  const current = currentRecord(currentValue);
  if (!current) return transition(null, false, { released: false });
  const input = closedKeys(
    releaseValue,
    new Set(["routeId", "deliveryId", "digest", "leaseId"]),
    "MCP delivery release",
  );
  const routeId = normalizeMcpDeliveryRouteId(input.routeId);
  const deliveryId = normalizeMcpDeliveryId(input.deliveryId);
  const leaseId = normalizeMcpDeliveryLeaseId(input.leaseId);
  const digest = validateDigest(input.digest, "MCP delivery release digest");
  if (current.route.id !== routeId || current.id !== deliveryId) {
    fail(500, "delivery-recovery", "MCP delivery release identity changed");
  }
  if (current.digest !== digest) {
    fail(409, "delivery-id-collision", "MCP delivery digest changed before release");
  }
  if (current.state !== "leased" || current.lease.id !== leaseId) {
    return transition(current, false, { released: false });
  }
  const next = normalizeMcpDeliveryRecord({
    ...current,
    state: "queued",
    lease: null,
    result: null,
    completedAt: null,
  });
  return transition(next, true, { released: true });
}

export class MemoryMcpDeliveryRepository {
  constructor({ now = () => new Date(), leaseLifetimeMs = MCP_DELIVERY_DEFAULT_LEASE_MS } = {}) {
    if (typeof now !== "function") throw new TypeError("MCP delivery repository requires a clock");
    this.now = now;
    this.leaseLifetimeMs = leaseLifetimeMs;
    this.records = new Map();
  }

  currentDate() {
    return repositoryDate(this.now());
  }

  async enqueue(value) {
    const queued = normalizeMcpDeliveryRecord(value);
    const transitionValue = enqueueMcpDeliveryState(this.records.get(queued.id) ?? null, queued);
    if (transitionValue.changed) this.records.set(queued.id, clone(transitionValue.record, "MCP delivery record"));
    return clone(transitionValue.record, "MCP delivery record");
  }

  async read(routeIdValue, deliveryIdValue) {
    const routeId = normalizeMcpDeliveryRouteId(routeIdValue);
    const deliveryId = normalizeMcpDeliveryId(deliveryIdValue);
    const value = this.records.get(deliveryId);
    if (!value) return null;
    const record = normalizeMcpDeliveryRecord(value);
    if (record.route.id !== routeId) fail(500, "delivery-recovery", "MCP delivery route identity changed");
    return clone(record, "MCP delivery record");
  }

  async claimNext(routeIdValue, consumerIdValue, leaseIdValue) {
    const routeId = normalizeMcpDeliveryRouteId(routeIdValue);
    const consumerId = normalizeMcpDeliveryRouteId(consumerIdValue);
    const leaseId = normalizeMcpDeliveryLeaseId(leaseIdValue);
    const observed = this.currentDate();
    const candidates = [...this.records.values()]
      .map(normalizeMcpDeliveryRecord)
      .filter((record) => record.route.id === routeId
        && record.state !== "completed"
        && Date.parse(record.expiresAt) > observed.getTime()
        && (record.state === "queued" || Date.parse(record.lease.expiresAt) <= observed.getTime()))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    if (!candidates.length) return null;
    const selected = candidates[0];
    const transitionValue = claimMcpDeliveryState(
      selected,
      { routeId, consumerId, leaseId },
      observed,
      this.leaseLifetimeMs,
    );
    this.records.set(selected.id, clone(transitionValue.record, "MCP delivery record"));
    return clone(transitionValue.record, "MCP delivery record");
  }

  async complete(value) {
    const input = plainObject(value, "MCP delivery repository completion");
    const deliveryId = normalizeMcpDeliveryId(input.deliveryId);
    const transitionValue = completeMcpDeliveryState(
      this.records.get(deliveryId) ?? null,
      input,
      this.currentDate(),
    );
    this.records.set(deliveryId, clone(transitionValue.record, "MCP delivery record"));
    return clone(transitionValue.record, "MCP delivery record");
  }

  async release(value) {
    const input = plainObject(value, "MCP delivery repository release");
    const deliveryId = normalizeMcpDeliveryId(input.deliveryId);
    const transitionValue = releaseMcpDeliveryState(this.records.get(deliveryId) ?? null, input);
    if (transitionValue.changed) this.records.set(deliveryId, clone(transitionValue.record, "MCP delivery record"));
    return transitionValue.released;
  }
}
