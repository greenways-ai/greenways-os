import {
  McpRequestStoreError,
  claimMcpRequestState,
  completeMcpRequestState,
  normalizeMcpRequestClaim,
  normalizeMcpRequestCompletion,
  normalizeMcpRequestId,
  normalizeMcpRequestRelease,
  normalizeMcpStoredRequestState,
  releaseMcpRequestState,
} from "./request-store.js";
import {
  MCP_REQUEST_CLAIM_PROTOCOL,
  MCP_REQUEST_RECORD_PROTOCOL,
} from "./protocol.js";

const MAX_RESULT_JSON_BYTES = 384 * 1024;
const textEncoder = new TextEncoder();

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS request_state (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  protocol TEXT NOT NULL,
  request_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  claim_id TEXT,
  claimed_at TEXT,
  expires_at TEXT,
  result_json TEXT,
  CHECK (
    (protocol = '${MCP_REQUEST_CLAIM_PROTOCOL}'
      AND claim_id IS NOT NULL
      AND claimed_at IS NOT NULL
      AND expires_at IS NOT NULL
      AND result_json IS NULL)
    OR
    (protocol = '${MCP_REQUEST_RECORD_PROTOCOL}'
      AND claim_id IS NULL
      AND claimed_at IS NULL
      AND expires_at IS NULL
      AND result_json IS NOT NULL)
  )
);
`;

const SELECT_STATE = `
SELECT protocol, request_id, digest, claim_id, claimed_at, expires_at, result_json
FROM request_state
WHERE slot = 1
`;

const UPSERT_STATE = `
INSERT INTO request_state (
  slot, protocol, request_id, digest, claim_id, claimed_at, expires_at, result_json
) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(slot) DO UPDATE SET
  protocol = excluded.protocol,
  request_id = excluded.request_id,
  digest = excluded.digest,
  claim_id = excluded.claim_id,
  claimed_at = excluded.claimed_at,
  expires_at = excluded.expires_at,
  result_json = excluded.result_json
`;

const DELETE_STATE = "DELETE FROM request_state WHERE slot = 1";

function fail(code, message, options) {
  throw new McpRequestStoreError(code, message, options);
}

function clone(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    fail("request-store-invalid", `${label} must be structured-cloneable`, { cause });
  }
}

function currentDate(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("request-store-invalid", "MCP SQLite request-store clock is invalid");
  }
  return value;
}

function rows(cursor) {
  if (!cursor || typeof cursor.toArray !== "function") {
    fail("request-store-recovery", "MCP SQLite request-store cursor is invalid");
  }
  try {
    return cursor.toArray();
  } catch (cause) {
    fail("request-store-recovery", "MCP SQLite request-store row read failed", { cause });
  }
}

function encodeResult(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (cause) {
    fail("request-store-invalid", "MCP request result is not JSON-serializable", { cause });
  }
  if (encoded === undefined || textEncoder.encode(encoded).byteLength > MAX_RESULT_JSON_BYTES) {
    fail("request-store-invalid", "MCP request result exceeds its durable storage limit");
  }
  return encoded;
}

function decodeResult(value) {
  if (typeof value !== "string" || !value) {
    fail("request-store-recovery", "Stored MCP request result JSON is invalid");
  }
  try {
    return JSON.parse(value);
  } catch (cause) {
    fail("request-store-recovery", "Stored MCP request result JSON is invalid", { cause });
  }
}

function rowState(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    fail("request-store-recovery", "Stored MCP request row is invalid");
  }
  let state;
  if (row.protocol === MCP_REQUEST_CLAIM_PROTOCOL) {
    if (row.result_json !== null
        || typeof row.claim_id !== "string"
        || typeof row.claimed_at !== "string"
        || typeof row.expires_at !== "string") {
      fail("request-store-recovery", "Stored MCP request claim row is inconsistent");
    }
    state = {
      protocol: row.protocol,
      requestId: row.request_id,
      digest: row.digest,
      claimId: row.claim_id,
      claimedAt: row.claimed_at,
      expiresAt: row.expires_at,
    };
  } else if (row.protocol === MCP_REQUEST_RECORD_PROTOCOL) {
    if (row.claim_id !== null || row.claimed_at !== null || row.expires_at !== null) {
      fail("request-store-recovery", "Stored MCP request record row is inconsistent");
    }
    state = {
      protocol: row.protocol,
      requestId: row.request_id,
      digest: row.digest,
      result: decodeResult(row.result_json),
    };
  } else {
    fail("request-store-recovery", "Stored MCP request row protocol is unsupported");
  }
  try {
    return normalizeMcpStoredRequestState(state);
  } catch (cause) {
    if (cause instanceof McpRequestStoreError) {
      fail("request-store-recovery", "Stored MCP request row failed validation", { cause });
    }
    throw cause;
  }
}

function encodedState(stateValue) {
  const state = normalizeMcpStoredRequestState(stateValue);
  if (state.protocol === MCP_REQUEST_CLAIM_PROTOCOL) {
    return [
      state.protocol,
      state.requestId,
      state.digest,
      state.claimId,
      state.claimedAt,
      state.expiresAt,
      null,
    ];
  }
  return [
    state.protocol,
    state.requestId,
    state.digest,
    null,
    null,
    null,
    encodeResult(state.result),
  ];
}

function publicDecision(transition) {
  return Object.freeze({
    disposition: transition.disposition,
    record: clone(transition.record, "MCP request-store decision"),
  });
}

export class SqliteMcpRequestRepository {
  constructor(sql, { now = () => new Date() } = {}) {
    if (!sql || typeof sql.exec !== "function") {
      throw new TypeError("MCP SQLite request repository requires the Durable Object SQL API");
    }
    if (typeof now !== "function") throw new TypeError("MCP SQLite request repository requires a clock");
    this.sql = sql;
    this.now = now;
    try {
      this.sql.exec(CREATE_SCHEMA);
    } catch (cause) {
      fail("request-store-recovery", "MCP SQLite request-store schema setup failed", { cause });
    }
  }

  read() {
    let cursor;
    try {
      cursor = this.sql.exec(SELECT_STATE);
    } catch (cause) {
      fail("request-store-recovery", "MCP SQLite request-store read failed", { cause });
    }
    const values = rows(cursor);
    if (values.length === 0) return null;
    if (values.length !== 1) {
      fail("request-store-recovery", "MCP SQLite request-store contains multiple state rows");
    }
    return rowState(values[0]);
  }

  write(state) {
    try {
      this.sql.exec(UPSERT_STATE, ...encodedState(state));
    } catch (cause) {
      if (cause instanceof McpRequestStoreError) throw cause;
      fail("request-store-recovery", "MCP SQLite request-store write failed", { cause });
    }
  }

  remove() {
    try {
      this.sql.exec(DELETE_STATE);
    } catch (cause) {
      fail("request-store-recovery", "MCP SQLite request-store release failed", { cause });
    }
  }

  get(idValue) {
    const id = normalizeMcpRequestId(idValue);
    const state = this.read();
    if (state && state.requestId !== id) {
      fail("request-store-recovery", "MCP Durable Object request identity changed");
    }
    return state === null ? null : clone(state, "MCP request-store state");
  }

  claim(value) {
    const proposed = normalizeMcpRequestClaim(value);
    const transition = claimMcpRequestState(this.read(), proposed, currentDate(this.now));
    if (transition.changed) this.write(transition.next);
    return publicDecision(transition);
  }

  complete(value) {
    const input = normalizeMcpRequestCompletion(value);
    const transition = completeMcpRequestState(this.read(), input);
    if (transition.changed) this.write(transition.next);
    return clone(transition.record, "MCP request record");
  }

  release(value) {
    const input = normalizeMcpRequestRelease(value);
    const transition = releaseMcpRequestState(this.read(), input);
    if (transition.changed) this.remove();
    return transition.released;
  }
}
