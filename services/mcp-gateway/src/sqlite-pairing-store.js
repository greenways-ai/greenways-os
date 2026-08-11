import {
  MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS,
  MCP_PAIRING_SESSION_PROTOCOL,
  McpPairingError,
  claimMcpPairingSessionState,
  consumeMcpPairingSessionState,
  mcpChallengeIdForConnection,
  normalizeMcpPairingChallengeId,
  normalizeMcpPairingClaimId,
  normalizeMcpPairingConnectionId,
  normalizeMcpPairingSession,
  putMcpPairingSessionState,
  releaseMcpPairingSessionState,
} from "./mcp-pairing.js";

const MAX_SESSION_JSON_BYTES = 96 * 1024;
const textEncoder = new TextEncoder();

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS pairing_session (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  protocol TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'claimed', 'consumed')),
  challenge_root TEXT NOT NULL,
  claim_id TEXT,
  claimed_at TEXT,
  claim_expires_at TEXT,
  consumed_at TEXT,
  connection_id TEXT,
  session_json TEXT NOT NULL,
  CHECK (
    (state = 'open'
      AND claim_id IS NULL
      AND claimed_at IS NULL
      AND claim_expires_at IS NULL
      AND consumed_at IS NULL
      AND connection_id IS NULL)
    OR
    (state = 'claimed'
      AND claim_id IS NOT NULL
      AND claimed_at IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND consumed_at IS NULL
      AND connection_id IS NOT NULL)
    OR
    (state = 'consumed'
      AND claim_id IS NOT NULL
      AND claimed_at IS NOT NULL
      AND claim_expires_at IS NOT NULL
      AND consumed_at IS NOT NULL
      AND connection_id IS NOT NULL)
  )
);
`;

const SELECT_SESSION = `
SELECT
  protocol,
  session_id,
  state,
  challenge_root,
  claim_id,
  claimed_at,
  claim_expires_at,
  consumed_at,
  connection_id,
  session_json
FROM pairing_session
WHERE slot = 1
`;

const UPSERT_SESSION = `
INSERT INTO pairing_session (
  slot,
  protocol,
  session_id,
  state,
  challenge_root,
  claim_id,
  claimed_at,
  claim_expires_at,
  consumed_at,
  connection_id,
  session_json
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(slot) DO UPDATE SET
  protocol = excluded.protocol,
  session_id = excluded.session_id,
  state = excluded.state,
  challenge_root = excluded.challenge_root,
  claim_id = excluded.claim_id,
  claimed_at = excluded.claimed_at,
  claim_expires_at = excluded.claim_expires_at,
  consumed_at = excluded.consumed_at,
  connection_id = excluded.connection_id,
  session_json = excluded.session_json
`;

function fail(status, code, message, options) {
  throw new McpPairingError(status, code, message, options);
}

function clone(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    fail(500, "pairing-recovery", `${label} must be structured-cloneable`, { cause });
  }
}

function repositoryDate(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(500, "pairing-recovery", "MCP SQLite pairing-store clock is invalid");
  }
  return value;
}

function rows(cursor) {
  if (!cursor || typeof cursor.toArray !== "function") {
    fail(500, "pairing-recovery", "MCP SQLite pairing-store cursor is invalid");
  }
  try {
    return cursor.toArray();
  } catch (cause) {
    fail(503, "pairing-store-unavailable", "MCP SQLite pairing-store row read is unavailable", { cause });
  }
}

function encodeSession(sessionValue) {
  const session = normalizeMcpPairingSession(sessionValue);
  let encoded;
  try {
    encoded = JSON.stringify(session);
  } catch (cause) {
    fail(500, "pairing-recovery", "MCP pairing session is not JSON-serializable", { cause });
  }
  if (encoded === undefined || textEncoder.encode(encoded).byteLength > MAX_SESSION_JSON_BYTES) {
    fail(500, "pairing-recovery", "MCP pairing session exceeds its durable storage limit");
  }
  return encoded;
}

function decodeSession(value) {
  if (typeof value !== "string" || !value) {
    fail(500, "pairing-recovery", "Stored MCP pairing session JSON is invalid");
  }
  let decoded;
  try {
    decoded = JSON.parse(value);
  } catch (cause) {
    fail(500, "pairing-recovery", "Stored MCP pairing session JSON is invalid", { cause });
  }
  return normalizeMcpPairingSession(decoded);
}

function rowSession(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail(500, "pairing-recovery", "Stored MCP pairing row is invalid");
  }
  const session = decodeSession(row.session_json);
  const connectionId = session.connection?.id ?? null;
  if (row.protocol !== MCP_PAIRING_SESSION_PROTOCOL
      || row.protocol !== session.protocol
      || row.session_id !== session.id
      || row.state !== session.state
      || row.challenge_root !== session.challenge.root
      || row.claim_id !== session.claimId
      || row.claimed_at !== session.claimedAt
      || row.claim_expires_at !== session.claimExpiresAt
      || row.consumed_at !== session.consumedAt
      || row.connection_id !== connectionId) {
    fail(500, "pairing-recovery", "Stored MCP pairing row does not match its session bytes");
  }
  return session;
}

function encodedColumns(sessionValue) {
  const session = normalizeMcpPairingSession(sessionValue);
  return [
    session.protocol,
    session.id,
    session.state,
    session.challenge.root,
    session.claimId,
    session.claimedAt,
    session.claimExpiresAt,
    session.consumedAt,
    session.connection?.id ?? null,
    encodeSession(session),
  ];
}

export class SqliteMcpPairingRepository {
  constructor(sql, {
    now = () => new Date(),
    claimLifetimeMs = MCP_PAIRING_DEFAULT_CLAIM_LIFETIME_MS,
  } = {}) {
    if (!sql || typeof sql.exec !== "function") {
      throw new TypeError("MCP SQLite pairing repository requires the Durable Object SQL API");
    }
    if (typeof now !== "function") throw new TypeError("MCP SQLite pairing repository requires a clock");
    this.sql = sql;
    this.now = now;
    this.claimLifetimeMs = claimLifetimeMs;
    try {
      this.sql.exec(CREATE_SCHEMA);
    } catch (cause) {
      fail(503, "pairing-store-unavailable", "MCP SQLite pairing-store schema setup is unavailable", { cause });
    }
  }

  read() {
    let cursor;
    try {
      cursor = this.sql.exec(SELECT_SESSION);
    } catch (cause) {
      fail(503, "pairing-store-unavailable", "MCP SQLite pairing-store read is unavailable", { cause });
    }
    const values = rows(cursor);
    if (values.length === 0) return null;
    if (values.length !== 1) {
      fail(500, "pairing-recovery", "MCP SQLite pairing-store contains multiple session rows");
    }
    return rowSession(values[0]);
  }

  write(session) {
    try {
      this.sql.exec(UPSERT_SESSION, ...encodedColumns(session));
    } catch (cause) {
      if (cause instanceof McpPairingError) throw cause;
      fail(503, "pairing-store-unavailable", "MCP SQLite pairing-store write is unavailable", { cause });
    }
  }

  putSession(sessionValue) {
    const transition = putMcpPairingSessionState(this.read(), sessionValue);
    this.write(transition.session);
    return clone(transition.session, "MCP pairing session");
  }

  getSession(idValue) {
    const id = normalizeMcpPairingChallengeId(idValue, 500);
    const session = this.read();
    if (session && session.id !== id) {
      fail(500, "pairing-recovery", "MCP Durable Object pairing identity changed");
    }
    return session === null ? null : clone(session, "MCP pairing session");
  }

  claimSession(idValue, root, claimIdValue, connectionValue) {
    const id = normalizeMcpPairingChallengeId(idValue, 500);
    const claimId = normalizeMcpPairingClaimId(claimIdValue, 500);
    const transition = claimMcpPairingSessionState(
      this.read(),
      { id, root, claimId, connection: connectionValue },
      repositoryDate(this.now),
      this.claimLifetimeMs,
    );
    this.write(transition.session);
    return clone(transition.session, "MCP pairing session");
  }

  releaseSession(idValue, claimIdValue, connectionIdValue) {
    const id = normalizeMcpPairingChallengeId(idValue, 500);
    const claimId = normalizeMcpPairingClaimId(claimIdValue, 500);
    const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
    const transition = releaseMcpPairingSessionState(
      this.read(),
      { id, claimId, connectionId },
    );
    if (transition.changed) this.write(transition.session);
    return transition.released;
  }

  consumeSession(idValue, claimIdValue, connectionIdValue) {
    const id = normalizeMcpPairingChallengeId(idValue, 500);
    const claimId = normalizeMcpPairingClaimId(claimIdValue, 500);
    const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
    const transition = consumeMcpPairingSessionState(
      this.read(),
      { id, claimId, connectionId },
      repositoryDate(this.now),
    );
    this.write(transition.session);
    return clone(transition.session, "MCP pairing session");
  }

  getConnection(connectionIdValue) {
    const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
    const challengeId = mcpChallengeIdForConnection(connectionId);
    const session = this.getSession(challengeId);
    if (!session || session.state !== "consumed" || session.connection?.id !== connectionId) {
      return null;
    }
    return clone(session.connection, "MCP connection");
  }
}
