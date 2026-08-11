# Greenways MCP gateway

This service is the read-side authority core for issue #33. It is deliberately
transport-neutral: remote Streamable HTTP and OAuth terminate outside this
module, while every semantic read still passes through a closed Greenways
connection, an exact tool grant, and an independent local capability decision.

```text
remote MCP transport / OAuth
          |
          | greenways-mcp-request/1
          v
GreenwaysMcpGateway
  - closed read-tool catalogue
  - connection expiry and revocation
  - exact argument validation
  - request-ID idempotency and collision rejection
  - independent Greenways authority gate
  - replicated vs device-bound availability
  - bounded public results and provenance
          |
          v
explicit semantic handlers
```

The gateway does not expose `kernel/eval`, arbitrary kernel methods, arbitrary
HTTP, browser calls, private keys, provider credentials, cookies, or bearer
tokens. A transport access token identifies a connection but is never enough to
execute a Greenways read: `authorize()` must independently approve the exact
connection, tool, request, identity, and route.

## Initial tool catalogue

- `greenways.status`
- `apps.list`
- `apps.get`
- `work.list`
- `work.get`
- `resources.search`
- `resources.read`
- `receipts.get`
- `chats.search`

`chats.search` is device-bound and returns a structured `device-offline` result
rather than pretending an offline read was queued. Replicated tools can remain
available from attributable Tahto/Space snapshots while a browser or Beacon is
offline.

## Run the core tests

```sh
npm test
```

## Next transport slice

The next release layer will serve this core from a Cloudflare Worker using the
stateless `createMcpHandler` Streamable HTTP path, then add OAuth/pairing that
issues revocable `greenways-mcp-connection/1` records. Transport handlers will
map MCP tools to these explicit semantic handlers; they will not receive a raw
kernel call surface.
