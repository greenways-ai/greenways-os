from pathlib import Path


def replace_once(path, old, new):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one anchor in {path}, found {count}: {old[:160]!r}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "services/mcp-gateway/src/mcp-pairing.js",
    '''    const session = normalizeMcpPairingSession(stored);
    if (session.state !== "open") fail(409, "pairing-session-used", "MCP pairing session is already in use");
    if (Date.parse(session.challenge.expiresAt) <= this.now().getTime()) {
''',
    '''    const session = normalizeMcpPairingSession(stored);
    const observedAt = this.now().getTime();
    if (session.state === "consumed"
        || (session.state === "claimed" && Date.parse(session.claimExpiresAt) > observedAt)) {
      fail(409, "pairing-session-used", "MCP pairing session is already in use");
    }
    if (Date.parse(session.challenge.expiresAt) <= observedAt) {
''',
)

replace_once(
    "services/mcp-gateway/test/mcp-pairing.test.js",
    '''test("fails closed for extra OAuth scopes and expired pairing evidence", async () => {
''',
    '''test("keeps interrupted claim connections inactive and permits a lease-fenced retry", async () => {
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

test("fails closed for extra OAuth scopes and expired pairing evidence", async () => {
''',
)

replace_once(
    "services/mcp-gateway/test/mcp-pairing.test.js",
    '''  MemoryMcpPairingRepository,
  createMcpPairingAssertion,
''',
    '''  MemoryMcpPairingRepository,
  createMcpPairingAssertion,
  mcpConnectionIdForClaim,
''',
)

print("Completed durable MCP pairing recovery")
