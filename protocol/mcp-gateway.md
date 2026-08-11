# Greenways MCP gateway

Status: architecture boundary for a ChatGPT app  
Transport: remote MCP over authenticated HTTPS

## Purpose

Expose capability-scoped Greenways OS tools and resources to ChatGPT without exposing the resident Hara kernel, browser-extension internals, or local secrets.

ChatGPT connects to a remote MCP server. A browser extension service worker is not itself a remote server, so the supported path is:

```text
ChatGPT app
    │ authenticated MCP
    ▼
Greenways MCP gateway
    │ paired, encrypted command and result channel
    ▼
Greenways Home Node / Beacon
    │ capability-checked local request
    ▼
resident Greenways OS kernel
```

For a single developer machine, a secure MCP tunnel may replace the hosted gateway during development. The protocol boundary remains the same.

## The gateway is a projection, not kernel RPC

The gateway must never expose general methods such as:

```text
kernel/eval
kernel/call-arbitrary
credential/get
key/export-private
browser/call
http/arbitrary-request
```

Instead it publishes a closed set of semantic tools backed by Greenways services.

## Initial read tools

```text
greenways.status
apps.list
apps.get
work.list
work.get
resources.search
resources.read
receipts.get
chats.search
```

Read results are bounded, attributable records. Resources may be represented as MCP resources where that improves navigation, but the server does not need to force every operation through generic search/fetch wrappers.

## Implemented read authority core

The authority and replay core is implemented in [`services/mcp-gateway`](../services/mcp-gateway/). Remote transport and OAuth must use this boundary rather than giving either layer a raw kernel call surface.

The core provides:

- closed `greenways-mcp-connection/1`, `greenways-mcp-request/1`, and `greenways-mcp-result/1` records;
- an exact per-connection read-tool allowlist with expiry and final revocation;
- a second, independent Greenways authorization decision for every semantic read;
- bounded and closed arguments for each of the nine read tools;
- content-digested request-ID idempotency, concurrent duplicate suppression, and collision rejection;
- validation of stored results before replay;
- stable, non-leaking storage, authority, and semantic-handler failure boundaries;
- distinct replicated, hybrid, and device-bound availability;
- explicit `device-offline` results for browser-local reads that were not queued;
- bounded public values and attributable provenance; and
- recursive rejection of credential-, token-, cookie-, password-, and private-key-shaped result fields.

A transport access token identifies the paired MCP connection. It does not grant Greenways capability authority, enlarge the connection's tool set, or make an offline browser appear available.

## Implemented Streamable HTTP transport

The nine read tools are projected through the stateless MCP `2026-07-28` lane using Cloudflare's `createMcpHandler` and the MCP SDK v2 server. The handler serves the exact `/mcp` route and rejects the legacy MCP lane.

Each OAuth grant exposes only this application context:

```json
{
  "protocol": "greenways-mcp-auth-context/1",
  "connectionId": "mcp/connection/..."
}
```

The transport independently requires the verified OAuth `clientId` and exact `greenways.read` scope. It binds that client ID into the request digest and requires it to match the durable connection's client identity. OAuth therefore cannot transfer one Greenways connection to another dynamically registered MCP client.

Every tool is advertised as:

```text
read-only
non-destructive
idempotent
closed-world
```

Tool input is validated by exact Zod schemas before the existing semantic request validation. Errors are returned as stable `greenways-mcp-tool-error/1` values and never include provider, bearer, storage, or authority exception details. Browser CORS projection is disabled by default; deployment wrappers must configure exact host and origin policy.

OAuth authorization and Greenways pairing remain a separate layer. The authorization screen will consume a short-lived Beacon/Home Node pairing assertion and issue the minimal context above; it must not use a static demo user or receive a controller private key.

## Consequential tools

The first write-capable tools should prepare proposals rather than directly execute effects:

```text
work.submit-result
hestia.propose
hestia.cancel-proposal
```

A proposal records the requesting ChatGPT app, user identity, exact arguments, capability, subject root, expiry, and provenance. Approval and execution remain separate Greenways/Hestia transitions. ChatGPT may present the proposal, but it cannot silently grant itself authority.

## Pairing and identity

The MCP gateway authenticates a Greenways identity through an interactive browser pairing flow. The gateway receives a revocable device/session credential, never the controller private key.

A connection is bound to:

- Greenways identity ID and public key;
- gateway client/application ID;
- allowed MCP tools;
- selected Home Node or device route;
- expiry and revocation state;
- optional workspace or organization scope.

The local device independently verifies every request. A valid gateway access token is transport identity, not sufficient Greenways capability authority.

## Request envelope

The gateway forwards a closed request envelope:

```json
{
  "protocol": "greenways-mcp-request/1",
  "requestId": "mcp/request/…",
  "connectionId": "mcp/connection/…",
  "tool": "work.get",
  "arguments": {"workId": "work/…"},
  "issuedAt": "…",
  "expiresAt": "…"
}
```

The local result contains the exact request ID, outcome, bounded value or error, and receipt/provenance references. Retried request IDs are idempotent for the same authenticated OAuth client; reuse from another client collides.

## Availability model

A local device can be offline. The gateway therefore distinguishes:

- immediate reads backed by remotely replicated Tahto state;
- device-bound reads that require an online Home Node;
- queued proposals that may await delivery;
- operations that must fail closed rather than queue.

The gateway must not imply that browser-local state is online when no paired device can serve it.

## Release order

1. Read authority core and stateless Streamable HTTP tool projection.
2. OAuth authorization with Greenways pairing and durable connection/request storage.
3. Home Node/Beacon delivery with idempotent request IDs.
4. Hestia proposal tools for write intent; no direct execution.
5. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
6. Optional publication after security, privacy, and tool-description review.
