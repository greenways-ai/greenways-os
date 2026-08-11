from pathlib import Path


def replace_once(path, old, new):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one anchor in {path}, found {count}: {old[:160]!r}")
    target.write_text(text.replace(old, new, 1))


def replace_range(path, start_marker, end_marker, replacement):
    target = Path(path)
    text = target.read_text()
    start = text.find(start_marker)
    if start < 0:
        raise SystemExit(f"Missing start marker in {path}: {start_marker!r}")
    end = text.find(end_marker, start)
    if end < 0:
        raise SystemExit(f"Missing end marker in {path}: {end_marker!r}")
    target.write_text(text[:start] + replacement + text[end:])


pairing_path = Path("services/mcp-gateway/src/mcp-pairing.js")
pairing = pairing_path.read_text()
pairing = pairing.replace(
    'export const MCP_PAIRING_SESSION_PROTOCOL = "greenways-mcp-pairing-session/1";',
    'export const MCP_PAIRING_SESSION_PROTOCOL = "greenways-mcp-pairing-session/2";',
)
pairing = pairing.replace(
    'export const MCP_PAIRING_SCOPE = "greenways.read";\n',
    'export const MCP_PAIRING_SCOPE = "greenways.read";\n'
    'export const MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS = 2 * 60 * 1000;\n',
)
pairing = pairing.replace(
    '''const CHALLENGE_ID = /^mcp\\/challenge\\/[A-Za-z0-9._:-]{8,160}$/;
const CONNECTION_ID = /^mcp\\/connection\\/[A-Za-z0-9._:-]{8,160}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,180}$/;
''',
    '''const CHALLENGE_ID = /^mcp\\/challenge\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAIRING_CONNECTION_ID = /^mcp\\/connection\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CLAIM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,180}$/;
''',
)
pairing = pairing.replace(
    'const MAX_ASSERTION_LIFETIME_MS = 5 * 60 * 1000;\n',
    'const MAX_ASSERTION_LIFETIME_MS = 5 * 60 * 1000;\n'
    'const MAX_PAIRING_CLAIM_LIFETIME_MS = 5 * 60 * 1000;\n',
)
pairing = pairing.replace('normalizeChallenge(', 'normalizeMcpPairingChallenge(')
pairing = pairing.replace('function normalizeMcpPairingChallenge(', 'export function normalizeMcpPairingChallenge(')
pairing = pairing.replace('normalizeSession(', 'normalizeMcpPairingSession(')
pairing = pairing.replace('function normalizeMcpPairingSession(', 'export function normalizeMcpPairingSession(')
pairing_path.write_text(pairing)

replace_once(
    pairing_path,
    '''function boundedLifetime(value, fallback, maximum, label) {
''',
    '''export function normalizeMcpPairingChallengeId(value, status = 400) {
  return id(value, "MCP pairing challenge id", CHALLENGE_ID, status);
}

export function normalizeMcpPairingClaimId(value, status = 400) {
  const output = string(value, "MCP pairing claim id", 80, status);
  if (!CLAIM_ID.test(output)) fail(status, "invalid-pairing", "MCP pairing claim id is invalid");
  return output.toLowerCase();
}

export function normalizeMcpPairingConnectionId(value, status = 400) {
  const output = string(value, "MCP pairing connection id", 180, status);
  if (!PAIRING_CONNECTION_ID.test(output)) {
    fail(status, "invalid-pairing", "MCP pairing connection id is invalid");
  }
  return output.toLowerCase();
}

export function mcpConnectionIdForClaim(challengeIdValue, claimIdValue) {
  const challengeId = normalizeMcpPairingChallengeId(challengeIdValue, 500);
  const claimId = normalizeMcpPairingClaimId(claimIdValue, 500);
  return `mcp/connection/${challengeId.slice("mcp/challenge/".length).toLowerCase()}:${claimId}`;
}

export function mcpChallengeIdForConnection(connectionIdValue) {
  const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
  const match = PAIRING_CONNECTION_ID.exec(connectionId);
  return `mcp/challenge/${match[1].toLowerCase()}`;
}

function boundedLifetime(value, fallback, maximum, label) {
''',
)

normalize_session = '''export function normalizeMcpPairingSession(value) {
  const input = closedKeys(
    value,
    new Set([
      "protocol", "id", "state", "challenge", "oauthRequest", "createdAt",
      "claimId", "claimedAt", "claimExpiresAt", "consumedAt", "connection",
    ]),
    "MCP pairing session",
    500,
  );
  if (input.protocol !== MCP_PAIRING_SESSION_PROTOCOL || !CHALLENGE_STATES.has(input.state)) {
    fail(500, "pairing-recovery", "Stored MCP pairing session is invalid");
  }
  const challenge = normalizeMcpPairingChallenge(input.challenge);
  if (input.id !== challenge.id) fail(500, "pairing-recovery", "Stored MCP pairing session identity is invalid");
  let oauthRequest;
  try {
    oauthRequest = jsonClone(input.oauthRequest, "Stored OAuth request");
  } catch (cause) {
    fail(500, "pairing-recovery", "Stored OAuth request is invalid", { cause });
  }
  let connection = null;
  if (input.connection !== null) {
    try {
      connection = normalizeConnection(input.connection);
    } catch (cause) {
      fail(500, "pairing-recovery", "Stored MCP pairing connection is invalid", { cause });
    }
  }
  const output = Object.freeze({
    protocol: MCP_PAIRING_SESSION_PROTOCOL,
    id: challenge.id,
    state: input.state,
    challenge,
    oauthRequest,
    createdAt: canonicalDate(input.createdAt, "MCP pairing session createdAt", 500),
    claimId: input.claimId === null ? null : normalizeMcpPairingClaimId(input.claimId, 500),
    claimedAt: input.claimedAt === null ? null : canonicalDate(input.claimedAt, "MCP pairing claimedAt", 500),
    claimExpiresAt: input.claimExpiresAt === null
      ? null
      : canonicalDate(input.claimExpiresAt, "MCP pairing claimExpiresAt", 500),
    consumedAt: input.consumedAt === null ? null : canonicalDate(input.consumedAt, "MCP pairing consumedAt", 500),
    connection,
  });
  if ((output.state === "open"
        && (output.claimId || output.claimedAt || output.claimExpiresAt || output.consumedAt || output.connection))
      || (output.state === "claimed"
        && (!output.claimId || !output.claimedAt || !output.claimExpiresAt || output.consumedAt || !output.connection))
      || (output.state === "consumed"
        && (!output.claimId || !output.claimedAt || !output.claimExpiresAt || !output.consumedAt || !output.connection))) {
    fail(500, "pairing-recovery", "Stored MCP pairing session state is inconsistent");
  }
  if (output.claimedAt) {
    if (Date.parse(output.claimExpiresAt) <= Date.parse(output.claimedAt)
        || Date.parse(output.claimExpiresAt) > Date.parse(challenge.expiresAt)) {
      fail(500, "pairing-recovery", "Stored MCP pairing claim lifetime is inconsistent");
    }
    const expectedConnectionId = mcpConnectionIdForClaim(challenge.id, output.claimId);
    if (output.connection.id !== expectedConnectionId
        || output.connection.client.id !== challenge.client.id
        || output.connection.client.name !== challenge.client.name
        || output.connection.tools.length !== challenge.tools.length
        || output.connection.tools.some((name, index) => name !== challenge.tools[index])) {
      fail(500, "pairing-recovery", "Stored MCP pairing connection is not bound to its claim");
    }
  }
  if (output.consumedAt && Date.parse(output.consumedAt) < Date.parse(output.claimedAt)) {
    fail(500, "pairing-recovery", "Stored MCP pairing consumption precedes its claim");
  }
  return output;
}

'''
replace_range(
    pairing_path,
    'export function normalizeMcpPairingSession(value) {',
    'function assertionBody(value) {',
    normalize_session,
)

repository_section = '''function pairingRepositoryDate(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(500, "pairing-recovery", "MCP pairing repository clock is invalid");
  }
  return value;
}

function clonePairingValue(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    fail(500, "pairing-recovery", `${label} must be structured-cloneable`, { cause });
  }
}

function pairingTransition(session, changed, extra = {}) {
  return Object.freeze({
    session: clonePairingValue(session, "MCP pairing transition"),
    changed,
    ...extra,
  });
}

function currentPairingSession(value) {
  return value === null || value === undefined ? null : normalizeMcpPairingSession(value);
}

export function putMcpPairingSessionState(currentValue, sessionValue) {
  if (currentPairingSession(currentValue)) {
    fail(409, "pairing-session-exists", "MCP pairing session already exists");
  }
  return pairingTransition(normalizeMcpPairingSession(sessionValue), true);
}

export function claimMcpPairingSessionState(
  currentValue,
  claimValue,
  nowValue,
  claimLifetimeMs = MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS,
) {
  const current = currentPairingSession(currentValue);
  if (!current) fail(404, "pairing-session-missing", "MCP pairing session does not exist");
  const input = closedKeys(
    claimValue,
    new Set(["id", "root", "claimId", "connection"]),
    "MCP pairing repository claim",
    500,
  );
  const idValue = normalizeMcpPairingChallengeId(input.id, 500);
  const claimId = normalizeMcpPairingClaimId(input.claimId, 500);
  if (current.id !== idValue) fail(500, "pairing-recovery", "MCP pairing repository identity changed");
  if (current.challenge.root !== input.root) fail(409, "pairing-session-changed", "MCP pairing session changed");
  const observed = pairingRepositoryDate(nowValue);
  if (Date.parse(current.challenge.expiresAt) <= observed.getTime()) {
    fail(403, "pairing-challenge-expired", "MCP pairing challenge expired");
  }
  if (current.state === "consumed") {
    fail(409, "pairing-session-used", "MCP pairing session is already in use");
  }
  if (current.state === "claimed" && Date.parse(current.claimExpiresAt) > observed.getTime()) {
    fail(409, "pairing-session-used", "MCP pairing session is already in use");
  }
  const lifetime = boundedLifetime(
    claimLifetimeMs,
    MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS,
    MAX_PAIRING_CLAIM_LIFETIME_MS,
    "MCP pairing claim lifetime",
  );
  let connection;
  try {
    connection = normalizeConnection(input.connection);
  } catch (cause) {
    fail(500, "pairing-recovery", "MCP pairing claim connection is invalid", { cause });
  }
  if (connection.id !== mcpConnectionIdForClaim(current.id, claimId)) {
    fail(500, "pairing-recovery", "MCP pairing claim connection ID is invalid");
  }
  const next = normalizeMcpPairingSession({
    ...current,
    state: "claimed",
    claimId,
    claimedAt: observed.toISOString(),
    claimExpiresAt: new Date(Math.min(
      observed.getTime() + lifetime,
      Date.parse(current.challenge.expiresAt),
    )).toISOString(),
    consumedAt: null,
    connection,
  });
  return pairingTransition(next, true);
}

export function releaseMcpPairingSessionState(currentValue, releaseValue) {
  const current = currentPairingSession(currentValue);
  if (!current) return pairingTransition(null, False, { released: false });
  const input = closedKeys(
    releaseValue,
    new Set(["id", "claimId", "connectionId"]),
    "MCP pairing repository release",
    500,
  );
  const idValue = normalizeMcpPairingChallengeId(input.id, 500);
  const claimId = normalizeMcpPairingClaimId(input.claimId, 500);
  const connectionId = normalizeMcpPairingConnectionId(input.connectionId, 500);
  if (current.id !== idValue) fail(500, "pairing-recovery", "MCP pairing repository identity changed");
  if (current.state !== "claimed"
      || current.claimId !== claimId
      || current.connection?.id !== connectionId) {
    return pairingTransition(current, false, { released: false });
  }
  const next = normalizeMcpPairingSession({
    ...current,
    state: "open",
    claimId: null,
    claimedAt: null,
    claimExpiresAt: null,
    consumedAt: null,
    connection: null,
  });
  return pairingTransition(next, true, { released: true });
}

export function consumeMcpPairingSessionState(currentValue, consumeValue, nowValue) {
  const current = currentPairingSession(currentValue);
  if (!current) fail(409, "pairing-session-changed", "MCP pairing session claim is no longer current");
  const input = closedKeys(
    consumeValue,
    new Set(["id", "claimId", "connectionId"]),
    "MCP pairing repository consumption",
    500,
  );
  const idValue = normalizeMcpPairingChallengeId(input.id, 500);
  const claimId = normalizeMcpPairingClaimId(input.claimId, 500);
  const connectionId = normalizeMcpPairingConnectionId(input.connectionId, 500);
  const observed = pairingRepositoryDate(nowValue);
  if (current.id !== idValue) fail(500, "pairing-recovery", "MCP pairing repository identity changed");
  if (current.state !== "claimed"
      || current.claimId !== claimId
      || current.connection?.id !== connectionId
      || Date.parse(current.claimExpiresAt) <= observed.getTime()) {
    fail(409, "pairing-session-changed", "MCP pairing session claim is no longer current");
  }
  const next = normalizeMcpPairingSession({
    ...current,
    state: "consumed",
    consumedAt: observed.toISOString(),
  });
  return pairingTransition(next, true);
}

export class MemoryMcpPairingRepository {
  constructor({
    now = () => new Date(),
    claimLifetimeMs = MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS,
  } = {}) {
    if (typeof now !== "function") throw new TypeError("MCP pairing repository requires a clock");
    this.sessions = new Map();
    this.now = now;
    this.claimLifetimeMs = claimLifetimeMs;
  }

  currentDate() {
    return pairingRepositoryDate(this.now());
  }

  async putSession(sessionValue) {
    const session = normalizeMcpPairingSession(sessionValue);
    const transition = putMcpPairingSessionState(this.sessions.get(session.id) ?? null, session);
    this.sessions.set(session.id, clonePairingValue(transition.session, "MCP pairing session"));
    return clonePairingValue(transition.session, "MCP pairing session");
  }

  async getSession(idValue) {
    const idValueNormalized = normalizeMcpPairingChallengeId(idValue, 500);
    const value = this.sessions.get(idValueNormalized);
    return value ? clonePairingValue(normalizeMcpPairingSession(value), "MCP pairing session") : null;
  }

  async claimSession(idValue, root, claimIdValue, connectionValue) {
    const idValueNormalized = normalizeMcpPairingChallengeId(idValue, 500);
    const transition = claimMcpPairingSessionState(
      this.sessions.get(idValueNormalized) ?? null,
      { id: idValueNormalized, root, claimId: claimIdValue, connection: connectionValue },
      this.currentDate(),
      this.claimLifetimeMs,
    );
    this.sessions.set(idValueNormalized, clonePairingValue(transition.session, "MCP pairing session"));
    return clonePairingValue(transition.session, "MCP pairing session");
  }

  async releaseSession(idValue, claimIdValue, connectionIdValue) {
    const idValueNormalized = normalizeMcpPairingChallengeId(idValue, 500);
    const transition = releaseMcpPairingSessionState(
      this.sessions.get(idValueNormalized) ?? null,
      { id: idValueNormalized, claimId: claimIdValue, connectionId: connectionIdValue },
    );
    if (transition.changed) {
      this.sessions.set(idValueNormalized, clonePairingValue(transition.session, "MCP pairing session"));
    }
    return transition.released;
  }

  async consumeSession(idValue, claimIdValue, connectionIdValue) {
    const idValueNormalized = normalizeMcpPairingChallengeId(idValue, 500);
    const transition = consumeMcpPairingSessionState(
      this.sessions.get(idValueNormalized) ?? null,
      { id: idValueNormalized, claimId: claimIdValue, connectionId: connectionIdValue },
      this.currentDate(),
    );
    this.sessions.set(idValueNormalized, clonePairingValue(transition.session, "MCP pairing session"));
    return clonePairingValue(transition.session, "MCP pairing session");
  }

  async getConnection(connectionIdValue) {
    const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
    const challengeId = mcpChallengeIdForConnection(connectionId);
    const session = this.sessions.get(challengeId);
    if (!session) return null;
    const normalized = normalizeMcpPairingSession(session);
    if (normalized.state !== "consumed" || normalized.connection?.id !== connectionId) return null;
    return clonePairingValue(normalized.connection, "MCP connection");
  }

  async get(connectionIdValue) {
    return this.getConnection(connectionIdValue);
  }
}

'''.replace('False', 'false')
replace_range(
    pairing_path,
    'export class MemoryMcpPairingRepository {',
    'export class GreenwaysMcpPairingService {',
    repository_section,
)

replace_once(
    pairing_path,
    '''        || typeof repository.consumeSession !== "function"
        || typeof repository.putConnection !== "function"
        || typeof repository.deleteConnection !== "function") {
''',
    '''        || typeof repository.consumeSession !== "function"
        || typeof repository.getConnection !== "function") {
''',
)

replace_once(
    pairing_path,
    '''      claimId: null,
      claimedAt: null,
      consumedAt: null,
      connectionId: null,
''',
    '''      claimId: null,
      claimedAt: null,
      claimExpiresAt: null,
      consumedAt: null,
      connection: null,
''',
)

authorize_replacement = '''    const claimId = secureUuid(this.randomUUID, "MCP pairing claim");
    const issued = this.now();
    const connection = normalizeConnection({
      protocol: "greenways-mcp-connection/1",
      id: mcpConnectionIdForClaim(session.id, claimId),
      identity: {
        id: verified.identity.id,
        keyId: verified.identity.keyId,
      },
      client: {
        id: session.challenge.client.id,
        name: session.challenge.client.name,
      },
      tools: session.challenge.tools,
      route: await this.routeResolver({
        identity: verified.identity,
        device: verified.device,
        challenge: session.challenge,
      }),
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + this.connectionLifetimeMs).toISOString(),
      revokedAt: null,
    });
    await this.repository.claimSession(
      session.id,
      session.challenge.root,
      claimId,
      connection,
    );

    try {
      const oauthResult = await completeAuthorization({
        oauthRequest: session.oauthRequest,
        identity: verified.identity,
        device: verified.device,
        connection,
      });
      await this.repository.consumeSession(session.id, claimId, connection.id);
      const receipt = Object.freeze({
        protocol: MCP_PAIRING_RECEIPT_PROTOCOL,
        challengeId: session.id,
        connectionId: connection.id,
        identity: Object.freeze({
          id: verified.identity.id,
          handle: verified.identity.handle,
          keyId: verified.identity.keyId,
        }),
        client: connection.client,
        tools: connection.tools,
        pairedAt: this.now().toISOString(),
      });
      validateBoundedPublicValue(receipt, "MCP pairing receipt");
      return Object.freeze({ connection, receipt, oauthResult });
    } catch (cause) {
      await this.repository.releaseSession(session.id, claimId, connection.id).catch(() => {});
      if (cause instanceof McpPairingError) throw cause;
      fail(502, "oauth-authorization-failed", "MCP OAuth authorization could not be completed", { cause });
    }
'''
replace_range(
    pairing_path,
    '    const claimId = secureUuid(this.randomUUID, "MCP pairing claim");',
    '  }\n}',
    authorize_replacement,
)

# The previous range replacement retains the class/method closing marker.

replace_once(
    "services/mcp-gateway/test/mcp-pairing.test.js",
    '''  const repository = new MemoryMcpPairingRepository();
''',
    '''  const repository = new MemoryMcpPairingRepository({ now: () => new Date(NOW) });
''',
)
replace_once(
    "services/mcp-gateway/test/mcp-pairing.test.js",
    '''    completeAuthorization: async (value) => {
      completion = value;
      return {
''',
    '''    completeAuthorization: async (value) => {
      completion = value;
      assert.equal(await repository.getConnection(value.connection.id), null);
      return {
''',
)
replace_once(
    "services/mcp-gateway/test/mcp-pairing.test.js",
    '''  assert.equal(repository.connections.size, 0);
''',
    '''  assert.equal(session.connection, null);
''',
)

worker_path = Path("services/mcp-gateway/src/cloudflare-worker.js")
worker = worker_path.read_text()
worker = worker.replace(
    'import { DurableObject } from "cloudflare:workers";\n',
    'import { DurableObject } from "cloudflare:workers";\n'
    'import { executeMcpPairingStoreRpc } from "./pairing-store-rpc.js";\n'
    'import { SqliteMcpPairingRepository } from "./sqlite-pairing-store.js";\n',
)
worker = worker.replace(
    '''export default {
''',
    '''export class McpPairingDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.repository = null;
    ctx.blockConcurrencyWhile(async () => {
      this.repository = new SqliteMcpPairingRepository(ctx.storage.sql);
    });
  }

  store() {
    if (!this.repository) throw new Error("MCP pairing repository is not initialized");
    return this.repository;
  }

  put(value) {
    return executeMcpPairingStoreRpc(() => this.store().putSession(value));
  }

  read(challengeId) {
    return executeMcpPairingStoreRpc(() => this.store().getSession(challengeId));
  }

  claim(value) {
    return executeMcpPairingStoreRpc(() => this.store().claimSession(
      value.id,
      value.root,
      value.claimId,
      value.connection,
    ));
  }

  release(value) {
    return executeMcpPairingStoreRpc(() => this.store().releaseSession(
      value.id,
      value.claimId,
      value.connectionId,
    ));
  }

  consume(value) {
    return executeMcpPairingStoreRpc(() => this.store().consumeSession(
      value.id,
      value.claimId,
      value.connectionId,
    ));
  }

  connection(connectionId) {
    return executeMcpPairingStoreRpc(() => this.store().getConnection(connectionId));
  }
}

export default {
''',
)
worker_path.write_text(worker)

replace_once(
    "services/mcp-gateway/wrangler.jsonc",
    '''      {
        "name": "MCP_REQUESTS",
        "class_name": "McpRequestDurableObject"
      }
''',
    '''      {
        "name": "MCP_REQUESTS",
        "class_name": "McpRequestDurableObject"
      },
      {
        "name": "MCP_PAIRINGS",
        "class_name": "McpPairingDurableObject"
      }
''',
)
replace_once(
    "services/mcp-gateway/wrangler.jsonc",
    '''    {
      "tag": "v1",
      "new_sqlite_classes": ["McpRequestDurableObject"]
    }
''',
    '''    {
      "tag": "v1",
      "new_sqlite_classes": ["McpRequestDurableObject"]
    },
    {
      "tag": "v2",
      "new_sqlite_classes": ["McpPairingDurableObject"]
    }
''',
)

replace_once(
    "services/mcp-gateway/src/index.js",
    'export * from "./cloudflare-request-store.js";\n',
    'export * from "./cloudflare-pairing-store.js";\nexport * from "./cloudflare-request-store.js";\n',
)
replace_once(
    "services/mcp-gateway/src/index.js",
    'export * from "./protocol.js";\n',
    'export * from "./pairing-store-rpc.js";\nexport * from "./protocol.js";\n',
)
replace_once(
    "services/mcp-gateway/src/index.js",
    'export * from "./sqlite-request-store.js";\n',
    'export * from "./sqlite-pairing-store.js";\nexport * from "./sqlite-request-store.js";\n',
)

package_path = Path("services/mcp-gateway/package.json")
import json
package_value = json.loads(package_path.read_text())
package_value["scripts"]["test:core"] = (
    "node --test "
    "test/gateway.test.js test/gateway-recovery.test.js test/mcp-transport.test.js "
    "test/request-store.test.js test/sqlite-request-store.test.js test/cloudflare-request-store.test.js "
    "test/mcp-pairing.test.js test/sqlite-pairing-store.test.js test/cloudflare-pairing-store.test.js"
)
package_path.write_text(json.dumps(package_value, indent=2) + "\n")

replace_once(
    "services/mcp-gateway/README.md",
    '''The pairing repository owns the one-time state transition:

```text
open → claimed → consumed
          │
          └── OAuth failure → open
```

Concurrent or replayed approvals cannot create another connection. If OAuth
completion fails, the provisional connection is removed and the original
signed assertion can be retried while it remains valid.
''',
    '''The pairing repository owns a lease-fenced state transition:

```text
open → claimed(connection pending) → consumed(connection active)
          │                            ▲
          ├── OAuth failure → open     │ atomic session transition
          └── expired lease → replacement claim
```

Every claim receives a connection ID derived from both the challenge ID and the
unique claim ID. The complete provisional connection is stored inside the same
pairing atom. Connection lookup returns it only after the session becomes
`consumed`. Therefore an OAuth token issued just before a Worker interruption
cannot use a pending connection and cannot become valid after a later claim
replaces it.

The repository's clock owns claim expiry. A stale claimant cannot consume or
release a replacement claim. Concurrent or replayed approvals cannot activate
another connection, while an interrupted claim can be safely retried during the
original challenge lifetime.
''',
)
replace_once(
    "services/mcp-gateway/README.md",
    '''- `src/mcp-pairing.js` — signed challenge/assertion protocol and one-time state.
- `src/mcp-authorization.js` — hardened OAuth authorization GET/POST handler.
''',
    '''- `src/mcp-pairing.js` — signed challenge/assertion protocol, lease-fenced state, and in-memory conformance repository.
- `src/sqlite-pairing-store.js` — one-session SQLite Durable Object repository and consumed-only connection view.
- `src/pairing-store-rpc.js` — closed non-leaking pairing repository RPC envelopes.
- `src/cloudflare-pairing-store.js` — challenge/connection routing through one pairing atom.
- `src/mcp-authorization.js` — hardened OAuth authorization GET/POST handler.
''',
)
replace_once(
    "services/mcp-gateway/README.md",
    '''## Next durable slice

The next PR gives signed pairing sessions the same durable storage treatment.
After both repositories survive isolate replacement, a separate delivery
adapter can attach verified Home Node or Beacon routes without letting remote
OAuth credentials substitute for local Greenways capability authority.
''',
    '''## Next delivery slice

Request and signed-pairing repositories now survive isolate replacement. The
next PR attaches a verified Home Node or Beacon route behind the existing
connection and Greenways capability checks. Remote OAuth credentials still
cannot substitute for resident Greenways authority.
''',
)

replace_once(
    "protocol/mcp-gateway.md",
    '''- one SQLite Durable Object coordination atom per request ID, with closed RPC errors and restart-safe replay;
- validation of stored results before replay;
''',
    '''- one SQLite Durable Object coordination atom per request ID, with closed RPC errors and restart-safe replay;
- one lease-fenced SQLite pairing atom per challenge, with provisional connections hidden until consumption;
- validation of stored results before replay;
''',
)
replace_once(
    "protocol/mcp-gateway.md",
    '''5. Cloudflare SQLite Durable Object request repository — implemented.
6. Durable pairing repository plus Home Node/Beacon delivery.
7. Hestia proposal tools for write intent; no direct execution.
8. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
9. Optional publication after security, privacy, and tool-description review.
''',
    '''5. Cloudflare SQLite Durable Object request repository — implemented.
6. Durable lease-fenced pairing repository — implemented.
7. Verified Home Node/Beacon delivery.
8. Hestia proposal tools for write intent; no direct execution.
9. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
10. Optional publication after security, privacy, and tool-description review.
''',
)

print("Applied durable MCP pairing integration")
