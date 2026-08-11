import {
  McpDeliveryError,
  normalizeMcpDeliveryId,
  normalizeMcpDeliveryLeaseId,
  normalizeMcpDeliveryRecord,
  normalizeMcpDeliveryRouteId,
} from "./mcp-delivery.js";
import { unwrapMcpDeliveryStoreRpc } from "./delivery-store-rpc.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
const MIN_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 1000;
const MAX_WAIT_MS = 2 * 60 * 1000;

function pollInterval(value) {
  if (!Number.isSafeInteger(value)
      || value < MIN_POLL_INTERVAL_MS
      || value > MAX_POLL_INTERVAL_MS) {
    throw new TypeError(
      `MCP delivery poll interval must be ${MIN_POLL_INTERVAL_MS}-${MAX_POLL_INTERVAL_MS}ms`,
    );
  }
  return value;
}

function waitTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_WAIT_MS) {
    throw new TypeError(`MCP delivery wait timeout must be 0-${MAX_WAIT_MS}ms`);
  }
  return value;
}

function currentTime(now) {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new McpDeliveryError(500, "delivery-recovery", "MCP delivery adapter clock is invalid");
  }
  return value.getTime();
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class CloudflareMcpDeliveryRepository {
  constructor(namespace, {
    now = () => new Date(),
    sleep = defaultSleep,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  } = {}) {
    if (!namespace || typeof namespace.getByName !== "function") {
      throw new TypeError("MCP delivery repository requires a Durable Object namespace");
    }
    if (typeof now !== "function") throw new TypeError("MCP delivery repository requires a clock");
    if (typeof sleep !== "function") throw new TypeError("MCP delivery repository requires a sleep function");
    this.namespace = namespace;
    this.now = now;
    this.sleep = sleep;
    this.pollIntervalMs = pollInterval(pollIntervalMs);
  }

  stub(routeId) {
    const stub = this.namespace.getByName(routeId);
    if (!stub || typeof stub !== "object") {
      throw new McpDeliveryError(500, "delivery-recovery", "MCP delivery Durable Object stub is unavailable");
    }
    return stub;
  }

  async invoke(routeIdValue, method, value) {
    const routeId = normalizeMcpDeliveryRouteId(routeIdValue);
    const stub = this.stub(routeId);
    if (typeof stub[method] !== "function") {
      throw new McpDeliveryError(
        500,
        "delivery-recovery",
        `MCP delivery Durable Object method is unavailable: ${method}`,
      );
    }
    let response;
    try {
      response = await stub[method](value);
    } catch (cause) {
      if (cause instanceof McpDeliveryError) throw cause;
      throw new McpDeliveryError(
        503,
        "delivery-store-unavailable",
        "MCP delivery storage is unavailable",
        { cause },
      );
    }
    return unwrapMcpDeliveryStoreRpc(response);
  }

  async enqueue(value) {
    const record = normalizeMcpDeliveryRecord(value);
    return normalizeMcpDeliveryRecord(await this.invoke(record.route.id, "enqueue", record));
  }

  async read(routeIdValue, deliveryIdValue) {
    const routeId = normalizeMcpDeliveryRouteId(routeIdValue);
    const deliveryId = normalizeMcpDeliveryId(deliveryIdValue);
    const value = await this.invoke(routeId, "read", { routeId, deliveryId });
    return value === null ? null : normalizeMcpDeliveryRecord(value);
  }

  async claimNext(routeIdValue, consumerIdValue, leaseIdValue) {
    const routeId = normalizeMcpDeliveryRouteId(routeIdValue);
    const consumerId = normalizeMcpDeliveryRouteId(consumerIdValue);
    const leaseId = normalizeMcpDeliveryLeaseId(leaseIdValue);
    const value = await this.invoke(routeId, "claim", { routeId, consumerId, leaseId });
    return value === null ? null : normalizeMcpDeliveryRecord(value);
  }

  async complete(value) {
    const routeId = normalizeMcpDeliveryRouteId(value?.routeId);
    return normalizeMcpDeliveryRecord(await this.invoke(routeId, "complete", value));
  }

  async release(value) {
    const routeId = normalizeMcpDeliveryRouteId(value?.routeId);
    return this.invoke(routeId, "release", value);
  }

  async wait(routeIdValue, deliveryIdValue, digest, timeoutMsValue) {
    const routeId = normalizeMcpDeliveryRouteId(routeIdValue);
    const deliveryId = normalizeMcpDeliveryId(deliveryIdValue);
    const timeoutMs = waitTimeout(timeoutMsValue);
    const deadline = currentTime(this.now) + timeoutMs;
    while (true) {
      const record = await this.read(routeId, deliveryId);
      if (record === null) return null;
      if (record.digest !== digest) {
        throw new McpDeliveryError(
          409,
          "delivery-id-collision",
          "MCP delivery ID was reused with different content",
        );
      }
      if (record.state === "completed") return record;
      const remaining = deadline - currentTime(this.now);
      if (remaining <= 0) return null;
      await this.sleep(Math.min(this.pollIntervalMs, remaining));
    }
  }
}
