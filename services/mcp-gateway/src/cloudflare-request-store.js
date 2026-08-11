import {
  McpRequestStoreError,
  normalizeMcpRequestClaim,
  normalizeMcpRequestCompletion,
  normalizeMcpRequestId,
  normalizeMcpRequestRelease,
  normalizeMcpRequestWait,
  normalizeMcpStoredRequestState,
} from "./request-store.js";
import { MCP_REQUEST_CLAIM_PROTOCOL, MCP_REQUEST_RECORD_PROTOCOL } from "./protocol.js";
import { unwrapMcpRequestStoreRpc } from "./request-store-rpc.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
const MIN_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 1000;

function pollInterval(value) {
  if (!Number.isSafeInteger(value)
      || value < MIN_POLL_INTERVAL_MS
      || value > MAX_POLL_INTERVAL_MS) {
    throw new TypeError(
      `MCP Cloudflare request-store poll interval must be ${MIN_POLL_INTERVAL_MS}-${MAX_POLL_INTERVAL_MS}ms`,
    );
  }
  return value;
}

function currentTime(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new McpRequestStoreError("request-store-invalid", "MCP Cloudflare request-store clock is invalid");
  }
  return value.getTime();
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inspectWaitState(stateValue, input) {
  if (stateValue === null) return { done: true, value: null };
  const state = normalizeMcpStoredRequestState(stateValue);
  if (state.requestId !== input.requestId) {
    throw new McpRequestStoreError("request-store-recovery", "MCP Durable Object request identity changed");
  }
  if (state.digest !== input.digest) {
    throw new McpRequestStoreError(
      "request-id-collision",
      "MCP request ID was reused with different content",
    );
  }
  if (state.protocol === MCP_REQUEST_RECORD_PROTOCOL) {
    return { done: true, value: state };
  }
  if (state.protocol !== MCP_REQUEST_CLAIM_PROTOCOL || state.claimId !== input.claimId) {
    return { done: true, value: null };
  }
  return { done: false, value: null };
}

export class CloudflareMcpRequestStore {
  constructor(namespace, {
    now = () => new Date(),
    sleep = defaultSleep,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = {}) {
    if (!namespace || typeof namespace.getByName !== "function") {
      throw new TypeError("MCP Cloudflare request store requires a Durable Object namespace");
    }
    if (typeof now !== "function") throw new TypeError("MCP Cloudflare request store requires a clock");
    if (typeof sleep !== "function") throw new TypeError("MCP Cloudflare request store requires a sleep function");
    this.namespace = namespace;
    this.now = now;
    this.sleep = sleep;
    this.pollIntervalMs = pollInterval(pollIntervalMs);
  }

  stub(id) {
    const stub = this.namespace.getByName(id);
    if (!stub || typeof stub !== "object") {
      throw new McpRequestStoreError("request-store-recovery", "MCP Durable Object stub is unavailable");
    }
    return stub;
  }

  async invoke(id, method, value) {
    const stub = this.stub(id);
    if (typeof stub[method] !== "function") {
      throw new McpRequestStoreError(
        "request-store-recovery",
        `MCP Durable Object method is unavailable: ${method}`,
      );
    }
    const response = await stub[method](value);
    return unwrapMcpRequestStoreRpc(response);
  }

  async get(idValue) {
    const id = normalizeMcpRequestId(idValue);
    const state = await this.invoke(id, "read", id);
    if (state === null) return null;
    const normalized = normalizeMcpStoredRequestState(state);
    if (normalized.requestId !== id) {
      throw new McpRequestStoreError("request-store-recovery", "MCP Durable Object request identity changed");
    }
    return normalized;
  }

  async claim(value) {
    const claim = normalizeMcpRequestClaim(value);
    return this.invoke(claim.requestId, "claim", claim);
  }

  async wait(value) {
    const input = normalizeMcpRequestWait(value);
    const deadline = currentTime(this.now) + input.timeoutMs;
    while (true) {
      const inspected = inspectWaitState(await this.get(input.requestId), input);
      if (inspected.done) return inspected.value;
      const remaining = deadline - currentTime(this.now);
      if (remaining <= 0) return null;
      await this.sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }

  async complete(value) {
    const completion = normalizeMcpRequestCompletion(value);
    return this.invoke(completion.requestId, "complete", completion);
  }

  async release(value) {
    const release = normalizeMcpRequestRelease(value);
    return this.invoke(release.requestId, "release", release);
  }
}
