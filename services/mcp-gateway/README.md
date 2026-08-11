# Greenways MCP gateway

This service exposes capability-scoped Greenways reads through a remote MCP
boundary without turning the resident Hara kernel into general RPC.

```text
ChatGPT / MCP client
       │ OAuth 2.1 authorization
       ▼
Greenways pairing challenge
       │ locally signed by Greenways OS
       ▼
revocable greenways-mcp-connection/1
       │ minimal connection-only OAuth props
       ▼
stateless Streamable HTTP /mcp
       │ exact client + connection binding
       ▼
GreenwaysMcpGateway
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

## Signed pairing

`GreenwaysMcpPairingService` creates a short-lived
`greenways-mcp-pairing-challenge/1` bound to:

- the exact OAuth authorization request digest;
- the dynamically registered OAuth client ID, name, and URI;
- exactly the `greenways.read` scope;
- the exact nine-tool read catalogue;
- a one-time nonce and bounded expiry.

Greenways OS signs a `greenways-mcp-pairing-assertion/1` with its local,
non-exported P-256 controller key. The assertion carries only the public
identity card, reviewed browser-device identity, challenge root, and bounded
timestamps. The gateway recalculates the public-key digest and verifies the
signature before claiming the challenge.

The pairing repository owns the one-time state transition:

```text
open → claimed → consumed
          │
          └── OAuth failure → open
```

Concurrent or replayed approvals cannot create another connection. If OAuth
completion fails, the provisional connection is removed and the original
signed assertion can be retried while it remains valid.

A new connection initially uses an honest `replica/...` route with status
`unknown`. The pairing proof establishes identity and client consent; it does
not claim that a Beacon or Home Node will remain online. A later route resolver
can attach verified Beacon/Home Node presence.

## Authorization page

`createGreenwaysMcpAuthorizationHandler()` implements the exact `/authorize`
GET/POST boundary expected by Cloudflare's OAuth provider helpers.

The GET response:

- parses and stores the server-side OAuth request instead of reflecting it into
  hidden browser state;
- escapes dynamic client metadata;
- publishes the pairing challenge as inert `application/json` for the reviewed
  Greenways browser adapter;
- lists every requested tool;
- uses no-store, no-referrer, no-frame, no-script, and same-origin form policy.

The POST response accepts only the challenge ID and bounded signed assertion.
On success it calls `completeAuthorization()` with the Greenways identity ID,
exact `greenways.read` scope, and the minimal connection-only auth properties.
Provider, storage, and authority failures remain opaque; actionable pairing
input errors remain visible.

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
- `src/mcp-pairing.js` — signed challenge/assertion protocol and one-time state.
- `src/mcp-authorization.js` — hardened OAuth authorization GET/POST handler.
- `src/memory-store.js` — test-only in-memory request record store.

## Test

```sh
npm ci
npm test
```

The suite exercises the authority core, replay/recovery boundaries, OAuth
client binding, tool schemas, stateless tool calls, safe errors, route policy,
signed identity pairing, OAuth retry behavior, authorization-page hardening,
and rejection of the legacy MCP lane.

## Next browser slice

The next layer installs a reviewed adapter for the Greenways MCP authorization
origin. It reads only the inert challenge, asks the resident Greenways OS
kernel for explicit approval, signs the challenge without exporting the
controller key, places the assertion in the authorization form, and submits it
only after the user approves.
