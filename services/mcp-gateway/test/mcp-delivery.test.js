import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_DELIVERY_PROTOCOL,
  McpDeliveryError,
  MemoryMcpDeliveryRepository,
  mcpDeliveryIdForRequest,
} from "../src/mcp-delivery.js";
import { MCP_REQUEST_PROTOCOL } from "../src/protocol.js";

const NOW = new Date("2026-08-11T07:00:00.000Z");
const ROUTE_ID = "home-node/personal";
const CONNECTION_ID = "mcp/connection/01234567-89ab-4def-8123-000000000001:01234567-89ab-4def-8123-000000000002";
const REQUEST_ID = "mcp/request/delivery-0001";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const LEASE_ONE = "mcp/delivery-lease/01234567-89ab-4def-8123-000000000003";
const LEASE_TWO = "mcp/delivery-lease/01234567-89ab-4def-8123-000000000004";

function queued(overrides = {}) {
  return {
    protocol: MCP_DELIVERY_PROTOCOL,
    id: mcpDeliveryIdForRequest(REQUEST_ID),
    digest: DIGEST_A,
    route: { kind: "home-node", id: ROUTE_ID },
    request: {
      protocol: MCP_REQUEST_PROTOCOL,
      requestId: REQUEST_ID,
      connectionId: CONNECTION_ID,
      tool: "chats.search",
      arguments: { query: "architecture", limit: 20, cursor: null },
      issuedAt: NOW.toISOString(),
      expiresAt: "2026-08-11T07:01:00.000Z",
    },
    identity: { id: "identity/alice", keyId: DIGEST_A },
    client: { id: "chatgpt.greenways", name: "ChatGPT" },
    authority: {
      ref: "grant/mcp/chats/alice",
      digest: DIGEST_B,
      observedAt: NOW.toISOString(),
    },
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

test("enqueues exact device reads idempotently and rejects changed content", async () => {
  const repository = new MemoryMcpDeliveryRepository({ now: () => new Date(NOW) });
  const first = await repository.enqueue(queued());
  assert.equal(first.state, "queued");
  assert.deepEqual(await repository.enqueue(queued()), first);
  await assert.rejects(
    repository.enqueue(queued({ digest: DIGEST_B })),
    (error) => hasCode(error, "delivery-id-collision"),
  );
});

test("binds a delivery lease to the exact route consumer", async () => {
  const repository = new MemoryMcpDeliveryRepository({ now: () => new Date(NOW) });
  await repository.enqueue(queued());
  await assert.rejects(
    repository.claimNext(ROUTE_ID, "beacon/other", LEASE_ONE),
    (error) => hasCode(error, "delivery-consumer-mismatch") && error.status === 403,
  );
  assert.equal((await repository.read(ROUTE_ID, mcpDeliveryIdForRequest(REQUEST_ID))).state, "queued");
});

test("leases one pending read, fences duplicate consumers, and stores an attributable result", async () => {
  const repository = new MemoryMcpDeliveryRepository({ now: () => new Date(NOW) });
  const inserted = await repository.enqueue(queued());
  const leased = await repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_ONE);
  assert.equal(leased.state, "leased");
  assert.equal(leased.lease.id, LEASE_ONE);
  assert.equal(await repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_TWO), null);

  const completed = await repository.complete({
    routeId: ROUTE_ID,
    deliveryId: inserted.id,
    digest: inserted.digest,
    leaseId: LEASE_ONE,
    result: {
      availability: "device",
      value: { matches: [{ id: "chat/1", title: "Architecture" }] },
      provenance: [{
        kind: "device",
        ref: ROUTE_ID,
        digest: null,
        observedAt: NOW.toISOString(),
      }],
    },
  });
  assert.equal(completed.state, "completed");
  assert.equal(completed.result.availability, "device");
  assert.deepEqual(await repository.read(ROUTE_ID, inserted.id), completed);
});

test("rejects completion without provenance for the exact route", async () => {
  const repository = new MemoryMcpDeliveryRepository({ now: () => new Date(NOW) });
  const inserted = await repository.enqueue(queued());
  await repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_ONE);
  await assert.rejects(
    repository.complete({
      routeId: ROUTE_ID,
      deliveryId: inserted.id,
      digest: inserted.digest,
      leaseId: LEASE_ONE,
      result: {
        availability: "device",
        value: { matches: [] },
        provenance: [{
          kind: "device",
          ref: "home-node/other",
          digest: null,
          observedAt: NOW.toISOString(),
        }],
      },
    }),
    (error) => hasCode(error, "delivery-result-unattributed") && error.status === 400,
  );
  assert.equal((await repository.read(ROUTE_ID, inserted.id)).state, "leased");
});

test("replaces an expired delivery lease and fences the former consumer", async () => {
  let now = new Date(NOW);
  const repository = new MemoryMcpDeliveryRepository({
    now: () => new Date(now),
    leaseLifetimeMs: 10_000,
  });
  const inserted = await repository.enqueue(queued());
  await repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_ONE);
  now = new Date("2026-08-11T07:00:11.000Z");
  const replacement = await repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_TWO);
  assert.equal(replacement.lease.id, LEASE_TWO);

  await assert.rejects(
    repository.complete({
      routeId: ROUTE_ID,
      deliveryId: inserted.id,
      digest: inserted.digest,
      leaseId: LEASE_ONE,
      result: { availability: "device", value: {}, provenance: [] },
    }),
    (error) => hasCode(error, "delivery-lease-stale"),
  );
  assert.equal(await repository.release({
    routeId: ROUTE_ID,
    deliveryId: inserted.id,
    digest: inserted.digest,
    leaseId: LEASE_ONE,
  }), false);
  assert.equal(await repository.release({
    routeId: ROUTE_ID,
    deliveryId: inserted.id,
    digest: inserted.digest,
    leaseId: LEASE_TWO,
  }), true);
  assert.equal((await repository.read(ROUTE_ID, inserted.id)).state, "queued");
});

test("does not offer expired reads to a Home Node or Beacon consumer", async () => {
  let now = new Date(NOW);
  const repository = new MemoryMcpDeliveryRepository({ now: () => new Date(now) });
  await repository.enqueue(queued());
  now = new Date("2026-08-11T07:01:00.000Z");
  assert.equal(await repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_ONE), null);
});
