from pathlib import Path


def replace_once(path, old, new):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one anchor in {path}, found {count}: {old[:120]!r}")
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
    target.write_text(text[:start] + replacement + text[end + len(end_marker):])


request_store = '''import {
  MCP_REQUEST_CLAIM_PROTOCOL,
  MCP_REQUEST_RECORD_PROTOCOL,
} from "./protocol.js";

const REQUEST_ID = /^mcp\\/request\\/[A-Za-z0-9._:-]{8,160}$/;
const CLAIM_ID = /^mcp\\/claim\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
'''
Path("services/mcp-gateway/src/request-store.js").write_text(request_store)

request_store_test = '''import assert from "node:assert/strict";
import test from "node:test";
import {
  McpRequestStoreError,
  MemoryMcpRequestStore,
} from "../src/request-store.js";
import {
  MCP_REQUEST_CLAIM_PROTOCOL,
  MCP_REQUEST_RECORD_PROTOCOL,
} from "../src/protocol.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

function claim(overrides = {}) {
  return {
    protocol: MCP_REQUEST_CLAIM_PROTOCOL,
    requestId: "mcp/request/store-0001",
    digest: DIGEST_A,
    claimId: "mcp/claim/01234567-89ab-4def-8123-000000000001",
    claimedAt: "2026-08-11T05:00:00.000Z",
    expiresAt: "2026-08-11T05:00:30.000Z",
    ...overrides,
  };
}

function hasCode(error, code) {
  return error instanceof McpRequestStoreError && error.code === code;
}

test("admits one claim owner, fences collisions, and wakes duplicate waiters with the completed record", async () => {
  const store = new MemoryMcpRequestStore();
  const first = await store.claim(claim());
  assert.equal(first.disposition, "acquired");

  const secondClaimId = "mcp/claim/01234567-89ab-4def-8123-000000000002";
  const pending = await store.claim(claim({ claimId: secondClaimId }));
  assert.equal(pending.disposition, "pending");
  assert.equal(pending.record.claimId, first.record.claimId);

  await assert.rejects(
    store.claim(claim({ digest: DIGEST_B, claimId: secondClaimId })),
    (error) => hasCode(error, "request-id-collision"),
  );

  const waiting = store.wait({
    requestId: first.record.requestId,
    digest: first.record.digest,
    claimId: first.record.claimId,
    timeoutMs: 1_000,
  });
  const completed = await store.complete({
    requestId: first.record.requestId,
    digest: first.record.digest,
    claimId: first.record.claimId,
    result: { protocol: "greenways-mcp-result/1", outcome: "ok" },
  });
  assert.equal(completed.protocol, MCP_REQUEST_RECORD_PROTOCOL);
  assert.deepEqual(await waiting, completed);

  const replay = await store.claim(claim({ claimId: secondClaimId }));
  assert.equal(replay.disposition, "completed");
  assert.deepEqual(replay.record, completed);
});

test("replaces an expired claim and rejects completion from the fenced owner", async () => {
  const store = new MemoryMcpRequestStore();
  const stale = await store.claim(claim({ expiresAt: "2026-08-11T05:00:10.000Z" }));
  const replacement = await store.claim(claim({
    claimId: "mcp/claim/01234567-89ab-4def-8123-000000000002",
    claimedAt: "2026-08-11T05:00:11.000Z",
    expiresAt: "2026-08-11T05:00:41.000Z",
  }));
  assert.equal(replacement.disposition, "acquired");

  await assert.rejects(
    store.complete({
      requestId: stale.record.requestId,
      digest: stale.record.digest,
      claimId: stale.record.claimId,
      result: { outcome: "stale" },
    }),
    (error) => hasCode(error, "request-claim-stale"),
  );

  assert.equal(await store.release({
    requestId: replacement.record.requestId,
    digest: replacement.record.digest,
    claimId: replacement.record.claimId,
  }), true);
  assert.equal(await store.get(replacement.record.requestId), null);
});
'''
Path("services/mcp-gateway/test/request-store.test.js").write_text(request_store_test)

replace_once(
    "services/mcp-gateway/src/protocol.js",
    'export const MCP_REQUEST_RECORD_PROTOCOL = "greenways-mcp-request-record/1";\n',
    'export const MCP_REQUEST_RECORD_PROTOCOL = "greenways-mcp-request-record/1";\nexport const MCP_REQUEST_CLAIM_PROTOCOL = "greenways-mcp-request-claim/1";\n',
)

replace_once(
    "services/mcp-gateway/src/gateway.js",
    '''import {
  MCP_REQUEST_RECORD_PROTOCOL,
''',
    '''import {
  MCP_REQUEST_CLAIM_PROTOCOL,
  MCP_REQUEST_RECORD_PROTOCOL,
''',
)
replace_once(
    "services/mcp-gateway/src/gateway.js",
    '''const MAX_PROVENANCE = 16;
''',
    '''const MAX_PROVENANCE = 16;
const REQUEST_STORE_DISPOSITIONS = new Set(["acquired", "pending", "completed"]);
const CLAIM_ID = /^mcp\\/claim\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_REQUEST_CLAIM_LIFETIME_MS = 30 * 1000;
const MIN_REQUEST_CLAIM_LIFETIME_MS = 1000;
const MAX_REQUEST_CLAIM_LIFETIME_MS = 60 * 1000;
const MAX_REQUEST_CLAIM_ATTEMPTS = 3;
''',
)
replace_once(
    "services/mcp-gateway/src/gateway.js",
    '''function activeConnection(connection, now) {
''',
    '''function requestClaimLifetime(value) {
  if (!Number.isSafeInteger(value)
      || value < MIN_REQUEST_CLAIM_LIFETIME_MS
      || value > MAX_REQUEST_CLAIM_LIFETIME_MS) {
    throw new TypeError(
      `MCP request claim lifetime must be ${MIN_REQUEST_CLAIM_LIFETIME_MS}-${MAX_REQUEST_CLAIM_LIFETIME_MS}ms`,
    );
  }
  return value;
}

function secureRequestClaimId(randomUUID) {
  let value;
  try {
    value = String(randomUUID());
  } catch (cause) {
    fail(500, "runtime-unavailable", "MCP request claim randomness is unavailable", { cause });
  }
  if (!UUID.test(value)) {
    fail(500, "runtime-unavailable", "MCP request claim randomness is invalid");
  }
  return `mcp/claim/${value.toLowerCase()}`;
}

function normalizeStoredClaim(value, request, digest) {
  const input = closedKeys(
    value,
    new Set(["protocol", "requestId", "digest", "claimId", "claimedAt", "expiresAt"]),
    "Stored MCP request claim",
  );
  if (input.protocol !== MCP_REQUEST_CLAIM_PROTOCOL || input.requestId !== request.requestId) {
    fail(500, "gateway-recovery", "Stored MCP request claim identity is invalid");
  }
  const storedDigest = validateDigest(input.digest, "Stored MCP request claim digest");
  if (storedDigest !== digest) {
    fail(409, "request-id-collision", "MCP request ID was reused with different content");
  }
  const claimId = publicString(input.claimId, "Stored MCP request claim ID", 160);
  if (!CLAIM_ID.test(claimId)) {
    fail(500, "gateway-recovery", "Stored MCP request claim ID is invalid");
  }
  const claimedAt = canonicalTime(input.claimedAt, "Stored MCP request claim claimedAt");
  const expiresAt = canonicalTime(input.expiresAt, "Stored MCP request claim expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) {
    fail(500, "gateway-recovery", "Stored MCP request claim lifetime is invalid");
  }
  return Object.freeze({
    protocol: MCP_REQUEST_CLAIM_PROTOCOL,
    requestId: request.requestId,
    digest: storedDigest,
    claimId,
    claimedAt,
    expiresAt,
  });
}

function normalizeRequestStoreDecision(value, request, digest, expectedClaimId) {
  const input = closedKeys(
    value,
    new Set(["disposition", "record"]),
    "MCP request store decision",
  );
  const disposition = publicString(input.disposition, "MCP request store disposition", 40);
  if (!REQUEST_STORE_DISPOSITIONS.has(disposition)) {
    fail(500, "gateway-recovery", "MCP request store disposition is invalid");
  }
  if (disposition === "completed") {
    return Object.freeze({ disposition, record: input.record });
  }
  const record = normalizeStoredClaim(input.record, request, digest);
  if (disposition === "acquired" && record.claimId !== expectedClaimId) {
    fail(500, "gateway-recovery", "MCP request store returned another claim as acquired");
  }
  return Object.freeze({ disposition, record });
}

function requestStoreFailure(cause, message) {
  if (cause instanceof McpGatewayError) throw cause;
  if (cause?.code === "request-id-collision") {
    fail(409, "request-id-collision", "MCP request ID was reused with different content", { cause });
  }
  if (cause?.code === "request-claim-stale") {
    fail(409, "request-claim-lost", "MCP request ownership changed before its result was stored", { cause });
  }
  fail(503, "gateway-storage-unavailable", message, { cause });
}

function activeConnection(connection, now) {
''',
)

class_prefix = '''export class GreenwaysMcpGateway {
  constructor({
    connectionStore,
    requestStore,
    handlers,
    authorize,
    now = () => new Date(),
    randomUUID = () => globalThis.crypto.randomUUID(),
    claimLifetimeMs = DEFAULT_REQUEST_CLAIM_LIFETIME_MS,
  }) {
    if (!connectionStore || typeof connectionStore.get !== "function") {
      throw new TypeError("MCP gateway requires a connection store");
    }
    if (!requestStore
        || typeof requestStore.claim !== "function"
        || typeof requestStore.wait !== "function"
        || typeof requestStore.complete !== "function"
        || typeof requestStore.release !== "function") {
      throw new TypeError("MCP gateway requires an atomic request store");
    }
    if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) {
      throw new TypeError("MCP gateway requires a closed read-handler map");
    }
    for (const [name, handler] of Object.entries(handlers)) {
      if (!toolDescriptor(name) || typeof handler !== "function") {
        throw new TypeError(`MCP gateway handler is invalid: ${name}`);
      }
    }
    if (typeof authorize !== "function") throw new TypeError("MCP gateway requires an independent authority gate");
    if (typeof now !== "function") throw new TypeError("MCP gateway requires a clock");
    if (typeof randomUUID !== "function") throw new TypeError("MCP gateway requires secure claim randomness");
    this.connectionStore = connectionStore;
    this.requestStore = requestStore;
    this.handlers = Object.freeze({ ...handlers });
    this.authorize = authorize;
    this.now = now;
    this.randomUUID = randomUUID;
    this.claimLifetimeMs = requestClaimLifetime(claimLifetimeMs);
    this.inflight = new Map();
  }

  async execute(value, transport = {}) {
    const transportClientId = transport?.clientId === undefined
      ? null
      : publicString(transport.clientId, "MCP transport client id", 200);
    let request;
    try {
      request = normalizeRequest(value, { now: this.now });
    } catch (cause) {
      fail(400, cause.code ?? "invalid-request", cause.message, { cause });
    }
    let digest;
    try {
      digest = await sha256(canonical({ request, transportClientId }));
    } catch (cause) {
      fail(500, cause?.code ?? "runtime-unavailable", "MCP request digesting failed", { cause });
    }

    const running = this.inflight.get(request.requestId);
    if (running) {
      if (running.digest !== digest) fail(409, "request-id-collision", "MCP request ID was reused with different content");
      return running.promise;
    }

    const promise = this.executeCoordinated(request, digest, transportClientId);
    this.inflight.set(request.requestId, { digest, promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(request.requestId);
    }
  }

  async executeCoordinated(request, digest, transportClientId) {
    const requestExpiresAt = Date.parse(request.expiresAt);
    for (let attempt = 0; attempt < MAX_REQUEST_CLAIM_ATTEMPTS; attempt += 1) {
      const claimedAt = this.now();
      if (!(claimedAt instanceof Date) || !Number.isFinite(claimedAt.getTime())) {
        fail(500, "runtime-unavailable", "MCP request claim clock is unavailable");
      }
      if (requestExpiresAt <= claimedAt.getTime()) {
        fail(400, "expired-request", "MCP request expired before it could be claimed");
      }
      const claim = Object.freeze({
        protocol: MCP_REQUEST_CLAIM_PROTOCOL,
        requestId: request.requestId,
        digest,
        claimId: secureRequestClaimId(this.randomUUID),
        claimedAt: claimedAt.toISOString(),
        expiresAt: new Date(Math.min(
          claimedAt.getTime() + this.claimLifetimeMs,
          requestExpiresAt,
        )).toISOString(),
      });

      let rawDecision;
      try {
        rawDecision = await this.requestStore.claim(claim);
      } catch (cause) {
        requestStoreFailure(cause, "MCP request claim storage is unavailable");
      }
      const decision = normalizeRequestStoreDecision(
        rawDecision,
        request,
        digest,
        claim.claimId,
      );
      if (decision.disposition === "completed") {
        return this.replay(decision.record, digest, request);
      }
      if (decision.disposition === "pending") {
        const waitStarted = this.now();
        if (!(waitStarted instanceof Date) || !Number.isFinite(waitStarted.getTime())) {
          fail(500, "runtime-unavailable", "MCP request wait clock is unavailable");
        }
        const timeoutMs = Math.max(0, Math.min(
          Date.parse(decision.record.expiresAt),
          requestExpiresAt,
        ) - waitStarted.getTime());
        if (timeoutMs === 0) continue;
        let stored;
        try {
          stored = await this.requestStore.wait({
            requestId: request.requestId,
            digest,
            claimId: decision.record.claimId,
            timeoutMs,
          });
        } catch (cause) {
          requestStoreFailure(cause, "MCP request wait storage is unavailable");
        }
        if (stored !== null) return this.replay(stored, digest, request);
        continue;
      }

      let result;
      try {
        result = await this.executeFresh(request, transportClientId);
      } catch (error) {
        await this.requestStore.release({
          requestId: request.requestId,
          digest,
          claimId: claim.claimId,
        }).catch(() => {});
        throw error;
      }

      let stored;
      try {
        stored = await this.requestStore.complete({
          requestId: request.requestId,
          digest,
          claimId: claim.claimId,
          result,
        });
      } catch (cause) {
        requestStoreFailure(cause, "MCP request result could not be stored");
      }
      return this.replay(stored, digest, request);
    }
    fail(
      409,
      "request-in-progress",
      "An identical MCP request is still being processed; retry it with the same request ID.",
    );
  }

  replay(record, digest, request) {
    try {
      const input = closedKeys(record, new Set(["protocol", "requestId", "digest", "result"]), "Stored MCP request");
      if (input.protocol !== MCP_REQUEST_RECORD_PROTOCOL || input.requestId !== request.requestId) {
        fail(500, "gateway-recovery", "Stored MCP request record is invalid");
      }
      const storedDigest = validateDigest(input.digest, "Stored MCP request digest");
      if (storedDigest !== digest) fail(409, "request-id-collision", "MCP request ID was reused with different content");
      return normalizeStoredResult(input.result, request);
    } catch (cause) {
      if (cause instanceof McpGatewayError
          && new Set(["request-id-collision", "gateway-recovery"]).has(cause.code)) {
        throw cause;
      }
      fail(500, "gateway-recovery", "Stored MCP request result is invalid", { cause });
    }
  }

  async executeFresh(request, transportClientId) {'''
replace_range(
    "services/mcp-gateway/src/gateway.js",
    "export class GreenwaysMcpGateway {",
    "  async executeFresh(request, digest, transportClientId) {",
    class_prefix,
)
replace_once(
    "services/mcp-gateway/src/gateway.js",
    '''      const result = unavailableResult(request, current);
      await this.storeResult(request.requestId, digest, result);
      return result;
''',
    '''      return unavailableResult(request, current);
''',
)
replace_once(
    "services/mcp-gateway/src/gateway.js",
    '''    await this.storeResult(request.requestId, digest, result);
    return result;
''',
    '''    return result;
''',
)

replace_once(
    "services/mcp-gateway/test/gateway.test.js",
    'import { MemoryRecordStore } from "../src/memory-store.js";\n',
    'import { MemoryRecordStore } from "../src/memory-store.js";\nimport { MemoryMcpRequestStore } from "../src/request-store.js";\n',
)
replace_once(
    "services/mcp-gateway/test/gateway.test.js",
    '''function rig({ connectionValue = connection(), handlers = {}, authorize } = {}) {
  const connectionStore = new MemoryRecordStore([connectionValue]);
  const requestStore = new MemoryRecordStore();
''',
    '''function rig({
  connectionValue = connection(),
  connectionStore = new MemoryRecordStore([connectionValue]),
  requestStore = new MemoryMcpRequestStore(),
  handlers = {},
  authorize,
} = {}) {
''',
)
replace_once(
    "services/mcp-gateway/test/gateway.test.js",
    '''test("represents an offline device-bound read without pretending it was queued", async () => {
''',
    '''test("coordinates duplicate delivery and collision fencing across independent gateway isolates", async () => {
  let calls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  let releaseHandler;
  const released = new Promise((resolve) => { releaseHandler = resolve; });
  const connectionStore = new MemoryRecordStore([connection()]);
  const requestStore = new MemoryMcpRequestStore();
  const handlers = {
    "apps.get": async ({ appId }) => {
      calls += 1;
      markStarted();
      await released;
      return {
        availability: "replicated",
        value: { id: appId, name: "Chats" },
        provenance: [],
      };
    },
  };
  const left = rig({ connectionStore, requestStore, handlers }).gateway;
  const right = rig({ connectionStore, requestStore, handlers }).gateway;
  const collision = rig({ connectionStore, requestStore, handlers }).gateway;
  const input = request("apps.get", { appId: "chats" });

  const first = left.execute(input);
  await started;
  await assert.rejects(
    collision.execute(request("apps.get", { appId: "userscripts" })),
    (error) => assertGatewayError(error, "request-id-collision"),
  );
  const second = right.execute(input);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  releaseHandler();
  const [leftResult, rightResult] = await Promise.all([first, second]);
  assert.deepEqual(leftResult, rightResult);
  assert.equal(calls, 1);
});

test("represents an offline device-bound read without pretending it was queued", async () => {
''',
)

replace_once(
    "services/mcp-gateway/test/gateway-recovery.test.js",
    'import { MemoryRecordStore } from "../src/memory-store.js";\n',
    'import { MemoryRecordStore } from "../src/memory-store.js";\nimport { MemoryMcpRequestStore } from "../src/request-store.js";\n',
)
replace_once(
    "services/mcp-gateway/test/gateway-recovery.test.js",
    '  const requestStore = new MemoryRecordStore();\n',
    '  const requestStore = new MemoryMcpRequestStore();\n',
)
replace_once(
    "services/mcp-gateway/test/gateway-recovery.test.js",
    '''  await rig.requestStore.put({
    ...record,
    result: {
      ...record.result,
      tool: "work.get",
      value: { apiKey: "must-not-replay" },
    },
  });
''',
    '''  rig.requestStore.records.set(input.requestId, structuredClone({
    ...record,
    result: {
      ...record.result,
      tool: "work.get",
      value: { apiKey: "must-not-replay" },
    },
  }));
''',
)

replace_once(
    "services/mcp-gateway/src/index.js",
    'export * from "./protocol.js";\n',
    'export * from "./protocol.js";\nexport * from "./request-store.js";\n',
)
replace_once(
    "services/mcp-gateway/package.json",
    '"test:core": "node --test test/gateway.test.js test/gateway-recovery.test.js test/mcp-transport.test.js",',
    '"test:core": "node --test test/gateway.test.js test/gateway-recovery.test.js test/mcp-transport.test.js test/request-store.test.js",',
)

replace_once(
    "services/mcp-gateway/README.md",
    '''The gateway does not expose `kernel/eval`, arbitrary kernel methods, arbitrary
HTTP, browser calls, private keys, provider credentials, cookies, OAuth bearer
tokens, or session secrets.
''',
    '''The gateway does not expose `kernel/eval`, arbitrary kernel methods, arbitrary
HTTP, browser calls, private keys, provider credentials, cookies, OAuth bearer
tokens, or session secrets.

## Atomic request coordination

The gateway now requires an atomic request-store contract rather than relying
on a process-local `get → execute → put` sequence. Each request ID receives one
short-lived `greenways-mcp-request-claim/1` owner. Other gateway isolates either
wait for the exact-digest result or reject changed content immediately.

The current claimant alone can complete the durable request record. Expired
claims can be replaced, while the former claim ID is fenced from publishing a
late result. Transient authority or handler failures release the claim so the
same request may be retried. The in-process promise map remains only a latency
optimization; repository claims own correctness across isolates.
''',
)
replace_once(
    "services/mcp-gateway/README.md",
    '''- `src/memory-store.js` — test-only in-memory request record store.
''',
    '''- `src/request-store.js` — atomic claim, wait, completion, release, and in-memory conformance store.
- `src/memory-store.js` — test-only generic connection record store.
''',
)
replace_once(
    "services/mcp-gateway/README.md",
    '''## Next browser slice

The next layer installs a reviewed adapter for the Greenways MCP authorization
origin. It reads only the inert challenge, asks the resident Greenways OS
kernel for explicit approval, signs the challenge without exporting the
controller key, places the assertion in the authorization form, and submits it
only after the user approves.
''',
    '''## Next durable slice

The next PR maps the atomic request and pairing repository contracts onto
Cloudflare SQLite Durable Objects, one coordination atom per request or pairing
session. The stateless MCP handler remains stateless. A later delivery adapter
then attaches verified Home Node or Beacon routes without letting remote OAuth
credentials substitute for local Greenways capability authority.
''',
)

replace_once(
    "protocol/mcp-gateway.md",
    '''- content-digested request-ID idempotency, concurrent duplicate suppression, and collision rejection;
''',
    '''- atomic exact-digest request claims, cross-isolate duplicate waiting, stale-claim fencing, and collision rejection;
''',
)
replace_once(
    "protocol/mcp-gateway.md",
    '''1. Read authority core and stateless Streamable HTTP tool projection — implemented.
2. Signed OAuth challenge/assertion and hardened authorization page — implemented.
3. Reviewed Greenways OS authorization-page adapter and controller signing flow.
4. Durable Cloudflare repository plus Home Node/Beacon delivery with idempotent request IDs.
5. Hestia proposal tools for write intent; no direct execution.
6. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
7. Optional publication after security, privacy, and tool-description review.
''',
    '''1. Read authority core and stateless Streamable HTTP tool projection — implemented.
2. Signed OAuth challenge/assertion and hardened authorization page — implemented.
3. Reviewed Greenways OS authorization-page adapter and controller signing flow — implemented.
4. Atomic request-claim seam and repository conformance — implemented.
5. Cloudflare SQLite Durable Object repositories plus Home Node/Beacon delivery.
6. Hestia proposal tools for write intent; no direct execution.
7. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
8. Optional publication after security, privacy, and tool-description review.
''',
)

print("Applied atomic MCP request claim seam")
