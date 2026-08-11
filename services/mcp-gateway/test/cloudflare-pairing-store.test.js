import assert from "node:assert/strict";
import test from "node:test";
import { CloudflareMcpPairingRepository } from "../src/cloudflare-pairing-store.js";
import {
  MCP_PAIRING_CHALLENGE_PROTOCOL,
  MCP_PAIRING_SCOPE,
  MCP_PAIRING_SESSION_PROTOCOL,
  McpPairingError,
  MemoryMcpPairingRepository,
  mcpConnectionIdForClaim,
} from "../src/mcp-pairing.js";
import { executeMcpPairingStoreRpc } from "../src/pairing-store-rpc.js";
import { MCP_CONNECTION_PROTOCOL, MCP_READ_TOOLS } from "../src/protocol.js";

const NOW = new Date("2026-08-11T05:00:00.000Z");
const CHALLENGE_UUID = "01234567-89ab-4def-8123-000000000001";
const CLAIM_ID = "01234567-89ab-4def-8123-000000000002";
const CHALLENGE_ID = `mcp/challenge/${CHALLENGE_UUID}`;
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

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

function connection() {
  return {
    protocol: MCP_CONNECTION_PROTOCOL,
    id: mcpConnectionIdForClaim(CHALLENGE_ID, CLAIM_ID),
    identity: { id: "identity/alice-0001", keyId: DIGEST_A },
    client: { id: "chatgpt.greenways", name: "ChatGPT" },
    tools: MCP_READ_TOOLS.map(({ name }) => name),
    route: { kind: "replica", id: "replica/identity/alice-0001", status: "unknown" },
    issuedAt: NOW.toISOString(),
    expiresAt: "2026-09-10T05:00:00.000Z",
    revokedAt: null,
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
      repository = new MemoryMcpPairingRepository({ now: this.now, claimLifetimeMs: 30_000 });
      this.repositories.set(name, repository);
    }
    const call = (method, operation) => async (value) => {
      this.calls.push({ name, method, value });
      return executeMcpPairingStoreRpc(() => operation(value));
    };
    return {
      put: call("put", (value) => repository.putSession(value)),
      read: call("read", (value) => repository.getSession(value)),
      claim: call("claim", (value) => repository.claimSession(
        value.id,
        value.root,
        value.claimId,
        value.connection,
      )),
      release: call("release", (value) => repository.releaseSession(
        value.id,
        value.claimId,
        value.connectionId,
      )),
      consume: call("consume", (value) => repository.consumeSession(
        value.id,
        value.claimId,
        value.connectionId,
      )),
      connection: call("connection", (value) => repository.getConnection(value)),
    };
  }
}

function hasCode(error, code) {
  return error instanceof McpPairingError && error.code === code;
}

test("routes session and connection views through one named pairing atom", async () => {
  let now = new Date(NOW);
  const namespace = new FakeNamespace(() => new Date(now));
  const repository = new CloudflareMcpPairingRepository(namespace);
  await repository.putSession(session());
  const owned = await repository.claimSession(CHALLENGE_ID, DIGEST_B, CLAIM_ID, connection());
  assert.equal(owned.state, "claimed");
  assert.equal(await repository.getConnection(owned.connection.id), null);

  const consumed = await repository.consumeSession(CHALLENGE_ID, CLAIM_ID, owned.connection.id);
  assert.equal(consumed.state, "consumed");
  assert.deepEqual(await repository.getConnection(owned.connection.id), owned.connection);
  assert.deepEqual(await repository.get(owned.connection.id), owned.connection);
  assert.ok(namespace.names.every((name) => name === CHALLENGE_ID));
  assert.ok(namespace.calls.some(({ method }) => method === "connection"));
});

test("reconstructs stable pairing errors from Durable Object RPC envelopes", async () => {
  const namespace = new FakeNamespace(() => new Date(NOW));
  const repository = new CloudflareMcpPairingRepository(namespace);
  await repository.putSession(session());
  await repository.claimSession(CHALLENGE_ID, DIGEST_B, CLAIM_ID, connection());
  await assert.rejects(
    repository.claimSession(
      CHALLENGE_ID,
      DIGEST_B,
      "01234567-89ab-4def-8123-000000000003",
      {
        ...connection(),
        id: mcpConnectionIdForClaim(
          CHALLENGE_ID,
          "01234567-89ab-4def-8123-000000000003",
        ),
      },
    ),
    (error) => hasCode(error, "pairing-session-used"),
  );
});

test("contains raw Durable Object failures behind a retryable storage error", async () => {
  const repository = new CloudflareMcpPairingRepository({
    getByName: () => ({
      read: async () => {
        throw new Error("durable-object-secret-must-not-leak");
      },
    }),
  });
  await assert.rejects(
    repository.getSession(CHALLENGE_ID),
    (error) => hasCode(error, "pairing-store-unavailable")
      && error.status === 503
      && !error.message.includes("durable-object-secret-must-not-leak"),
  );
});

test("rejects malformed pairing RPC responses as recovery failures", async () => {
  const repository = new CloudflareMcpPairingRepository({
    getByName: () => ({
      read: async () => ({ protocol: "unknown/1", ok: true, value: null }),
    }),
  });
  await assert.rejects(
    repository.getSession(CHALLENGE_ID),
    (error) => hasCode(error, "pairing-recovery"),
  );
});
