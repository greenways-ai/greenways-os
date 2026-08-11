# Greenways MCP gateway

Status: implemented read, transport, and signed-pairing boundary for a ChatGPT app  
Transport: remote MCP over authenticated HTTPS

## Purpose

Expose capability-scoped Greenways OS tools and resources to ChatGPT without exposing the resident Hara kernel, browser-extension internals, or local secrets.

```text
ChatGPT app
    │ OAuth 2.1 authorization
    ▼
Greenways MCP authorization page
    │ one-time signed pairing challenge
    ▼
Greenways OS browser authority
    │ controller key remains local
    ▼
revocable MCP connection
    │ authenticated Streamable HTTP
    ▼
Greenways MCP gateway
    │ paired semantic command/result route
    ▼
Greenways Home Node / Beacon / replicated state
    │ independent capability decision
    ▼
resident Greenways OS kernel
```

For a single developer machine, a secure MCP tunnel may replace the hosted gateway during development. The protocol boundary remains the same.

## The gateway is a projection, not kernel RPC

The gateway never exposes general methods such as:

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

Read results are bounded, attributable records. Resources may also be represented as MCP resources where that improves navigation, but the server does not force every operation through generic search/fetch wrappers.

## Implemented read authority core

The authority and replay core is implemented in [`services/mcp-gateway`](../services/mcp-gateway/). Remote transport and OAuth use this boundary rather than receiving a raw kernel call surface.

The core provides:

- closed `greenways-mcp-connection/0-alpha`, `greenways-mcp-request/0-alpha`, and `greenways-mcp-result/0-alpha` records;
- an exact per-connection read-tool allowlist with expiry and final revocation;
- a second, independent Greenways authorization decision for every semantic read;
- bounded and closed arguments for each of the nine read tools;
- atomic exact-digest request claims, cross-isolate duplicate waiting, stale-claim fencing, and collision rejection;
- one SQLite Durable Object coordination atom per request ID, with closed RPC errors and restart-safe replay;
- one lease-fenced SQLite pairing atom per challenge, with provisional connections hidden until consumption;
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
  "protocol": "greenways-mcp-auth-context/0-alpha",
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

Tool input is validated by exact Zod schemas before semantic request validation. Errors are returned as stable `greenways-mcp-tool-error/0-alpha` values and never include provider, bearer, storage, or authority exception details. Browser CORS projection is disabled by default; deployment wrappers configure exact host and origin policy.

## Implemented signed OAuth pairing

The authorization flow does not use a static gateway account or ask Greenways OS to export a controller key.

### Challenge

A GET to `/authorize` parses the server-side OAuth request, looks up the dynamically registered client, and creates a short-lived `greenways-mcp-pairing-challenge/0-alpha` containing:

```text
challenge ID and nonce
exact OAuth request digest
client ID, display name, and URI
exact greenways.read scope
exact nine-tool catalogue
issued-at and expiry
content root
```

The raw OAuth request, including OAuth state and PKCE material, remains server-side. The page publishes only the inert challenge as `application/json` for the reviewed Greenways browser adapter.

### Local approval

Greenways OS recomputes the complete challenge root before signing. It then creates a `greenways-mcp-pairing-assertion/0-alpha` containing the challenge ID/root, public Greenways identity card, reviewed browser-device identity, and bounded timestamps. The assertion is signed with the local non-extractable P-256 controller key.

The gateway:

- validates the exact assertion fields and byte limit;
- recalculates the identity public-key digest;
- verifies the P-256 signature;
- enforces challenge and assertion expiry;
- rejects changed challenge roots and unsupported devices;
- atomically claims the one-time challenge; and
- creates a connection bound to the signed identity and exact OAuth client.

The pairing state is:

```text
open → claimed → consumed
          │
          └── OAuth failure → open
```

A concurrent or replayed approval cannot create another connection. If OAuth completion fails, the provisional connection is removed and the signed assertion remains retryable only while its original expiry is valid.

### OAuth grant

`completeAuthorization()` receives:

```text
userId = Greenways identity ID
scope = [greenways.read]
props = {protocol, connectionId}
```

No public key, controller key, browser credential, bearer token, provider key, OAuth request state, or arbitrary application data is placed in the access-token context.

A new pairing initially receives an honest replicated route with status `unknown`. Identity proof does not claim that a Beacon or Home Node will remain online. Verified route attachment is a separate delivery transition.

### Authorization-page boundary

The page escapes client metadata, lists every requested tool, reflects no raw OAuth state, and applies no-store, no-referrer, no-frame, no-script, and same-origin form restrictions. The POST accepts only the challenge ID and bounded signed assertion. Actionable input errors may be shown; provider, storage, and authority failures remain opaque.

## Consequential tools

The first write-capable tools prepare proposals rather than directly executing effects:

```text
work.submit-result
hestia.propose
hestia.cancel-proposal
```

A proposal records the requesting ChatGPT app, user identity, exact arguments, capability, subject root, expiry, and provenance. Approval and execution remain separate Greenways/Hestia transitions. ChatGPT may present the proposal, but it cannot silently grant itself authority.

## Request envelope

The gateway forwards a closed request envelope:

```json
{
  "protocol": "greenways-mcp-request/0-alpha",
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

A local device can be offline. The gateway distinguishes:

- immediate reads backed by remotely replicated Tahto state;
- device-bound reads that require an online Home Node;
- queued proposals that may await delivery; and
- operations that must fail closed rather than queue.

The gateway does not imply that browser-local state is online when no paired device can serve it.

## Release order

1. Read authority core and stateless Streamable HTTP tool projection — implemented.
2. Signed OAuth challenge/assertion and hardened authorization page — implemented.
3. Reviewed Greenways OS authorization-page adapter and controller signing flow — implemented.
4. Atomic request-claim seam and repository conformance — implemented.
5. Cloudflare SQLite Durable Object request repository — implemented.
6. Durable lease-fenced pairing repository — implemented.
7. Verified Home Node/Beacon delivery.
8. Hestia proposal tools for write intent; no direct execution.
9. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
10. Optional publication after security, privacy, and tool-description review.
