import {
  MCP_DELIVERY_DEFAULT_LEASE_MS,
  McpDeliveryError,
  claimMcpDeliveryState,
  completeMcpDeliveryState,
  enqueueMcpDeliveryState,
  normalizeMcpDeliveryId,
  normalizeMcpDeliveryLeaseId,
  normalizeMcpDeliveryRecord,
  normalizeMcpDeliveryRouteId,
  releaseMcpDeliveryState,
} from "./mcp-delivery.js";

const MAX_RECORD_JSON_BYTES = 384 * 1024;
const textEncoder = new TextEncoder();

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL,
  route_kind TEXT NOT NULL CHECK (route_kind IN ('beacon', 'home-node')),
  route_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'completed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  lease_id TEXT,
  consumer_id TEXT,
  lease_expires_at TEXT,
  completed_at TEXT,
  record_json TEXT NOT NULL,
  CHECK (
    (state = 'queued'
      AND lease_id IS NULL
      AND consumer_id IS NULL
      AND lease_expires_at IS NULL
      AND completed_at IS NULL)
    OR
    (state = 'leased'
      AND lease_id IS NOT NULL
      AND consumer_id IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND completed_at IS NULL)
    OR
    (state = 'completed'
      AND lease_id IS NOT NULL
      AND consumer_id IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND completed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS deliveries_route_claimable
ON deliveries(route_id, state, expires_at, lease_expires_at, created_at, id);
`;

const SELECT_BY_ID = `
SELECT
  id, digest, route_kind, route_id, request_id, connection_id, tool, state,
  created_at, expires_at, lease_id, consumer_id, lease_expires_at,
  completed_at, record_json
FROM deliveries
WHERE id = ?
`;

const SELECT_NEXT = `
SELECT
  id, digest, route_kind, route_id, request_id, connection_id, tool, state,
  created_at, expires_at, lease_id, consumer_id, lease_expires_at,
  completed_at, record_json
FROM deliveries
WHERE route_id = ?
  AND expires_at > ?
  AND (
    state = 'queued'
    OR (state = 'leased' AND lease_expires_at <= ?)
  )
ORDER BY created_at, id
LIMIT 1
`;

const UPSERT_RECORD = `
INSERT INTO deliveries (
  id, digest, route_kind, route_id, request_id, connection_id, tool, state,
  created_at, expires_at, lease_id, consumer_id, lease_expires_at,
  completed_at, record_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  digest = excluded.digest,
  route_kind = excluded.route_kind,
  route_id = excluded.route_id,
  request_id = excluded.request_id,
  connection_id = excluded.connection_id,
  tool = excluded.tool,
  state = excluded.state,
  created_at = excluded.created_at,
  expires_at = excluded.expires_at,
  lease_id = excluded.lease_id,
  consumer_id = excluded.consumer_id,
  lease_expires_at = excluded.lease_expires_at,
  completed_at = excluded.completed_at,
  record_json = excluded.record_json
`;

function fail(status, code, message, options) {
  throw new McpDeliveryError(status, code, message, options);
}

function repositoryDate(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(500, "delivery-recovery", "MCP SQLite delivery clock is invalid");
  }
  return value;
}

function rows(cursor) {
  if (!cursor || typeof cursor.toArray !== "function") {
    fail(500, "delivery-recovery", "MCP SQLite delivery cursor is invalid");
  }
  try {
    return cursor.toArray();
  } catch (cause) {
    fail(503, "delivery-store-unavailable", "MCP SQLite delivery row read is unavailable", { cause });
  }
}

function clone(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    fail(500, "delivery-recovery", `${label} must be structured-cloneable`, { cause });
  }
}

function encodeRecord(value) {
  const record = normalizeMcpDeliveryRecord(value);
  let encoded;
  try {
    encoded = JSON.stringify(record);
  } catch (cause) {
    fail(500, "delivery-recovery", "MCP delivery record is not JSON-serializable", { cause });
  }
  if (encoded === undefined || textEncoder.encode(encoded).byteLength > MAX_RECORD_JSON_BYTES) {
    fail(500, "delivery-recovery", "MCP delivery record exceeds its durable storage limit");
  }
  return encoded;
}

function decodeRecord(value) {
  if (typeof value !== "string" || !value) {
    fail(500, "delivery-recovery", "Stored MCP delivery JSON is invalid");
  }
  let decoded;
  try {
    decoded = JSON.parse(value);
  } catch (cause) {
    fail(500, "delivery-recovery", "Stored MCP delivery JSON is invalid", { cause });
  }
  return normalizeMcpDeliveryRecord(decoded);
}

function rowRecord(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail(500, "delivery-recovery", "Stored MCP delivery row is invalid");
  }
  const record = decodeRecord(row.record_json);
  if (row.id !== record.id
      || row.digest !== record.digest
      || row.route_kind !== record.route.kind
      || row.route_id !== record.route.id
      || row.request_id !== record.request.requestId
      || row.connection_id !== record.request.connectionId
      || row.tool !== record.request.tool
      || row.state !== record.state
      || row.created_at !== record.createdAt
      || row.expires_at !== record.expiresAt
      || row.lease_id !== (record.lease?.id ?? null)
      || row.consumer_id !== (record.lease?.consumerId ?? null)
      || row.lease_expires_at !== (record.lease?.expiresAt ?? null)
      || row.completed_at !== record.completedAt) {
    fail(500, "delivery-recovery", "Stored MCP delivery row does not match its record bytes");
  }
  return record;
}

function columns(recordValue) {
  const record = normalizeMcpDeliveryRecord(recordValue);
  return [
    record.id,
    record.digest,
    record.route.kind,
    record.route.id,
    record.request.requestId,
    record.request.connectionId,
    record.request.tool,
    record.state,
    record.createdAt,
    record.expiresAt,
    record.lease?.id ?? null,
    record.lease?.consumerId ?? null,
    record.lease?.expiresAt ?? null,
    record.completedAt,
    encodeRecord(record),
  ];
}

export class SqliteMcpDeliveryRepository {
  constructor(sql, {
    now = () => new Date(),
    leaseLifetimeMs = MCP_DELIVERY_DEFAULT_LEASE_MS,
  } = {}) {
    if (!sql || typeof sql.exec !== "function") {
      throw new TypeError("MCP SQLite delivery repository requires the Durable Object SQL API");
    }
    if (typeof now !== "function") throw new TypeError("MCP SQLite delivery repository requires a clock");
    this.sql = sql;
    this.now = now;
    this.leaseLifetimeMs = leaseLifetimeMs;
    try {
      this.sql.exec(CREATE_SCHEMA);
    } catch (cause) {
      fail(503, "delivery-store-unavailable", "MCP SQLite delivery schema setup is unavailable", { cause });
    }
  }

  currentDate() {
    return repositoryDate(this.now);
  }

  queryOne(statement, ...parameters) {
    let cursor;
    try {
      cursor = this.sql.exec(statement, ...parameters);
    } catch (cause) {
      fail(503, "delivery-store-unavailable", "MCP SQLite delivery read is unavailable", { cause });
    }
    const values = rows(cursor);
    if (values.length > 1) fail(500, "delivery-recovery", "MCP SQLite delivery query returned multiple rows");
    return values.length ? rowRecord(values[0]) : null;
  }

  write(record) {
    try {
      this.sql.exec(UPSERT_RECORD, ...columns(record));
    } catch (cause) {
      if (cause instanceof McpDeliveryError) throw cause;
      fail(503, "delivery-store-unavailable", "MCP SQLite delivery write is unavailable", { cause });
    }
  }

  enqueue(value) {
    const queued = normalizeMcpDeliveryRecord(value);
    const transition = enqueueMcpDeliveryState(this.queryOne(SELECT_BY_ID, queued.id), queued);
    if (transition.changed) this.write(transition.record);
    return clone(transition.record, "MCP delivery record");
  }

  read(routeIdValue, deliveryIdValue) {
    const routeId = normalizeMcpDeliveryRouteId(routeIdValue);
    const deliveryId = normalizeMcpDeliveryId(deliveryIdValue);
    const record = this.queryOne(SELECT_BY_ID, deliveryId);
    if (!record) return null;
    if (record.route.id !== routeId) {
      fail(500, "delivery-recovery", "MCP Durable Object delivery route identity changed");
    }
    return clone(record, "MCP delivery record");
  }

  claimNext(routeIdValue, consumerIdValue, leaseIdValue) {
    const routeId = normalizeMcpDeliveryRouteId(routeIdValue);
    const consumerId = normalizeMcpDeliveryRouteId(consumerIdValue);
    const leaseId = normalizeMcpDeliveryLeaseId(leaseIdValue);
    const observed = this.currentDate();
    const record = this.queryOne(
      SELECT_NEXT,
      routeId,
      observed.toISOString(),
      observed.toISOString(),
    );
    if (!record) return null;
    const transition = claimMcpDeliveryState(
      record,
      { routeId, consumerId, leaseId },
      observed,
      this.leaseLifetimeMs,
    );
    this.write(transition.record);
    return clone(transition.record, "MCP delivery record");
  }

  complete(value) {
    const input = value && typeof value === "object" ? value : {};
    const deliveryId = normalizeMcpDeliveryId(input.deliveryId);
    const transition = completeMcpDeliveryState(
      this.queryOne(SELECT_BY_ID, deliveryId),
      input,
      this.currentDate(),
    );
    this.write(transition.record);
    return clone(transition.record, "MCP delivery record");
  }

  release(value) {
    const input = value && typeof value === "object" ? value : {};
    const deliveryId = normalizeMcpDeliveryId(input.deliveryId);
    const transition = releaseMcpDeliveryState(this.queryOne(SELECT_BY_ID, deliveryId), input);
    if (transition.changed) this.write(transition.record);
    return transition.released;
  }
}
