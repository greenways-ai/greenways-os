import assert from "node:assert/strict";
import test from "node:test";
import {
  GreenwaysMcpPairingService,
  MCP_PAIRING_ASSERTION_PROTOCOL,
  MCP_PAIRING_CHALLENGE_PROTOCOL,
  MCP_PAIRING_RECEIPT_PROTOCOL,
  MCP_PAIRING_SCOPE,
  McpPairingError,
  MemoryMcpPairingRepository,
  createMcpPairingAssertion,
  mcpConnectionIdForClaim,
} from "../src/mcp-pairing.js";
import { canonical, sha256 } from "../src/protocol.js";

const cryptoProvider = globalThis.crypto;
const NOW = new Date("2026-08-11T05:00:00.000Z");

function uuidSequence() {
  let counter = 1;
  return () => `01234567-89ab-4def-8123-${(counter++).toString(16).padStart(12, "0")}`;
}

async function identity() {
  const keys = await cryptoProvider.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicKey = await cryptoProvider.subtle.exportKey("jwk", keys.publicKey);
  const normalizedPublicKey = {
    kty: "EC",
    crv: "P-256",
    x: publicKey.x,
    y: publicKey.y,
    ext: true,
    key_ops: ["verify"],
  };
  return {
    record: {
      id: "identity/alice-0001",
      handle: "alice",
      keyId: await sha256(canonical(normalizedPublicKey), cryptoProvider),
      algorithm: "ECDSA-P256-SHA256",
      publicKey: normalizedPublicKey,
    },
    privateKey: keys.privateKey,
  };
}

function oauthRequest(overrides = {}) {
  return {
    clientId: "chatgpt.greenways",
    redirectUri: "https://chatgpt.com/aip/callback",
    scope: [MCP_PAIRING_SCOPE],
    state: "oauth-state-example",
    codeChallenge: "pkce-example",
    codeChallengeMethod: "S256",
    ...overrides,
  };
}

function clientInfo(overrides = {}) {
  return {
    clientId: "chatgpt.greenways",
    clientName: "ChatGPT",
    clientUri: "https://chatgpt.com/",
    ...overrides,
  };
}

async function assertion(challenge, identityValue, overrides = {}) {
  return createMcpPairingAssertion(challenge, {
    identity: identityValue.record,
    device: {
      id: "greenways-browser-primary",
      name: "Primary browser",
      kind: "browser-extension",
    },
    now: () => new Date(NOW),
    sign: async (bytes) => new Uint8Array(await cryptoProvider.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identityValue.privateKey,
      bytes,
    )),
    ...overrides,
  });
}

function createRig(overrides = {}) {
  const repository = new MemoryMcpPairingRepository({ now: () => new Date(NOW) });
  const service = new GreenwaysMcpPairingService({
    repository,
    now: () => new Date(NOW),
    randomUUID: uuidSequence(),
    cryptoProvider,
    ...overrides,
  });
  return { repository, service };
}

function hasCode(error, code) {
  return error instanceof McpPairingError && error.code === code;
}

test("creates a short-lived challenge bound to the exact OAuth request and read catalogue", async () => {
  const { service } = createRig();
  const request = oauthRequest();
  const challenge = await service.begin({ oauthRequest: request, clientInfo: clientInfo() });

  assert.equal(challenge.protocol, MCP_PAIRING_CHALLENGE_PROTOCOL);
  assert.equal(challenge.client.id, request.clientId);
  assert.equal(challenge.client.name, "ChatGPT");
  assert.deepEqual(challenge.scopes, [MCP_PAIRING_SCOPE]);
  assert.equal(challenge.tools.length, 9);
  assert.equal(challenge.requestDigest, await sha256(canonical(request), cryptoProvider));
  assert.match(challenge.root, /^sha256:[a-f0-9]{64}$/);
  assert.equal(Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt), 5 * 60 * 1000);
});

test("accepts one locally signed identity assertion and exposes only a connection reference to OAuth", async () => {
  const { repository, service } = createRig();
  const actor = await identity();
  const challenge = await service.begin({ oauthRequest: oauthRequest(), clientInfo: clientInfo() });
  const signed = await assertion(challenge, actor);
  let completion;

  const result = await service.authorize({
    challengeId: challenge.id,
    assertion: signed,
    completeAuthorization: async (value) => {
      completion = value;
      assert.equal(await repository.getConnection(value.connection.id), null);
      return {
        redirectTo: "https://chatgpt.com/aip/callback?code=example",
        props: {
          protocol: "greenways-mcp-auth-context/0-alpha",
          connectionId: value.connection.id,
        },
      };
    },
  });

  assert.equal(signed.protocol, MCP_PAIRING_ASSERTION_PROTOCOL);
  assert.equal(result.receipt.protocol, MCP_PAIRING_RECEIPT_PROTOCOL);
  assert.equal(result.connection.identity.id, actor.record.id);
  assert.equal(result.connection.identity.keyId, actor.record.keyId);
  assert.equal(result.connection.client.id, "chatgpt.greenways");
  assert.deepEqual(result.connection.tools, challenge.tools);
  assert.deepEqual(result.connection.route, {
    kind: "replica",
    id: `replica/${actor.record.id}`,
    status: "unknown",
  });
  assert.equal(completion.identity.publicKey.d, undefined);
  assert.equal(completion.connection.id, result.connection.id);
  assert.deepEqual(result.oauthResult.props, {
    protocol: "greenways-mcp-auth-context/0-alpha",
    connectionId: result.connection.id,
  });
  assert.deepEqual(await repository.getConnection(result.connection.id), result.connection);
});

test("rejects changed challenges, invalid signatures, and replayed approvals", async () => {
  const { service } = createRig();
  const actor = await identity();
  const challenge = await service.begin({ oauthRequest: oauthRequest(), clientInfo: clientInfo() });
  const signed = await assertion(challenge, actor);

  await assert.rejects(
    service.authorize({
      challengeId: challenge.id,
      assertion: { ...signed, challengeRoot: `sha256:${"b".repeat(64)}` },
      completeAuthorization: async () => ({}),
    }),
    (error) => hasCode(error, "pairing-challenge-mismatch"),
  );

  // Change a high-order base64url sextet. Mutating the final character can
  // affect only unused padding bits for some 64-byte ECDSA signatures and may
  // therefore decode to the original bytes.
  const changedSignature = `${signed.signature.startsWith("A") ? "B" : "A"}${signed.signature.slice(1)}`;
  await assert.rejects(
    service.authorize({
      challengeId: challenge.id,
      assertion: { ...signed, signature: changedSignature },
      completeAuthorization: async () => ({}),
    }),
    (error) => hasCode(error, "pairing-signature-invalid"),
  );

  await service.authorize({
    challengeId: challenge.id,
    assertion: signed,
    completeAuthorization: async () => ({ redirectTo: "https://chatgpt.com/" }),
  });
  await assert.rejects(
    service.authorize({
      challengeId: challenge.id,
      assertion: signed,
      completeAuthorization: async () => ({ redirectTo: "https://chatgpt.com/" }),
    }),
    (error) => hasCode(error, "pairing-session-used"),
  );
});

test("releases the one-time claim and removes its connection when OAuth completion fails", async () => {
  const { repository, service } = createRig();
  const actor = await identity();
  const challenge = await service.begin({ oauthRequest: oauthRequest(), clientInfo: clientInfo() });
  const signed = await assertion(challenge, actor);

  await assert.rejects(
    service.authorize({
      challengeId: challenge.id,
      assertion: signed,
      completeAuthorization: async () => {
        throw new Error("oauth-provider-secret");
      },
    }),
    (error) => hasCode(error, "oauth-authorization-failed")
      && !error.message.includes("oauth-provider-secret"),
  );

  const session = await repository.getSession(challenge.id);
  assert.equal(session.state, "open");
  assert.equal(session.claimId, null);
  assert.equal(session.connection, null);

  const retried = await service.authorize({
    challengeId: challenge.id,
    assertion: signed,
    completeAuthorization: async () => ({ redirectTo: "https://chatgpt.com/" }),
  });
  assert.equal(retried.connection.identity.id, actor.record.id);
});

test("keeps interrupted claim connections inactive and permits a lease-fenced retry", async () => {
  let repositoryNow = new Date(NOW);
  const repository = new MemoryMcpPairingRepository({
    now: () => new Date(repositoryNow),
    claimLifetimeMs: 30_000,
  });
  const service = new GreenwaysMcpPairingService({
    repository,
    now: () => new Date(repositoryNow),
    randomUUID: uuidSequence(),
    cryptoProvider,
  });
  const actor = await identity();
  const challenge = await service.begin({ oauthRequest: oauthRequest(), clientInfo: clientInfo() });
  const signed = await assertion(challenge, actor);
  const stored = await repository.getSession(challenge.id);
  const interruptedClaim = "01234567-89ab-4def-8123-000000000099";
  const interruptedConnection = {
    protocol: "greenways-mcp-connection/1",
    id: mcpConnectionIdForClaim(challenge.id, interruptedClaim),
    identity: { id: actor.record.id, keyId: actor.record.keyId },
    client: { id: challenge.client.id, name: challenge.client.name },
    tools: challenge.tools,
    route: { kind: "replica", id: `replica/${actor.record.id}`, status: "unknown" },
    issuedAt: NOW.toISOString(),
    expiresAt: "2026-09-10T05:00:00.000Z",
    revokedAt: null,
  };
  await repository.claimSession(
    challenge.id,
    stored.challenge.root,
    interruptedClaim,
    interruptedConnection,
  );
  assert.equal(await repository.getConnection(interruptedConnection.id), null);
  await assert.rejects(
    service.authorize({
      challengeId: challenge.id,
      assertion: signed,
      completeAuthorization: async () => ({}),
    }),
    (error) => hasCode(error, "pairing-session-used"),
  );

  repositoryNow = new Date("2026-08-11T05:00:31.000Z");
  const retried = await service.authorize({
    challengeId: challenge.id,
    assertion: signed,
    completeAuthorization: async ({ connection }) => {
      assert.equal(await repository.getConnection(connection.id), null);
      return { redirectTo: "https://chatgpt.com/" };
    },
  });
  assert.equal(await repository.getConnection(interruptedConnection.id), null);
  assert.deepEqual(await repository.getConnection(retried.connection.id), retried.connection);
});

test("fails closed when the pairing service clock is invalid", async () => {
  const repository = new MemoryMcpPairingRepository({ now: () => new Date(NOW) });
  const beginFailure = new GreenwaysMcpPairingService({
    repository,
    now: () => new Date(Number.NaN),
    randomUUID: uuidSequence(),
    cryptoProvider,
  });
  await assert.rejects(
    beginFailure.begin({ oauthRequest: oauthRequest(), clientInfo: clientInfo() }),
    (error) => hasCode(error, "pairing-recovery"),
  );

  const healthy = new GreenwaysMcpPairingService({
    repository,
    now: () => new Date(NOW),
    randomUUID: uuidSequence(),
    cryptoProvider,
  });
  const actor = await identity();
  const challenge = await healthy.begin({ oauthRequest: oauthRequest(), clientInfo: clientInfo() });
  const signed = await assertion(challenge, actor);
  const authorizeFailure = new GreenwaysMcpPairingService({
    repository,
    now: () => new Date(Number.NaN),
    randomUUID: uuidSequence(),
    cryptoProvider,
  });
  await assert.rejects(
    authorizeFailure.authorize({
      challengeId: challenge.id,
      assertion: signed,
      completeAuthorization: async () => ({}),
    }),
    (error) => hasCode(error, "pairing-recovery"),
  );
  assert.equal((await repository.getSession(challenge.id)).state, "open");
});

test("fails closed for extra OAuth scopes and expired pairing evidence", async () => {
  const { service } = createRig();
  await assert.rejects(
    service.begin({
      oauthRequest: oauthRequest({ scope: [MCP_PAIRING_SCOPE, "greenways.write"] }),
      clientInfo: clientInfo(),
    }),
    (error) => hasCode(error, "unsupported-scope"),
  );

  const actor = await identity();
  const challenge = await service.begin({ oauthRequest: oauthRequest(), clientInfo: clientInfo() });
  const expired = await assertion(challenge, actor, {
    now: () => new Date("2026-08-11T04:50:00.000Z"),
    assertionLifetimeMs: 60_000,
  });
  await assert.rejects(
    service.authorize({
      challengeId: challenge.id,
      assertion: expired,
      completeAuthorization: async () => ({}),
    }),
    (error) => hasCode(error, "pairing-assertion-expired"),
  );
});

test("refuses to sign altered challenge content before the controller key is used", async () => {
  const { service } = createRig();
  const actor = await identity();
  const challenge = await service.begin({ oauthRequest: oauthRequest(), clientInfo: clientInfo() });
  let signingCalls = 0;
  await assert.rejects(
    createMcpPairingAssertion({
      ...challenge,
      client: { ...challenge.client, name: "Changed client" },
    }, {
      identity: actor.record,
      device: {
        id: "greenways-browser-primary",
        name: "Primary browser",
        kind: "browser-extension",
      },
      now: () => new Date(NOW),
      cryptoProvider,
      sign: async () => {
        signingCalls += 1;
        return new Uint8Array(64);
      },
    }),
    (error) => hasCode(error, "pairing-challenge-root-invalid"),
  );
  assert.equal(signingCalls, 0);
});
