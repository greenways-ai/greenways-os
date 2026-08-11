# Greenways MCP gateway

This service exposes capability-scoped Greenways reads through a remote MCP
boundary without turning the resident Hara kernel into general RPC.

```text
ChatGPT / MCP client
       │ OAuth 2.1 access token
       ▼
stateless Streamable HTTP /mcp
       │ greenways-mcp-auth-context/1
       ▼
GreenwaysMcpGateway
  - exact connection + OAuth client binding
  - closed nine-tool catalogue
  - request expiry, idempotency, and collision rejection
  - independent Greenways capability decision
  - replicated vs device-bound availability
  - bounded result and provenance validation
       │
       ▼
explicit semantic handlers / Beacon route
```

The transport uses the current Cloudflare stateless server path:

- `@modelcontextprotocol/server` 2.0.0;
- `@modelcontextprotocol/sdk` 1.30.0;
- `agents` 0.20.1 and `agents/mcp/server`;
- MCP protocol `2026-07-28` over Streamable HTTP;
- the exact `/mcp` route with legacy MCP transport rejected.

## Authority split

OAuth authenticates the remote MCP client and projects only:

```json
{
  "protocol": "greenways-mcp-auth-context/1",
  "connectionId": "mcp/connection/..."
}
```

The verified OAuth `clientId` and `greenways.read` scope are bound into every
request digest and checked against the durable Greenways connection. They do
not replace the independent Greenways `authorize()` decision.

The gateway does not expose `kernel/eval`, arbitrary kernel methods, arbitrary
HTTP, browser calls, private keys, provider credentials, cookies, OAuth bearer
tokens, or session secrets.

## Read tools

- `greenways.status`
- `apps.list`
- `apps.get`
- `work.list`
- `work.get`
- `resources.search`
- `resources.read`
- `receipts.get`
- `chats.search`

All are advertised as read-only, non-destructive, idempotent, and closed-world.
`chats.search` remains device-bound and reports `device-offline` rather than
pretending a local read was queued.

## Modules

- `src/protocol.js` — closed semantic connection, request, and result records.
- `src/gateway.js` — authority, availability, replay, and recovery core.
- `src/mcp-transport.js` — OAuth/MCP identity projection and stable tool errors.
- `src/mcp-server.js` — the nine registered MCP tools and exact Zod schemas.
- `src/mcp-handler.js` — stateless Streamable HTTP handler factory.
- `src/memory-store.js` — test-only in-memory record store.

## Test

```sh
npm ci
npm test
```

The suite exercises the authority core, replay/recovery boundaries, OAuth
client binding, tool schemas, stateless tool calls, safe errors, route policy,
and rejection of the legacy MCP lane.

## Next pairing slice

The next layer wraps `createGreenwaysMcpHandler()` with Cloudflare's OAuth
provider and a Greenways-controlled authorization screen. Authorization will
consume a short-lived Beacon/Home Node pairing assertion and issue the minimal
auth context above; it will not use the static demo-user flow from example
servers and will never receive a controller private key.
