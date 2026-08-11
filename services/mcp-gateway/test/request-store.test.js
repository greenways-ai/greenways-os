import assert from "node:assert/strict";
import test from "node:test";
import {
  McpRequestStoreError,
  MemoryMcpRequestStore,
} from "../src/request-store.js";
import {
  MCP_REQUEST_CLAIM_PROTOCOL,
  MCP_REQUEST_RECORD_PROTOCOL,
} from "../src/protocol.js";

const NOW = new Date("2026-08-11T05:00:00.000Z");
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function claim(overrides = {}) {
  return {
    protocol: MCP_REQUEST_CLAIM_PROTOCOL,
    requestId: "mcp/request/store-0001",
    digest: DIGEST_A,
    claimId: "mcp/claim/01234567-89ab-4def-8123-000000000001",
    claimedAt: "2026-08-11T05:00:00.000Z",
    expiresAt: "2026-08-11T05:00:30.000Z",
    ...overrides,
  };
}

function hasCode(error, code) {
  return error instanceof McpRequestStoreError && error.code === code;
}

test("admits one claim owner, fences collisions, and wakes duplicate waiters with the completed record", async () => {
  const store = new MemoryMcpRequestStore([], { now: () => new Date(NOW) });
  const first = await store.claim(claim());
  assert.equal(first.disposition, "acquired");

  const secondClaimId = "mcp/claim/01234567-89ab-4def-8123-000000000002";
  const pending = await store.claim(claim({ claimId: secondClaimId }));
  assert.equal(pending.disposition, "pending");
  assert.equal(pending.record.claimId, first.record.claimId);

  await assert.rejects(
    store.claim(claim({ digest: DIGEST_B, claimId: secondClaimId })),
    (error) => hasCode(error, "request-id-collision"),
  );

  const waiting = store.wait({
    requestId: first.record.requestId,
    digest: first.record.digest,
    claimId: first.record.claimId,
    timeoutMs: 1_000,
  });
  const completed = await store.complete({
    requestId: first.record.requestId,
    digest: first.record.digest,
    claimId: first.record.claimId,
    result: { protocol: "greenways-mcp-result/1", outcome: "ok" },
  });
  assert.equal(completed.protocol, MCP_REQUEST_RECORD_PROTOCOL);
  assert.deepEqual(await waiting, completed);

  const replay = await store.claim(claim({ claimId: secondClaimId }));
  assert.equal(replay.disposition, "completed");
  assert.deepEqual(replay.record, completed);
});

test("uses repository time to replace an expired claim and fences the former owner", async () => {
  let now = new Date(NOW);
  const store = new MemoryMcpRequestStore([], { now: () => new Date(now) });
  const stale = await store.claim(claim({ expiresAt: "2026-08-11T05:00:10.000Z" }));
  const replacementValue = claim({
    claimId: "mcp/claim/01234567-89ab-4def-8123-000000000002",
    claimedAt: "2026-08-11T05:00:11.000Z",
    expiresAt: "2026-08-11T05:00:41.000Z",
  });

  const premature = await store.claim(replacementValue);
  assert.equal(premature.disposition, "pending");
  assert.equal(premature.record.claimId, stale.record.claimId);

  now = new Date("2026-08-11T05:00:11.000Z");
  const replacement = await store.claim(replacementValue);
  assert.equal(replacement.disposition, "acquired");

  await assert.rejects(
    store.complete({
      requestId: stale.record.requestId,
      digest: stale.record.digest,
      claimId: stale.record.claimId,
      result: { outcome: "stale" },
    }),
    (error) => hasCode(error, "request-claim-stale"),
  );

  assert.equal(await store.release({
    requestId: replacement.record.requestId,
    digest: replacement.record.digest,
    claimId: replacement.record.claimId,
  }), true);
  assert.equal(await store.get(replacement.record.requestId), null);
});
