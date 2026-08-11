import {
  MCP_REQUEST_CLAIM_PROTOCOL,
  MCP_REQUEST_RECORD_PROTOCOL,
} from "./protocol.js";

const REQUEST_ID = /^mcp\/request\/[A-Za-z0-9._:-]{8,160}$/;
const CLAIM_ID = /^mcp\/claim\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_WAIT_MS = 2 * 60 * 1000;

export class McpRequestStoreError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "McpRequestStoreError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new McpRequestStoreError(code, message, options);
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("request-store-invalid", `${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("request-store-invalid", `${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      fail("request-store-invalid", `${label} contains an unsupported field: ${key}`);
    }
  }
  return input;
}

function string(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("request-store-invalid", `${label} is invalid`);
  }
  return value;
}

function canonicalTime(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString() !== value) {
    fail("request-store-invalid", `${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function clone(value, label) {
  try {
    return structuredClone(value);
  } catch (cause) {
    fail("request-store-invalid", `${label} must be structured-cloneable`, { cause });
  }
}

function requestId(value) {
  return string(value, "MCP request store request ID", REQUEST_ID);
}

function digest(value) {
  return string(value, "MCP request store digest", DIGEST);
}

function claimId(value) {
  return string(value, "MCP request store claim ID", CLAIM_ID);
}

export function normalizeMcpRequestClaim(value) {
  const input = closedKeys(
    value,
    new Set(["protocol", "requestId", "digest", "claimId", "claimedAt", "expiresAt"]),
    "MCP request claim",
  );
  if (input.protocol !== MCP_REQUEST_CLAIM_PROTOCOL) {
    fail("request-store-invalid", "MCP request claim protocol is unsupported");
  }
  const claimedAt = canonicalTime(input.claimedAt, "MCP request claim claimedAt");
  const expiresAt = canonicalTime(input.expiresAt, "MCP request claim expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) {
    fail("request-store-invalid", "MCP request claim expiry must follow acquisition");
  }
  return Object.freeze({
    protocol: MCP_REQUEST_CLAIM_PROTOCOL,
    requestId: requestId(input.requestId),
    digest: digest(input.digest),
    claimId: claimId(input.claimId),
    claimedAt,
    expiresAt,
  });
}

export function normalizeMcpRequestRecord(value) {
  const input = closedKeys(
    value,
    new Set(["protocol", "requestId", "digest", "result"]),
    "MCP request record",
  );
  if (input.protocol !== MCP_REQUEST_RECORD_PROTOCOL) {
    fail("request-store-invalid", "MCP request record protocol is unsupported");
  }
  if (input.result === undefined) {
    fail("request-store-invalid", "MCP request record result is required");
  }
  return Object.freeze({
    protocol: MCP_REQUEST_RECORD_PROTOCOL,
    requestId: requestId(input.requestId),
    digest: digest(input.digest),
    result: clone(input.result, "MCP request record result"),
  });
}

function normalizeStored(value) {
  if (value?.protocol === MCP_REQUEST_CLAIM_PROTOCOL) return normalizeMcpRequestClaim(value);
  if (value?.protocol === MCP_REQUEST_RECORD_PROTOCOL) return normalizeMcpRequestRecord(value);
  fail("request-store-invalid", "MCP request store record protocol is unsupported");
}

function decision(disposition, record) {
  return Object.freeze({ disposition, record: clone(record, "MCP request store decision") });
}

export class MemoryMcpRequestStore {
  constructor(records = []) {
    if (!Array.isArray(records)) throw new TypeError("MCP request store records must be an array");
    this.records = new Map();
    this.waiters = new Map();
    for (const recordValue of records) {
      const record = normalizeStored(recordValue);
      if (this.records.has(record.requestId)) {
        throw new TypeError(`Duplicate MCP request store record: ${record.requestId}`);
      }
      this.records.set(record.requestId, clone(record, "MCP request store record"));
    }
  }

  notify(id) {
    const waiters = this.waiters.get(id);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter();
  }

  async get(idValue) {
    const id = requestId(idValue);
    const value = this.records.get(id);
    return value === undefined ? null : clone(value, "MCP request store record");
  }

  async claim(value) {
    const proposed = normalizeMcpRequestClaim(value);
    const current = this.records.get(proposed.requestId);
    if (current) {
      if (current.digest !== proposed.digest) {
        fail("request-id-collision", "MCP request ID was reused with different content");
      }
      if (current.protocol === MCP_REQUEST_RECORD_PROTOCOL) {
        return decision("completed", current);
      }
      if (Date.parse(current.expiresAt) > Date.parse(proposed.claimedAt)) {
        return decision("pending", current);
      }
    }
    this.records.set(proposed.requestId, clone(proposed, "MCP request claim"));
    this.notify(proposed.requestId);
    return decision("acquired", proposed);
  }

  async wait(value) {
    const input = closedKeys(
      value,
      new Set(["requestId", "digest", "claimId", "timeoutMs"]),
      "MCP request wait",
    );
    const id = requestId(input.requestId);
    const expectedDigest = digest(input.digest);
    const expectedClaim = claimId(input.claimId);
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > MAX_WAIT_MS) {
      fail("request-store-invalid", "MCP request wait timeout is invalid");
    }

    const inspect = () => {
      const current = this.records.get(id);
      if (!current) return { done: true, value: null };
      if (current.digest !== expectedDigest) {
        fail("request-id-collision", "MCP request ID was reused with different content");
      }
      if (current.protocol === MCP_REQUEST_RECORD_PROTOCOL) {
        return { done: true, value: clone(current, "MCP request record") };
      }
      if (current.claimId !== expectedClaim) return { done: true, value: null };
      return { done: false, value: null };
    };

    const immediate = inspect();
    if (immediate.done) return immediate.value;

    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        const waiters = this.waiters.get(id);
        waiters?.delete(check);
        if (waiters?.size === 0) this.waiters.delete(id);
      };
      const check = () => {
        try {
          const state = inspect();
          if (!state.done) return;
          cleanup();
          resolve(state.value);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const waiters = this.waiters.get(id) ?? new Set();
      waiters.add(check);
      this.waiters.set(id, waiters);
      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, input.timeoutMs);
    });
  }

  async complete(value) {
    const input = closedKeys(
      value,
      new Set(["requestId", "digest", "claimId", "result"]),
      "MCP request completion",
    );
    const id = requestId(input.requestId);
    const expectedDigest = digest(input.digest);
    const expectedClaim = claimId(input.claimId);
    if (input.result === undefined) {
      fail("request-store-invalid", "MCP request completion result is required");
    }
    const current = this.records.get(id);
    if (!current) fail("request-claim-stale", "MCP request claim is no longer current");
    if (current.digest !== expectedDigest) {
      fail("request-id-collision", "MCP request ID was reused with different content");
    }
    if (current.protocol === MCP_REQUEST_RECORD_PROTOCOL) {
      return clone(current, "MCP request record");
    }
    if (current.claimId !== expectedClaim) {
      fail("request-claim-stale", "MCP request claim is no longer current");
    }
    const record = normalizeMcpRequestRecord({
      protocol: MCP_REQUEST_RECORD_PROTOCOL,
      requestId: id,
      digest: expectedDigest,
      result: input.result,
    });
    this.records.set(id, clone(record, "MCP request record"));
    this.notify(id);
    return clone(record, "MCP request record");
  }

  async release(value) {
    const input = closedKeys(
      value,
      new Set(["requestId", "digest", "claimId"]),
      "MCP request claim release",
    );
    const id = requestId(input.requestId);
    const expectedDigest = digest(input.digest);
    const expectedClaim = claimId(input.claimId);
    const current = this.records.get(id);
    if (!current) return false;
    if (current.digest !== expectedDigest) {
      fail("request-id-collision", "MCP request ID was reused with different content");
    }
    if (current.protocol === MCP_REQUEST_RECORD_PROTOCOL || current.claimId !== expectedClaim) {
      return false;
    }
    this.records.delete(id);
    this.notify(id);
    return true;
  }
}
