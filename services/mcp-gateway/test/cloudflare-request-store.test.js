import assert from "node:assert/strict";
import test from "node:test";
import { CloudflareMcpRequestStore } from "../src/cloudflare-request-store.js";
import {
  McpRequestStoreError,
  MemoryMcpRequestStore,
} from "../src/request-store.js";
import { executeMcpRequestStoreRpc } from "../src/request-store-rpc.js";
import { MCP_REQUEST_CLAIM_PROTOCOL } from "../src/protocol.js";

const START = new Date("2026-08-11T05:00:00.000Z");
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function claim(overrides = {}) {
  return {
    protocol: MCP_REQUEST_CLAIM_PROTOCOL,
    requestId: "mcp/request/cloudflare-0001",
    digest: DIGEST_A,
    claimId: "mcp/claim/01234567-89ab-4def-8123-000000000001",
    claimedAt: START.toISOString(),
    expiresAt: "2026-08-11T05:00:30.000Z",
    ...overrides,
  };
}

class FakeNamespace {
  constructor(now) {
    this.now = now;
    this.names = [];
    this.calls = [];
    this.stores = new Map();
  }

  getByName(name) {
    this.names.push(name);
    let store = this.stores.get(name);
    if (!store) {
      store = new MemoryMcpRequestStore([], { now: this.now });
      this.stores.set(name, store);
    }
    const call = (method, operation) => async (value) => {
      this.calls.push({ name, method, value });
      return executeMcpRequestStoreRpc(() => operation(value));
    };
    return {
      read: call("read", (value) => store.get(value)),
      claim: call("claim", (value) => store.claim(value)),
      complete: call("complete", (value) => store.complete(value)),
      release: call("release", (value) => store.release(value)),
    };
  }
}

function hasCode(error, code) {
  return error instanceof McpRequestStoreError && error.code === code;
}

test("routes each request to one named Durable Object and polls for completion", async () => {
  let now = new Date(START);
  const namespace = new FakeNamespace(() => new Date(now));
  let completeOnSleep = null;
  const store = new CloudflareMcpRequestStore(namespace, {
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
  const owned = await store.claim(claim());
  assert.equal(owned.disposition, "acquired");

  completeOnSleep = () => store.complete({
    requestId: owned.record.requestId,
    digest: owned.record.digest,
    claimId: owned.record.claimId,
    result: { protocol: "greenways-mcp-result/1", outcome: "ok" },
  });
  const completed = await store.wait({
    requestId: owned.record.requestId,
    digest: owned.record.digest,
    claimId: owned.record.claimId,
    timeoutMs: 100,
  });
  assert.equal(completed.result.outcome, "ok");
  assert.ok(namespace.names.every((name) => name === owned.record.requestId));
  assert.ok(namespace.calls.some(({ method }) => method === "read"));
  assert.equal(namespace.calls.some(({ method }) => method === "wait"), false);
});

test("reconstructs stable request-store errors from RPC envelopes", async () => {
  let now = new Date(START);
  const namespace = new FakeNamespace(() => new Date(now));
  const store = new CloudflareMcpRequestStore(namespace, {
    now: () => new Date(now),
    sleep: async (milliseconds) => {
      now = new Date(now.getTime() + milliseconds);
    },
    pollIntervalMs: 10,
  });
  await store.claim(claim());
  await assert.rejects(
    store.claim(claim({ digest: DIGEST_B })),
    (error) => hasCode(error, "request-id-collision"),
  );
});

test("returns null when ownership changes while a duplicate is polling", async () => {
  let now = new Date(START);
  const namespace = new FakeNamespace(() => new Date(now));
  let replaceOnSleep = null;
  const store = new CloudflareMcpRequestStore(namespace, {
    now: () => new Date(now),
    pollIntervalMs: 10,
    sleep: async (milliseconds) => {
      now = new Date(now.getTime() + milliseconds);
      if (replaceOnSleep) {
        const operation = replaceOnSleep;
        replaceOnSleep = null;
        await operation();
      }
    },
  });
  const owned = await store.claim(claim({ expiresAt: "2026-08-11T05:00:10.000Z" }));
  replaceOnSleep = async () => {
    now = new Date("2026-08-11T05:00:11.000Z");
    await store.claim(claim({
      claimId: "mcp/claim/01234567-89ab-4def-8123-000000000002",
      claimedAt: now.toISOString(),
      expiresAt: "2026-08-11T05:00:41.000Z",
    }));
  };
  assert.equal(await store.wait({
    requestId: owned.record.requestId,
    digest: owned.record.digest,
    claimId: owned.record.claimId,
    timeoutMs: 100,
  }), null);
});

test("rejects malformed Durable Object RPC responses as recovery failures", async () => {
  const store = new CloudflareMcpRequestStore({
    getByName: () => ({
      read: async () => ({ protocol: "unknown/1", ok: true, value: null }),
    }),
  });
  await assert.rejects(
    store.get("mcp/request/cloudflare-0001"),
    (error) => hasCode(error, "request-store-recovery"),
  );
});
