import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteMcpRequestRepository } from "../src/sqlite-request-store.js";
import { McpRequestStoreError } from "../src/request-store.js";
import {
  MCP_REQUEST_CLAIM_PROTOCOL,
  MCP_REQUEST_RECORD_PROTOCOL,
} from "../src/protocol.js";

const NOW = new Date("2026-08-11T05:00:00.000Z");
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

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

function claim(overrides = {}) {
  return {
    protocol: MCP_REQUEST_CLAIM_PROTOCOL,
    requestId: "mcp/request/sqlite-0001",
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

test("persists exact request ownership and completed results across repository restarts", () => {
  const sql = new NodeSqlAdapter();
  const repository = new SqliteMcpRequestRepository(sql, { now: () => new Date(NOW) });
  const first = repository.claim(claim());
  assert.equal(first.disposition, "acquired");

  const duplicate = repository.claim(claim({
    claimId: "mcp/claim/01234567-89ab-4def-8123-000000000002",
  }));
  assert.equal(duplicate.disposition, "pending");
  assert.equal(duplicate.record.claimId, first.record.claimId);
  assert.throws(
    () => repository.claim(claim({ digest: DIGEST_B })),
    (error) => hasCode(error, "request-id-collision"),
  );

  const result = {
    protocol: "greenways-mcp-result/1",
    requestId: first.record.requestId,
    outcome: "ok",
    value: { items: ["chats"] },
  };
  const completed = repository.complete({
    requestId: first.record.requestId,
    digest: first.record.digest,
    claimId: first.record.claimId,
    result,
  });
  assert.equal(completed.protocol, MCP_REQUEST_RECORD_PROTOCOL);
  assert.deepEqual(completed.result, result);

  const restarted = new SqliteMcpRequestRepository(sql, { now: () => new Date(NOW) });
  assert.deepEqual(restarted.get(first.record.requestId), completed);
  const replay = restarted.claim(claim({
    claimId: "mcp/claim/01234567-89ab-4def-8123-000000000003",
  }));
  assert.equal(replay.disposition, "completed");
  assert.deepEqual(replay.record, completed);
});

test("uses repository time to replace expired claims and fence late completion", () => {
  let now = new Date(NOW);
  const sql = new NodeSqlAdapter();
  const repository = new SqliteMcpRequestRepository(sql, { now: () => new Date(now) });
  const stale = repository.claim(claim({ expiresAt: "2026-08-11T05:00:10.000Z" }));
  const replacementValue = claim({
    claimId: "mcp/claim/01234567-89ab-4def-8123-000000000002",
    claimedAt: "2026-08-11T05:00:11.000Z",
    expiresAt: "2026-08-11T05:00:41.000Z",
  });
  assert.equal(repository.claim(replacementValue).disposition, "pending");

  now = new Date("2026-08-11T05:00:11.000Z");
  const replacement = repository.claim(replacementValue);
  assert.equal(replacement.disposition, "acquired");
  assert.throws(
    () => repository.complete({
      requestId: stale.record.requestId,
      digest: stale.record.digest,
      claimId: stale.record.claimId,
      result: { outcome: "stale" },
    }),
    (error) => hasCode(error, "request-claim-stale"),
  );
  assert.equal(repository.release({
    requestId: replacement.record.requestId,
    digest: replacement.record.digest,
    claimId: replacement.record.claimId,
  }), true);
  assert.equal(repository.get(replacement.record.requestId), null);
});

test("rejects corrupted SQLite result bytes without exposing them", () => {
  const sql = new NodeSqlAdapter();
  const repository = new SqliteMcpRequestRepository(sql, { now: () => new Date(NOW) });
  const owned = repository.claim(claim());
  repository.complete({
    requestId: owned.record.requestId,
    digest: owned.record.digest,
    claimId: owned.record.claimId,
    result: { safe: true },
  });
  sql.database.exec("UPDATE request_state SET result_json = '{\"credential\":'");
  assert.throws(
    () => repository.get(owned.record.requestId),
    (error) => hasCode(error, "request-store-recovery")
      && !error.message.includes("credential"),
  );
});
