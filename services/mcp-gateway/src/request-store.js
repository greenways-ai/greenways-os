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

function currentTime(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("request-store-invalid", "MCP request store clock is invalid");
  }
  return value.getTime();
}

export function normalizeMcpRequestId(value) {
  return string(value, "MCP request store request ID", REQUEST_ID);
}

export function normalizeMcpRequestDigest(value) {
  return string(value, "MCP request store digest", DIGEST);
}

export function normalizeMcpRequestClaimId(value) {
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
    requestId: normalizeMcpRequestId(input.requestId),
    digest: normalizeMcpRequestDigest(input.digest),
    claimId: normalizeMcpRequestClaimId(input.claimId),
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
    requestId: normalizeMcpRequestId(input.requestId),
    digest: normalizeMcpRequestDigest(input.digest),
    result: clone(input.result, "MCP request record result"),
  });
}

export function normalizeMcpStoredRequestState(value) {
  if (value?.protocol === MCP_REQUEST_CLAIM_PROTOCOL) return normalizeMcpRequestClaim(value);
  if (value?.protocol === MCP_REQUEST_RECORD_PROTOCOL) return normalizeMcpRequestRecord(value);
  fail("request-store-invalid", "MCP request store record protocol is unsupported");
}

export function normalizeMcpRequestWait(value) {
  const input = closedKeys(
    value,
    new Set(["requestId", "digest", "claimId", "timeoutMs"]),
    "MCP request wait",
  );
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 0 || input.timeoutMs > MAX_WAIT_MS) {
    fail("request-store-invalid", "MCP request wait timeout is invalid");
  }
  return Object.freeze({
    requestId: normalizeMcpRequestId(input.requestId),
    digest: normalizeMcpRequestDigest(input.digest),
    claimId: normalizeMcpRequestClaimId(input.claimId),
    timeoutMs: input.timeoutMs,
  });
}

export function normalizeMcpRequestCompletion(value) {
  const input = closedKeys(
    value,
    new Set(["requestId", "digest", "claimId", "result"]),
    "MCP request completion",
  );
  if (input.result === undefined) {
    fail("request-store-invalid", "MCP request completion result is required");
  }
  return Object.freeze({
    requestId: normalizeMcpRequestId(input.requestId),
    digest: normalizeMcpRequestDigest(input.digest),
    claimId: normalizeMcpRequestClaimId(input.claimId),
    result: clone(input.result, "MCP request completion result"),
  });
}

export function normalizeMcpRequestRelease(value) {
  const input = closedKeys(
    value,
    new Set(["requestId", "digest", "claimId"]),
    "MCP request claim release",
  );
  return Object.freeze({
    requestId: normalizeMcpRequestId(input.requestId),
    digest: normalizeMcpRequestDigest(input.digest),
    claimId: normalizeMcpRequestClaimId(input.claimId),
  });
}

function normalizedCurrent(value) {
  return value === null || value === undefined ? null : normalizeMcpStoredRequestState(value);
}

function stateTransition(changed, next, extra) {
  return Object.freeze({
    changed,
    next: next === null ? null : clone(next, "MCP request state transition"),
    ...extra,
  });
}

export function claimMcpRequestState(currentValue, proposedValue, nowValue) {
  const proposed = normalizeMcpRequestClaim(proposedValue);
  const current = normalizedCurrent(currentValue);
  const observedAt = currentTime(nowValue);
  if (current) {
    if (current.requestId !== proposed.requestId) {
      fail("request-store-recovery", "Stored MCP request identity changed");
    }
    if (current.digest !== proposed.digest) {
      fail("request-id-collision", "MCP request ID was reused with different content");
    }
    if (current.protocol === MCP_REQUEST_RECORD_PROTOCOL) {
      return stateTransition(false, current, {
        disposition: "completed",
        record: clone(current, "MCP request record"),
      });
    }
    if (Date.parse(current.expiresAt) > observedAt) {
      return stateTransition(false, current, {
        disposition: "pending",
        record: clone(current, "MCP request claim"),
      });
    }
  }
  return stateTransition(true, proposed, {
    disposition: "acquired",
    record: clone(proposed, "MCP request claim"),
  });
}

export function completeMcpRequestState(currentValue, completionValue) {
  const completion = normalizeMcpRequestCompletion(completionValue);
  const current = normalizedCurrent(currentValue);
  if (!current) fail("request-claim-stale", "MCP request claim is no longer current");
  if (current.requestId !== completion.requestId) {
    fail("request-store-recovery", "Stored MCP request identity changed");
  }
  if (current.digest !== completion.digest) {
    fail("request-id-collision", "MCP request ID was reused with different content");
  }
  if (current.protocol === MCP_REQUEST_RECORD_PROTOCOL) {
    return stateTransition(false, current, {
      record: clone(current, "MCP request record"),
    });
  }
  if (current.claimId !== completion.claimId) {
    fail("request-claim-stale", "MCP request claim is no longer current");
  }
  const record = normalizeMcpRequestRecord({
    protocol: MCP_REQUEST_RECORD_PROTOCOL,
    requestId: completion.requestId,
    digest: completion.digest,
    result: completion.result,
  });
  return stateTransition(true, record, {
    record: clone(record, "MCP request record"),
  });
}

export function releaseMcpRequestState(currentValue, releaseValue) {
  const release = normalizeMcpRequestRelease(releaseValue);
  const current = normalizedCurrent(currentValue);
  if (!current) return stateTransition(false, null, { released: false });
  if (current.requestId !== release.requestId) {
    fail("request-store-recovery", "Stored MCP request identity changed");
  }
  if (current.digest !== release.digest) {
    fail("request-id-collision", "MCP request ID was reused with different content");
  }
  if (current.protocol === MCP_REQUEST_RECORD_PROTOCOL || current.claimId !== release.claimId) {
    return stateTransition(false, current, { released: false });
  }
  return stateTransition(true, null, { released: true });
}

function decision(disposition, record) {
  return Object.freeze({ disposition, record: clone(record, "MCP request store decision") });
}

export class MemoryMcpRequestStore {
  constructor(records = [], { now = () => new Date() } = {}) {
    if (!Array.isArray(records)) throw new TypeError("MCP request store records must be an array");
    if (typeof now !== "function") throw new TypeError("MCP request store requires a clock");
    this.records = new Map();
    this.waiters = new Map();
    this.now = now;
    for (const recordValue of records) {
      const record = normalizeMcpStoredRequestState(recordValue);
      if (this.records.has(record.requestId)) {
        throw new TypeError(`Duplicate MCP request store record: ${record.requestId}`);
      }
      this.records.set(record.requestId, clone(record, "MCP request store record"));
    }
  }

  currentDate() {
    const value = this.now();
    currentTime(value);
    return value;
  }

  notify(id) {
    const waiters = this.waiters.get(id);
    if (!waiters) return;
    for (const waiter of [...waiters]) waiter();
  }

  async get(idValue) {
    const id = normalizeMcpRequestId(idValue);
    const value = this.records.get(id);
    return value === undefined ? null : clone(value, "MCP request store record");
  }

  async claim(value) {
    const proposed = normalizeMcpRequestClaim(value);
    const transition = claimMcpRequestState(
      this.records.get(proposed.requestId) ?? null,
      proposed,
      this.currentDate(),
    );
    if (transition.changed) {
      this.records.set(proposed.requestId, clone(transition.next, "MCP request claim"));
      this.notify(proposed.requestId);
    }
    return decision(transition.disposition, transition.record);
  }

  async wait(value) {
    const input = normalizeMcpRequestWait(value);
    const inspect = () => {
      const current = this.records.get(input.requestId);
      if (!current) return { done: true, value: null };
      if (current.digest !== input.digest) {
        fail("request-id-collision", "MCP request ID was reused with different content");
      }
      if (current.protocol === MCP_REQUEST_RECORD_PROTOCOL) {
        return { done: true, value: clone(current, "MCP request record") };
      }
      if (current.claimId !== input.claimId) return { done: true, value: null };
      return { done: false, value: null };
    };

    const immediate = inspect();
    if (immediate.done) return immediate.value;

    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        const waiters = this.waiters.get(input.requestId);
        waiters?.delete(check);
        if (waiters?.size === 0) this.waiters.delete(input.requestId);
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
      const waiters = this.waiters.get(input.requestId) ?? new Set();
      waiters.add(check);
      this.waiters.set(input.requestId, waiters);
      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, input.timeoutMs);
    });
  }

  async complete(value) {
    const input = normalizeMcpRequestCompletion(value);
    const transition = completeMcpRequestState(
      this.records.get(input.requestId) ?? null,
      input,
    );
    if (transition.changed) {
      this.records.set(input.requestId, clone(transition.next, "MCP request record"));
      this.notify(input.requestId);
    }
    return clone(transition.record, "MCP request record");
  }

  async release(value) {
    const input = normalizeMcpRequestRelease(value);
    const transition = releaseMcpRequestState(
      this.records.get(input.requestId) ?? null,
      input,
    );
    if (transition.changed) {
      this.records.delete(input.requestId);
      this.notify(input.requestId);
    }
    return transition.released;
  }
}
