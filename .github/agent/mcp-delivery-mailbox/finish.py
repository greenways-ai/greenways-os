from pathlib import Path
import json


def replace_once(path, old, new):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected one anchor in {path}, found {count}: {old[:180]!r}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "services/mcp-gateway/src/sqlite-delivery-store.js",
    '''  currentDate() {
    return repositoryDate(this.now);
  }
''',
    '''  currentDate() {
    return repositoryDate(this.now());
  }
''',
)

replace_once(
    "services/mcp-gateway/src/cloudflare-worker.js",
    'import { DurableObject } from "cloudflare:workers";\n',
    'import { DurableObject } from "cloudflare:workers";\n'
    'import { executeMcpDeliveryStoreRpc } from "./delivery-store-rpc.js";\n'
    'import { SqliteMcpDeliveryRepository } from "./sqlite-delivery-store.js";\n',
)
replace_once(
    "services/mcp-gateway/src/cloudflare-worker.js",
    '''export default {
''',
    '''export class McpDeliveryDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.repository = null;
    ctx.blockConcurrencyWhile(async () => {
      this.repository = new SqliteMcpDeliveryRepository(ctx.storage.sql);
    });
  }

  store() {
    if (!this.repository) throw new Error("MCP delivery repository is not initialized");
    return this.repository;
  }

  enqueue(value) {
    return executeMcpDeliveryStoreRpc(() => this.store().enqueue(value));
  }

  read(value) {
    return executeMcpDeliveryStoreRpc(() => this.store().read(value.routeId, value.deliveryId));
  }

  claim(value) {
    return executeMcpDeliveryStoreRpc(() => this.store().claimNext(
      value.routeId,
      value.consumerId,
      value.leaseId,
    ));
  }

  complete(value) {
    return executeMcpDeliveryStoreRpc(() => this.store().complete(value));
  }

  release(value) {
    return executeMcpDeliveryStoreRpc(() => this.store().release(value));
  }
}

export default {
''',
)

replace_once(
    "services/mcp-gateway/wrangler.jsonc",
    '''      {
        "name": "MCP_PAIRINGS",
        "class_name": "McpPairingDurableObject"
      }
''',
    '''      {
        "name": "MCP_PAIRINGS",
        "class_name": "McpPairingDurableObject"
      },
      {
        "name": "MCP_DELIVERIES",
        "class_name": "McpDeliveryDurableObject"
      }
''',
)
replace_once(
    "services/mcp-gateway/wrangler.jsonc",
    '''    {
      "tag": "v2",
      "new_sqlite_classes": ["McpPairingDurableObject"]
    }
''',
    '''    {
      "tag": "v2",
      "new_sqlite_classes": ["McpPairingDurableObject"]
    },
    {
      "tag": "v3",
      "new_sqlite_classes": ["McpDeliveryDurableObject"]
    }
''',
)

index_path = Path("services/mcp-gateway/src/index.js")
index_text = index_path.read_text()
if 'export * from "./cloudflare-delivery-store.js";' not in index_text:
    index_text = 'export * from "./cloudflare-delivery-store.js";\n' + index_text
index_text = index_text.replace(
    'export * from "./gateway.js";\n',
    'export * from "./delivery-store-rpc.js";\nexport * from "./gateway.js";\n',
    1,
)
index_text = index_text.replace(
    'export * from "./mcp-handler.js";\n',
    'export * from "./mcp-delivery.js";\nexport * from "./mcp-handler.js";\n',
    1,
)
index_text = index_text.replace(
    'export * from "./sqlite-pairing-store.js";\n',
    'export * from "./sqlite-delivery-store.js";\nexport * from "./sqlite-pairing-store.js";\n',
    1,
)
index_path.write_text(index_text)

package_path = Path("services/mcp-gateway/package.json")
package_value = json.loads(package_path.read_text())
package_value["scripts"]["test:core"] = (
    "node --test "
    "test/gateway.test.js test/gateway-recovery.test.js test/mcp-transport.test.js "
    "test/request-store.test.js test/sqlite-request-store.test.js test/cloudflare-request-store.test.js "
    "test/mcp-pairing.test.js test/sqlite-pairing-store.test.js test/cloudflare-pairing-store.test.js "
    "test/mcp-delivery.test.js test/sqlite-delivery-store.test.js test/cloudflare-delivery-store.test.js"
)
package_path.write_text(json.dumps(package_value, indent=2) + "\n")

replace_once(
    "services/mcp-gateway/README.md",
    '''## Next delivery slice

Request and signed-pairing repositories now survive isolate replacement. The
next PR attaches a verified Home Node or Beacon route behind the existing
connection and Greenways capability checks. Remote OAuth credentials still
cannot substitute for resident Greenways authority.
''',
    '''## Durable Home Node / Beacon route mailbox

The first delivery atom is now implemented for device-bound reads. Each exact
`chats.search` request can be projected into a closed
`greenways-mcp-delivery/1` record and placed into one SQLite Durable Object per
Home Node or Beacon route.

The mailbox is deliberately not a general job queue. Records bind the exact MCP
request, paired identity and client, route, authority evidence, digest, expiry,
and one claim lease. A route consumer can claim only unexpired work. Lease
replacement is repository-clock-owned, stale consumers cannot complete or
release replacement ownership, and completed results are bounded public values
with attributable provenance.

Offline device reads are still not queued by the gateway: its existing route
status check returns `device-offline` before a delivery handler runs. The
mailbox exists only for a route already represented as online.

The Worker still exposes no delivery HTTP route. The next PR adds an
authenticated pull/complete transport for a Home Node or Beacon and then binds
`chats.search` to this mailbox without adding arbitrary HTTP or kernel RPC.
''',
)
replace_once(
    "services/mcp-gateway/README.md",
    '''- `src/sqlite-pairing-store.js` — one-session SQLite Durable Object repository and consumed-only connection view.
- `src/pairing-store-rpc.js` — closed non-leaking pairing repository RPC envelopes.
- `src/cloudflare-pairing-store.js` — challenge/connection routing through one pairing atom.
''',
    '''- `src/sqlite-pairing-store.js` — one-session SQLite Durable Object repository and consumed-only connection view.
- `src/pairing-store-rpc.js` — closed non-leaking pairing repository RPC envelopes.
- `src/cloudflare-pairing-store.js` — challenge/connection routing through one pairing atom.
- `src/mcp-delivery.js` — closed device-read record, lease, result, and memory conformance repository.
- `src/sqlite-delivery-store.js` — multi-record SQLite mailbox for one Home Node or Beacon route.
- `src/delivery-store-rpc.js` — closed non-leaking route mailbox RPC envelopes.
- `src/cloudflare-delivery-store.js` — exact route-atom routing and bounded result polling.
''',
)

replace_once(
    "protocol/mcp-gateway.md",
    '''- one lease-fenced SQLite pairing atom per challenge, with provisional connections hidden until consumption;
- validation of stored results before replay;
''',
    '''- one lease-fenced SQLite pairing atom per challenge, with provisional connections hidden until consumption;
- one closed SQLite mailbox per online Home Node or Beacon route for expiring device-bound reads;
- validation of stored results before replay;
''',
)
replace_once(
    "protocol/mcp-gateway.md",
    '''6. Durable lease-fenced pairing repository — implemented.
7. Verified Home Node/Beacon delivery.
8. Hestia proposal tools for write intent; no direct execution.
9. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
10. Optional publication after security, privacy, and tool-description review.
''',
    '''6. Durable lease-fenced pairing repository — implemented.
7. Durable closed Home Node/Beacon route mailbox — implemented.
8. Authenticated Home Node/Beacon pull transport and gateway handler binding.
9. Hestia proposal tools for write intent; no direct execution.
10. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
11. Optional publication after security, privacy, and tool-description review.
''',
)

print("Finished durable MCP delivery mailbox integration")
