import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  MCP_DELIVERY_PROTOCOL,
  McpDeliveryError,
  mcpDeliveryIdForRequest,
} from "../src/mcp-delivery.js";
import { MCP_REQUEST_PROTOCOL } from "../src/protocol.js";
import { SqliteMcpDeliveryRepository } from "../src/sqlite-delivery-store.js";

const NOW = new Date("2026-08-11T07:00:00.000Z");
const ROUTE_ID = "beacon/personal";
const CONNECTION_ID = "mcp/connection/01234567-89ab-4def-8123-000000000001:01234567-89ab-4def-8123-000000000002";
const REQUEST_ID = "mcp/request/delivery-sqlite-0001";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const LEASE_ONE = "mcp/delivery-lease/01234567-89ab-4def-8123-000000000003";
const LEASE_TWO = "mcp/delivery-lease/01234567-89ab-4def-8123-000000000004";

class NodeSqlAdapter {
  constructor() {
    this.database = new DatabaseSync(":memory:");
  }

  exec(query, ...parameters) {
    const command = query.trimStart().slice(0, 6).toUpperCase();
    if (parameters.length === 0 && command === "CREATE") {
      this.database.exec(query);
      return { toArray: () => [] };
    }
    const statement = this.database.prepare(query);
    if (command === "SELECT") {
      const values = statement.all(...parameters);
      return { toArray: () => values };
    }
    statement.run(...parameters);
    return { toArray: () => [] };
  }
}

function queued(overrides = {}) {
  return {
    protocol: MCP_DELIVERY_PROTOCOL,
    id: mcpDeliveryIdForRequest(REQUEST_ID),
    digest: DIGEST_A,
    route: { kind: "beacon", id: ROUTE_ID },
    request: {
      protocol: MCP_REQUEST_PROTOCOL,
      requestId: REQUEST_ID,
      connectionId: CONNECTION_ID,
      tool: "chats.search",
      arguments: { query: "durable delivery", limit: 20, cursor: null },
      issuedAt: NOW.toISOString(),
      expiresAt: "2026-08-11T07:01:00.000Z",
    },
    identity: { id: "identity/alice", keyId: DIGEST_A },
    client: { id: "chatgpt.greenways", name: "ChatGPT" },
    authority: { ref: "grant/mcp/chats/alice", digest: DIGEST_B, observedAt: NOW.toISOString() },
    createdAt: NOW.toISOString(),
    expiresAt: "2026-08-11T07:01:00.000Z",
    state: "queued",
    lease: null,
    result: null,
    completedAt: null,
    ...overrides,
  };
}

function hasCode(error, code) {
  return error instanceof McpDeliveryError && error.code === code;
}

test("persists queued, leased, and completed route deliveries across repository restarts", () => {
  const sql = new NodeSqlAdapter();
  const repository = new SqliteMcpDeliveryRepository(sql, { now: () => new Date(NOW) });
  const inserted = repository.enqueue(queued());
  const leased = repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_ONE);
  assert.equal(leased.state, "leased");

  const restarted = new SqliteMcpDeliveryRepository(sql, { now: () => new Date(NOW) });
  assert.equal(restarted.read(ROUTE_ID, inserted.id).lease.id, LEASE_ONE);
  const completed = restarted.complete({
    routeId: ROUTE_ID,
    deliveryId: inserted.id,
    digest: inserted.digest,
    leaseId: LEASE_ONE,
    result: {
      availability: "device",
      value: { matches: [{ id: "chat/1" }] },
      provenance: [{ kind: "device", ref: ROUTE_ID, digest: null, observedAt: NOW.toISOString() }],
    },
  });
  assert.equal(completed.state, "completed");

  const replayed = new SqliteMcpDeliveryRepository(sql, { now: () => new Date(NOW) });
  assert.deepEqual(replayed.read(ROUTE_ID, inserted.id), completed);
  assert.deepEqual(replayed.enqueue(queued()), completed);
  assert.throws(
    () => replayed.enqueue(queued({ digest: DIGEST_B })),
    (error) => hasCode(error, "delivery-id-collision"),
  );
});

test("reclaims an expired SQLite lease and fences the previous consumer", () => {
  let now = new Date(NOW);
  const sql = new NodeSqlAdapter();
  const repository = new SqliteMcpDeliveryRepository(sql, {
    now: () => new Date(now),
    leaseLifetimeMs: 10_000,
  });
  const inserted = repository.enqueue(queued());
  repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_ONE);
  now = new Date("2026-08-11T07:00:11.000Z");
  const replacement = repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_TWO);
  assert.equal(replacement.lease.id, LEASE_TWO);
  assert.throws(
    () => repository.complete({
      routeId: ROUTE_ID,
      deliveryId: inserted.id,
      digest: inserted.digest,
      leaseId: LEASE_ONE,
      result: { availability: "device", value: {}, provenance: [] },
    }),
    (error) => hasCode(error, "delivery-lease-stale"),
  );
});

test("does not claim expired deliveries and rejects corrupt persisted record bytes", () => {
  let now = new Date(NOW);
  const sql = new NodeSqlAdapter();
  const repository = new SqliteMcpDeliveryRepository(sql, { now: () => new Date(now) });
  const inserted = repository.enqueue(queued());
  now = new Date("2026-08-11T07:01:00.000Z");
  assert.equal(repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_ONE), null);

  sql.database.exec("UPDATE deliveries SET record_json = '{\"authority\":'");
  assert.throws(
    () => repository.read(ROUTE_ID, inserted.id),
    (error) => hasCode(error, "delivery-recovery")
      && !error.message.includes("authority"),
  );
});
