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

The transport-neutral first slice is implemented in [`services/mcp-gateway`](../services/mcp-gateway/). It establishes the authority and replay boundary that the remote MCP and OAuth layers must use rather than giving either layer a raw kernel call surface.

The core currently provides:

- closed `greenways-mcp-connection/1`, `greenways-mcp-request/1`, and `greenways-mcp-result/1` records;
- an exact per-connection read-tool allowlist with expiry and final revocation;
- a second, independent Greenways authorization decision for every semantic read;
- bounded and closed arguments for each of the nine read tools;
- content-digested request-ID idempotency, concurrent duplicate suppression, and collision rejection;
- distinct replicated, hybrid, and device-bound availability;
- explicit `device-offline` results for browser-local reads that were not queued;
- bounded public values and attributable provenance; and
- recursive rejection of credential-, token-, cookie-, password-, and private-key-shaped result fields.

A transport access token identifies the paired MCP connection. It does not grant Greenways capability authority, enlarge the connection's tool set, or make an offline browser appear available.

The next slice will map MCP Streamable HTTP tools onto this core and add interactive, revocable pairing. Transport adapters remain replaceable; these semantic request and result records remain the protocol boundary.

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

The local result contains the exact request ID, outcome, bounded value or error, and receipt/provenance references. Retried request IDs are idempotent.

## Availability model

A local device can be offline. The gateway therefore distinguishes:

- immediate reads backed by remotely replicated Tahto state;
- device-bound reads that require an online Home Node;
- queued proposals that may await delivery;
- operations that must fail closed rather than queue.

The gateway must not imply that browser-local state is online when no paired device can serve it.

## Release order

1. Remote read-only MCP server with `greenways.status`, app/work/resource reads, OAuth pairing, request bounds, and receipts.
2. Home Node/Beacon pairing and durable delivery with idempotent request IDs.
3. Hestia proposal tools for write intent; no direct execution.
4. ChatGPT Apps SDK interface for reviewing work, resources, and proposals inside ChatGPT.
5. Optional publication after security, privacy, and tool-description review.
