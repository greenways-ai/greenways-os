import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  MCP_PAIRING_CHALLENGE_PROTOCOL,
  MCP_PAIRING_SCOPE,
  MCP_PAIRING_SESSION_PROTOCOL,
  McpPairingError,
  mcpConnectionIdForClaim,
} from "../src/mcp-pairing.js";
import { MCP_CONNECTION_PROTOCOL, MCP_READ_TOOLS } from "../src/protocol.js";
import { SqliteMcpPairingRepository } from "../src/sqlite-pairing-store.js";

const NOW = new Date("2026-08-11T05:00:00.000Z");
const CHALLENGE_UUID = "01234567-89ab-4def-8123-000000000001";
const CLAIM_ONE = "01234567-89ab-4def-8123-000000000002";
const CLAIM_TWO = "01234567-89ab-4def-8123-000000000003";
const CHALLENGE_ID = `mcp/challenge/${CHALLENGE_UUID}`;
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

function session() {
  return {
    protocol: MCP_PAIRING_SESSION_PROTOCOL,
    id: CHALLENGE_ID,
    state: "open",
    challenge: {
      protocol: MCP_PAIRING_CHALLENGE_PROTOCOL,
      id: CHALLENGE_ID,
      client: { id: "chatgpt.greenways", name: "ChatGPT", uri: "https://chatgpt.com/" },
      scopes: [MCP_PAIRING_SCOPE],
      tools: MCP_READ_TOOLS.map(({ name }) => name),
      requestDigest: DIGEST_A,
      nonce: "01234567-89ab-4def-8123-000000000004",
      issuedAt: NOW.toISOString(),
      expiresAt: "2026-08-11T05:05:00.000Z",
      root: DIGEST_B,
    },
    oauthRequest: {
      clientId: "chatgpt.greenways",
      redirectUri: "https://chatgpt.com/aip/callback",
      scope: [MCP_PAIRING_SCOPE],
      state: "oauth-state-example",
      codeChallenge: "pkce-example",
      codeChallengeMethod: "S256",
    },
    createdAt: NOW.toISOString(),
    claimId: null,
    claimedAt: null,
    claimExpiresAt: null,
    consumedAt: null,
    connection: null,
  };
}

function connection(claimId) {
  return {
    protocol: MCP_CONNECTION_PROTOCOL,
    id: mcpConnectionIdForClaim(CHALLENGE_ID, claimId),
    identity: { id: "identity/alice-0001", keyId: DIGEST_A },
    client: { id: "chatgpt.greenways", name: "ChatGPT" },
    tools: MCP_READ_TOOLS.map(({ name }) => name),
    route: { kind: "replica", id: "replica/identity/alice-0001", status: "unknown" },
    issuedAt: NOW.toISOString(),
    expiresAt: "2026-09-10T05:00:00.000Z",
    revokedAt: null,
  };
}

function hasCode(error, code) {
  return error instanceof McpPairingError && error.code === code;
}

test("persists a pairing session and activates its connection only with the consumed transition", () => {
  const sql = new NodeSqlAdapter();
  const repository = new SqliteMcpPairingRepository(sql, { now: () => new Date(NOW) });
  const opened = repository.putSession(session());
  assert.equal(opened.state, "open");

  const owned = repository.claimSession(CHALLENGE_ID, DIGEST_B, CLAIM_ONE, connection(CLAIM_ONE));
  assert.equal(owned.state, "claimed");
  assert.equal(owned.connection.id, mcpConnectionIdForClaim(CHALLENGE_ID, CLAIM_ONE));
  assert.equal(repository.getConnection(owned.connection.id), null);

  const restarted = new SqliteMcpPairingRepository(sql, { now: () => new Date(NOW) });
  assert.equal(restarted.getSession(CHALLENGE_ID).state, "claimed");
  const consumed = restarted.consumeSession(CHALLENGE_ID, CLAIM_ONE, owned.connection.id);
  assert.equal(consumed.state, "consumed");
  assert.deepEqual(restarted.getConnection(owned.connection.id), owned.connection);

  const replayed = new SqliteMcpPairingRepository(sql, { now: () => new Date(NOW) });
  assert.deepEqual(replayed.getConnection(owned.connection.id), owned.connection);
  assert.throws(
    () => replayed.claimSession(CHALLENGE_ID, DIGEST_B, CLAIM_TWO, connection(CLAIM_TWO)),
    (error) => hasCode(error, "pairing-session-used"),
  );
});

test("replaces an expired lease without ever activating the interrupted connection", () => {
  let now = new Date(NOW);
  const sql = new NodeSqlAdapter();
  const repository = new SqliteMcpPairingRepository(sql, {
    now: () => new Date(now),
    claimLifetimeMs: 30_000,
  });
  repository.putSession(session());
  const first = repository.claimSession(CHALLENGE_ID, DIGEST_B, CLAIM_ONE, connection(CLAIM_ONE));
  assert.equal(repository.getConnection(first.connection.id), null);
  assert.throws(
    () => repository.claimSession(CHALLENGE_ID, DIGEST_B, CLAIM_TWO, connection(CLAIM_TWO)),
    (error) => hasCode(error, "pairing-session-used"),
  );

  now = new Date("2026-08-11T05:00:31.000Z");
  const replacement = repository.claimSession(CHALLENGE_ID, DIGEST_B, CLAIM_TWO, connection(CLAIM_TWO));
  assert.equal(replacement.connection.id, mcpConnectionIdForClaim(CHALLENGE_ID, CLAIM_TWO));
  assert.equal(repository.getConnection(first.connection.id), null);
  assert.throws(
    () => repository.consumeSession(CHALLENGE_ID, CLAIM_ONE, first.connection.id),
    (error) => hasCode(error, "pairing-session-changed"),
  );
  assert.equal(repository.consumeSession(
    CHALLENGE_ID,
    CLAIM_TWO,
    replacement.connection.id,
  ).state, "consumed");
  assert.equal(repository.getConnection(first.connection.id), null);
  assert.deepEqual(repository.getConnection(replacement.connection.id), replacement.connection);
});

test("releases an exact provisional claim and rejects corrupted session bytes", () => {
  const sql = new NodeSqlAdapter();
  const repository = new SqliteMcpPairingRepository(sql, { now: () => new Date(NOW) });
  repository.putSession(session());
  const owned = repository.claimSession(CHALLENGE_ID, DIGEST_B, CLAIM_ONE, connection(CLAIM_ONE));
  assert.equal(repository.releaseSession(CHALLENGE_ID, CLAIM_ONE, owned.connection.id), true);
  assert.equal(repository.getSession(CHALLENGE_ID).state, "open");
  assert.equal(repository.releaseSession(CHALLENGE_ID, CLAIM_ONE, owned.connection.id), false);

  sql.database.exec("UPDATE pairing_session SET session_json = '{\"oauthRequest\":'");
  assert.throws(
    () => repository.getSession(CHALLENGE_ID),
    (error) => hasCode(error, "pairing-recovery")
      && !error.message.includes("oauthRequest"),
  );
});
