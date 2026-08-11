import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, oldValue, newValue) {
  const text = readFileSync(path, "utf8");
  const first = text.indexOf(oldValue);
  if (first < 0) throw new Error(`Missing exact integration anchor in ${path}: ${JSON.stringify(oldValue.slice(0, 160))}`);
  if (text.indexOf(oldValue, first + oldValue.length) >= 0) {
    throw new Error(`Integration anchor is not unique in ${path}: ${JSON.stringify(oldValue.slice(0, 160))}`);
  }
  writeFileSync(path, `${text.slice(0, first)}${newValue}${text.slice(first + oldValue.length)}`);
}

replaceOnce(
  "services/mcp-gateway/src/gateway.js",
  `  if (cause?.code === "request-claim-stale") {
    fail(409, "request-claim-lost", "MCP request ownership changed before its result was stored", { cause });
  }
  fail(503, "gateway-storage-unavailable", message, { cause });
`,
  `  if (cause?.code === "request-claim-stale") {
    fail(409, "request-claim-lost", "MCP request ownership changed before its result was stored", { cause });
  }
  if (cause?.code === "request-store-invalid" || cause?.code === "request-store-recovery") {
    fail(500, "gateway-recovery", "MCP request storage returned invalid state", { cause });
  }
  fail(503, "gateway-storage-unavailable", message, { cause });
`,
);

const packagePath = "services/mcp-gateway/package.json";
const packageValue = JSON.parse(readFileSync(packagePath, "utf8"));
packageValue.scripts["test:core"] = [
  "node --test",
  "test/gateway.test.js",
  "test/gateway-recovery.test.js",
  "test/mcp-transport.test.js",
  "test/request-store.test.js",
  "test/sqlite-request-store.test.js",
  "test/cloudflare-request-store.test.js",
].join(" ");
packageValue.scripts["check:worker"] = "wrangler deploy --dry-run --outdir .wrangler-dist";
packageValue.scripts.check = "node --check src/*.js && node --test && npm run check:worker";
writeFileSync(packagePath, `${JSON.stringify(packageValue, null, 2)}\n`);

const ignorePath = ".gitignore";
const ignored = readFileSync(ignorePath, "utf8");
if (!ignored.includes(".wrangler/")) {
  writeFileSync(ignorePath, `${ignored.trimEnd()}\n.wrangler/\n.wrangler-dist/\n`);
}

replaceOnce(
  "services/mcp-gateway/README.md",
  `The current claimant alone can complete the durable request record. Expired
claims can be replaced, while the former claim ID is fenced from publishing a
late result. Transient authority or handler failures release the claim so the
same request may be retried. The in-process promise map remains only a latency
optimization; repository claims own correctness across isolates.
`,
  `The current claimant alone can complete the durable request record. Expired
claims can be replaced, while the former claim ID is fenced from publishing a
late result. Transient authority or handler failures release the claim so the
same request may be retried. The in-process promise map remains only a latency
optimization; repository claims own correctness across isolates.

## Cloudflare SQLite request repository

\`CloudflareMcpRequestStore\` maps each normalized request ID to exactly one
\`McpRequestDurableObject\` through \`MCP_REQUESTS.getByName(requestId)\`. The
stateless MCP handler keeps no durable ownership state. Duplicate callers poll
the same atom for a completed record instead of holding a long-lived Durable
Object RPC event open.

Each SQLite Durable Object stores one closed claim or result row. Claim,
completion, replacement, collision, and release transitions execute without an
\`await\` between the SQLite read and write. The repository's own clock decides
whether a claim has expired, and the previous claim ID remains fenced after
replacement or restart.

Known request-store failures cross the RPC boundary in a closed versioned
envelope and are reconstructed locally. Unexpected runtime and storage errors
remain opaque. Corrupt protocol fields or result JSON become \`gateway-recovery\`
rather than being returned to an MCP client.
`,
);

replaceOnce(
  "services/mcp-gateway/README.md",
  `- \`src/request-store.js\` — atomic claim, wait, completion, release, and in-memory conformance store.
- \`src/memory-store.js\` — test-only generic connection record store.
`,
  `- \`src/request-store.js\` — shared request validation, state transitions, and in-memory conformance store.
- \`src/sqlite-request-store.js\` — one-row SQLite Durable Object repository.
- \`src/request-store-rpc.js\` — closed non-leaking Durable Object RPC envelopes.
- \`src/cloudflare-request-store.js\` — request-ID routing and bounded duplicate polling.
- \`src/cloudflare-worker.js\` — SQLite Durable Object class; its public fetch boundary remains closed.
- \`src/memory-store.js\` — test-only generic connection record store.
`,
);

replaceOnce(
  "services/mcp-gateway/README.md",
  `\`\`\`sh
npm ci
npm test
\`\`\`

The suite exercises the authority core, replay/recovery boundaries, OAuth
client binding, tool schemas, stateless tool calls, safe errors, route policy,
signed identity pairing, OAuth retry behavior, authorization-page hardening,
and rejection of the legacy MCP lane.

## Next durable slice

The next PR maps the atomic request and pairing repository contracts onto
Cloudflare SQLite Durable Objects, one coordination atom per request or pairing
session. The stateless MCP handler remains stateless. A later delivery adapter
then attaches verified Home Node or Beacon routes without letting remote OAuth
credentials substitute for local Greenways capability authority.
`,
  `\`\`\`sh
npm ci
npm run check
\`\`\`

The suite exercises the authority core, replay/recovery boundaries, OAuth
client binding, tool schemas, stateless tool calls, safe errors, route policy,
signed identity pairing, OAuth retry behavior, authorization-page hardening,
real SQLite persistence through Node's SQLite engine, Durable Object routing,
and rejection of the legacy MCP lane. The check also performs a Wrangler
dry-run build against \`wrangler.jsonc\`.

## Next durable slice

The next PR gives signed pairing sessions the same durable storage treatment.
After both repositories survive isolate replacement, a separate delivery
adapter can attach verified Home Node or Beacon routes without letting remote
OAuth credentials substitute for local Greenways capability authority.
`,
);

replaceOnce(
  "protocol/mcp-gateway.md",
  `- atomic exact-digest request claims, cross-isolate duplicate waiting, stale-claim fencing, and collision rejection;
- validation of stored results before replay;
`,
  `- atomic exact-digest request claims, cross-isolate duplicate waiting, stale-claim fencing, and collision rejection;
- one SQLite Durable Object coordination atom per request ID, with closed RPC errors and restart-safe replay;
- validation of stored results before replay;
`,
);

replaceOnce(
  "protocol/mcp-gateway.md",
  `4. Atomic request-claim seam and repository conformance — implemented.
5. Cloudflare SQLite Durable Object repositories plus Home Node/Beacon delivery.
6. Hestia proposal tools for write intent; no direct execution.
7. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
8. Optional publication after security, privacy, and tool-description review.
`,
  `4. Atomic request-claim seam and repository conformance — implemented.
5. Cloudflare SQLite Durable Object request repository — implemented.
6. Durable pairing repository plus Home Node/Beacon delivery.
7. Hestia proposal tools for write intent; no direct execution.
8. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
9. Optional publication after security, privacy, and tool-description review.
`,
);

console.log("Finished Cloudflare MCP request-store integration");
