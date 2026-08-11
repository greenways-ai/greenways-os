import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudflareMcpDeliveryRepository,
} from "../src/cloudflare-delivery-store.js";
import { executeMcpDeliveryStoreRpc } from "../src/delivery-store-rpc.js";
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
const REQUEST_ID = "mcp/request/delivery-cloudflare-0001";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const LEASE_ID = "mcp/delivery-lease/01234567-89ab-4def-8123-000000000003";

function queued() {
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
      arguments: { query: "mailbox", limit: 20, cursor: null },
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
  };
}

class FakeNamespace {
  constructor(now) {
    this.now = now;
    this.names = [];
    this.calls = [];
    this.repositories = new Map();
  }

  getByName(name) {
    this.names.push(name);
    let repository = this.repositories.get(name);
    if (!repository) {
      repository = new MemoryMcpDeliveryRepository({ now: this.now, leaseLifetimeMs: 10_000 });
      this.repositories.set(name, repository);
    }
    const call = (method, operation) => async (value) => {
      this.calls.push({ name, method, value });
      return executeMcpDeliveryStoreRpc(() => operation(value));
    };
    return {
      enqueue: call("enqueue", (value) => repository.enqueue(value)),
      read: call("read", (value) => repository.read(value.routeId, value.deliveryId)),
      claim: call("claim", (value) => repository.claimNext(value.routeId, value.consumerId, value.leaseId)),
      complete: call("complete", (value) => repository.complete(value)),
      release: call("release", (value) => repository.release(value)),
    };
  }
}

function hasCode(error, code) {
  return error instanceof McpDeliveryError && error.code === code;
}

test("routes all mailbox operations through the exact route atom and observes completion", async () => {
  let now = new Date(NOW);
  const namespace = new FakeNamespace(() => new Date(now));
  let completeOnSleep = null;
  const repository = new CloudflareMcpDeliveryRepository(namespace, {
    now: () => new Date(now),
    pollIntervalMs: 10,
    sleep: async (milliseconds) => {
      now = new Date(now.getTime() + milliseconds);
      if (completeOnSleep) {
        const operation = completeOnSleep;
        completeOnSleep = null;
        await operation();
      }
    },
  });
  const inserted = await repository.enqueue(queued());
  const leased = await repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_ID);
  completeOnSleep = () => repository.complete({
    routeId: ROUTE_ID,
    deliveryId: inserted.id,
    digest: inserted.digest,
    leaseId: leased.lease.id,
    result: {
      availability: "device",
      value: { matches: [] },
      provenance: [{ kind: "device", ref: ROUTE_ID, digest: null, observedAt: NOW.toISOString() }],
    },
  });
  const completed = await repository.wait(ROUTE_ID, inserted.id, inserted.digest, 100);
  assert.equal(completed.state, "completed");
  assert.ok(namespace.names.every((name) => name === ROUTE_ID));
  assert.ok(namespace.calls.some(({ method }) => method === "claim"));
  assert.ok(namespace.calls.some(({ method }) => method === "read"));
});

test("contains raw route atom failures behind an opaque retryable error", async () => {
  const repository = new CloudflareMcpDeliveryRepository({
    getByName: () => ({
      read: async () => {
        throw new Error("mailbox-secret-must-not-leak");
      },
    }),
  });
  await assert.rejects(
    repository.read(ROUTE_ID, mcpDeliveryIdForRequest(REQUEST_ID)),
    (error) => hasCode(error, "delivery-store-unavailable")
      && error.status === 503
      && !error.message.includes("mailbox-secret-must-not-leak"),
  );
});

test("rejects malformed delivery RPC responses as recovery failures", async () => {
  const repository = new CloudflareMcpDeliveryRepository({
    getByName: () => ({
      read: async () => ({ protocol: "unknown/1", ok: true, value: null }),
    }),
  });
  await assert.rejects(
    repository.read(ROUTE_ID, mcpDeliveryIdForRequest(REQUEST_ID)),
    (error) => hasCode(error, "delivery-recovery"),
  );
});
