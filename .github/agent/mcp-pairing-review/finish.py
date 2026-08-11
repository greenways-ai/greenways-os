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
    '''  return Object.freeze({
    protocol: MCP_PAIRING_CHALLENGE_PROTOCOL,
    id: id(input.id, "MCP pairing challenge id", CHALLENGE_ID, 500),
    client: Object.freeze({
''',
    '''  let scopes;
  try {
    scopes = normalizeScopes(input.scopes);
  } catch (cause) {
    fail(500, "pairing-recovery", "Stored MCP pairing challenge scopes are invalid", { cause });
  }
  return Object.freeze({
    protocol: MCP_PAIRING_CHALLENGE_PROTOCOL,
    id: id(input.id, "MCP pairing challenge id", CHALLENGE_ID, 500),
    client: Object.freeze({
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-pairing.js",
    '''    scopes: normalizeScopes(input.scopes),
''',
    '''    scopes,
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-pairing.js",
    '''    const issued = this.now();
    const body = {
''',
    '''    const issued = pairingRepositoryDate(this.now());
    const body = {
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-pairing.js",
    '''    const session = normalizeMcpPairingSession(stored);
    const observedAt = this.now().getTime();
    if (session.state === "consumed"
''',
    '''    const session = normalizeMcpPairingSession(stored);
    const observed = pairingRepositoryDate(this.now());
    const observedAt = observed.getTime();
    if (session.state === "consumed"
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-pairing.js",
    '''    const verified = await verifyAssertion(assertion, session.challenge, {
      now: this.now,
      cryptoProvider: this.cryptoProvider,
    });
    const claimId = secureUuid(this.randomUUID, "MCP pairing claim");
    const issued = this.now();
''',
    '''    const verified = await verifyAssertion(assertion, session.challenge, {
      now: () => new Date(observed),
      cryptoProvider: this.cryptoProvider,
    });
    const claimId = secureUuid(this.randomUUID, "MCP pairing claim");
    const issued = pairingRepositoryDate(this.now());
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-pairing.js",
    '''      const oauthResult = await completeAuthorization({
        oauthRequest: session.oauthRequest,
        identity: verified.identity,
        device: verified.device,
        connection,
      });
      await this.repository.consumeSession(session.id, claimId, connection.id);
      const receipt = Object.freeze({
''',
    '''      const oauthResult = await completeAuthorization({
        oauthRequest: session.oauthRequest,
        identity: verified.identity,
        device: verified.device,
        connection,
      });
      const receipt = Object.freeze({
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-pairing.js",
    '''        pairedAt: this.now().toISOString(),
      });
      validateBoundedPublicValue(receipt, "MCP pairing receipt");
      return Object.freeze({ connection, receipt, oauthResult });
''',
    '''        pairedAt: pairingRepositoryDate(this.now()).toISOString(),
      });
      validateBoundedPublicValue(receipt, "MCP pairing receipt");
      await this.repository.consumeSession(session.id, claimId, connection.id);
      return Object.freeze({ connection, receipt, oauthResult });
''',
)

replace_once(
    "services/mcp-gateway/src/cloudflare-pairing-store.js",
    '''    return unwrapMcpPairingStoreRpc(await stub[method](value));
''',
    '''    let response;
    try {
      response = await stub[method](value);
    } catch (cause) {
      if (cause instanceof McpPairingError) throw cause;
      throw new McpPairingError(
        503,
        "pairing-store-unavailable",
        "MCP pairing storage is unavailable",
        { cause },
      );
    }
    return unwrapMcpPairingStoreRpc(response);
''',
)

replace_once(
    "services/mcp-gateway/test/cloudflare-pairing-store.test.js",
    '''test("rejects malformed pairing RPC responses as recovery failures", async () => {
''',
    '''test("contains raw Durable Object failures behind a retryable storage error", async () => {
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
''',
)

replace_once(
    "services/mcp-gateway/test/mcp-pairing.test.js",
    '''test("fails closed for extra OAuth scopes and expired pairing evidence", async () => {
''',
    '''test("fails closed when the pairing service clock is invalid", async () => {
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
''',
)

print("Applied MCP pairing security refinements")
