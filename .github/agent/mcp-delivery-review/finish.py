from pathlib import Path


def replace_once(path, old, new):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one anchor in {path}, found {count}: {old[:180]!r}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "services/mcp-gateway/src/mcp-delivery.js",
    'const AVAILABILITY = new Set(["replicated", "device", "hybrid"]);\n',
    'const AVAILABILITY = new Set(["device", "hybrid"]);\n',
)
replace_once(
    "services/mcp-gateway/src/mcp-delivery.js",
    '''export function normalizeMcpDeliveryLease(value) {
''',
    '''function assertRouteProvenance(result, routeId, status = 500) {
  if (!result.provenance.some((entry) => entry.kind === "device" && entry.ref === routeId)) {
    fail(
      status,
      status >= 500 ? "delivery-recovery" : "delivery-result-unattributed",
      "MCP delivery result is not attributed to its exact route",
    );
  }
}

export function normalizeMcpDeliveryLease(value) {
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-delivery.js",
    '''  const completedAt = optionalTime(input.completedAt, "MCP delivery completedAt");
  if ((input.state === "queued" && (lease || result || completedAt))
''',
    '''  const completedAt = optionalTime(input.completedAt, "MCP delivery completedAt");
  if (result) assertRouteProvenance(result, route.id);
  if ((input.state === "queued" && (lease || result || completedAt))
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-delivery.js",
    '''  const routeId = normalizeMcpDeliveryRouteId(input.routeId);
  if (current.route.id !== routeId) {
    fail(500, "delivery-recovery", "MCP delivery route identity changed");
  }
''',
    '''  const routeId = normalizeMcpDeliveryRouteId(input.routeId);
  const consumerId = normalizeMcpDeliveryRouteId(input.consumerId);
  if (current.route.id !== routeId) {
    fail(500, "delivery-recovery", "MCP delivery route identity changed");
  }
  if (consumerId !== routeId) {
    fail(403, "delivery-consumer-mismatch", "MCP delivery consumer does not own this route");
  }
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-delivery.js",
    '''  const lease = normalizeMcpDeliveryLease({
    protocol: MCP_DELIVERY_LEASE_PROTOCOL,
    id: normalizeMcpDeliveryLeaseId(input.leaseId),
    consumerId: normalizeMcpDeliveryRouteId(input.consumerId),
    claimedAt: observed.toISOString(),
''',
    '''  const lease = normalizeMcpDeliveryLease({
    protocol: MCP_DELIVERY_LEASE_PROTOCOL,
    id: normalizeMcpDeliveryLeaseId(input.leaseId),
    consumerId,
    claimedAt: observed.toISOString(),
''',
)
replace_once(
    "services/mcp-gateway/src/mcp-delivery.js",
    '''  const next = normalizeMcpDeliveryRecord({
    ...current,
    state: "completed",
    result: normalizeMcpDeliveryResult(input.result),
    completedAt: observed.toISOString(),
  });
''',
    '''  const result = normalizeMcpDeliveryResult(input.result);
  assertRouteProvenance(result, current.route.id, 400);
  const next = normalizeMcpDeliveryRecord({
    ...current,
    state: "completed",
    result,
    completedAt: observed.toISOString(),
  });
''',
)

replace_once(
    "services/mcp-gateway/src/cloudflare-delivery-store.js",
    '''} from "./mcp-delivery.js";
import { unwrapMcpDeliveryStoreRpc } from "./delivery-store-rpc.js";
''',
    '''} from "./mcp-delivery.js";
import { validateDigest } from "./protocol.js";
import { unwrapMcpDeliveryStoreRpc } from "./delivery-store-rpc.js";
''',
)
replace_once(
    "services/mcp-gateway/src/cloudflare-delivery-store.js",
    '''    const deliveryId = normalizeMcpDeliveryId(deliveryIdValue);
    const timeoutMs = waitTimeout(timeoutMsValue);
''',
    '''    const deliveryId = normalizeMcpDeliveryId(deliveryIdValue);
    const expectedDigest = validateDigest(digest, "MCP delivery wait digest");
    const timeoutMs = waitTimeout(timeoutMsValue);
''',
)
replace_once(
    "services/mcp-gateway/src/cloudflare-delivery-store.js",
    '''      if (record.digest !== digest) {
''',
    '''      if (record.digest !== expectedDigest) {
''',
)

replace_once(
    "services/mcp-gateway/test/mcp-delivery.test.js",
    '''test("leases one pending read, fences duplicate consumers, and stores an attributable result", async () => {
''',
    '''test("binds a delivery lease to the exact route consumer", async () => {
  const repository = new MemoryMcpDeliveryRepository({ now: () => new Date(NOW) });
  await repository.enqueue(queued());
  await assert.rejects(
    repository.claimNext(ROUTE_ID, "beacon/other", LEASE_ONE),
    (error) => hasCode(error, "delivery-consumer-mismatch") && error.status === 403,
  );
  assert.equal((await repository.read(ROUTE_ID, mcpDeliveryIdForRequest(REQUEST_ID))).state, "queued");
});

test("leases one pending read, fences duplicate consumers, and stores an attributable result", async () => {
''',
)
replace_once(
    "services/mcp-gateway/test/mcp-delivery.test.js",
    '''test("replaces an expired delivery lease and fences the former consumer", async () => {
''',
    '''test("rejects completion without provenance for the exact route", async () => {
  const repository = new MemoryMcpDeliveryRepository({ now: () => new Date(NOW) });
  const inserted = await repository.enqueue(queued());
  await repository.claimNext(ROUTE_ID, ROUTE_ID, LEASE_ONE);
  await assert.rejects(
    repository.complete({
      routeId: ROUTE_ID,
      deliveryId: inserted.id,
      digest: inserted.digest,
      leaseId: LEASE_ONE,
      result: {
        availability: "device",
        value: { matches: [] },
        provenance: [{
          kind: "device",
          ref: "home-node/other",
          digest: null,
          observedAt: NOW.toISOString(),
        }],
      },
    }),
    (error) => hasCode(error, "delivery-result-unattributed") && error.status === 400,
  );
  assert.equal((await repository.read(ROUTE_ID, inserted.id)).state, "leased");
});

test("replaces an expired delivery lease and fences the former consumer", async () => {
''',
)

replace_once(
    "services/mcp-gateway/test/cloudflare-delivery-store.test.js",
    '''test("contains raw route atom failures behind an opaque retryable error", async () => {
''',
    '''test("validates the expected digest before polling a route atom", async () => {
  const repository = new CloudflareMcpDeliveryRepository({
    getByName: () => ({
      read: async () => {
        throw new Error("the route atom must not be called");
      },
    }),
  });
  await assert.rejects(
    repository.wait(ROUTE_ID, mcpDeliveryIdForRequest(REQUEST_ID), "not-a-digest", 100),
    /digest/i,
  );
});

test("contains raw route atom failures behind an opaque retryable error", async () => {
''',
)

print("Applied MCP delivery mailbox security refinements")
