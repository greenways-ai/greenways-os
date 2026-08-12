# Greenways daemon and local-client protocol

Status: first executable daemon foundation  
Local request protocol: `greenways-local/0-alpha`  
Local result protocol: `greenways-local-result/0-alpha`  
Daemon state protocol: `greenways-daemon-state/0-alpha`

## Purpose

Greenways is migrating from a browser-kernel-first system to one authoritative
local service:

```text
Greenways Desktop (Flutter) ─┐
greenways CLI                ├─ closed local IPC ─► greenwaysd
Chrome Native Messaging      ┘
```

Greenways Desktop and Greenways Server package the same daemon binary and
storage semantics. Flutter presents state and collects user intent. The Chrome
extension retains browser-specific authority. `greenwaysd` validates,
authorises, executes, signs, persists, and synchronises durable Greenways
operations.

This first slice deliberately establishes process identity, recovery, local IPC,
and exact request receipts before moving keys or the Hara kernel.

## Local endpoint

On macOS and Linux the first endpoint is a Unix-domain socket:

```text
$GREENWAYS_HOME/run/greenwaysd.sock
$HOME/.greenways/run/greenwaysd.sock
```

The containing directories are mode `0700`; the socket and state file are mode
`0600`. The daemon listens only on the local filesystem namespace. It does not
open a TCP port, enable browser CORS, or infer authority from an IP address.

Windows must use a named pipe with equivalent user isolation before the Windows
Desktop or Server package is released. The current implementation fails closed
on non-Unix platforms.

## Request envelope

One connection carries one bounded JSON request and one bounded JSON result. The
client half-closes its write side after sending the request.

```json
{
  "protocol": "greenways-local/0-alpha",
  "requestId": "local/request/0123456789abcdef",
  "operation": "status",
  "arguments": {}
}
```

`0-alpha` publishes only:

```text
status
paths
```

Both are read-only and accept an empty argument object. Unknown fields,
operations, arguments, protocols, and malformed request IDs fail closed. Request
bytes are limited to 64 KiB; responses are limited to 256 KiB.

## Durable request receipts

Before returning a successful result, the daemon stores a bounded receipt
containing:

```text
exact canonical request
SHA-256 request digest
exact result
request ID
commit time
```

Reusing a request ID with the same canonical request returns the stored result
without executing again. Reusing it with different content returns
`request-id-collision`. The first store retains 64 receipts; replacing this
bounded ledger with a durable operational store must preserve the same
idempotency law.

State is written to a private temporary file, fsynced, atomically renamed, and
the parent directory is synced before success is returned.

## Daemon identity

The daemon creates one persistent random node identity:

```text
node/<32 lowercase hexadecimal characters>
```

Each successful process start increments `generation`. Node identity survives
restart. A copied state directory must not later be interpreted as permission to
run two active copies of the same node; enrolment, backup, restore, and identity
replacement are tracked by #51, #53, and #55.

## Authority boundary

This local socket is a transport boundary, not a universal root API. The public
client protocol must remain semantic and closed. It must never grow generic
operations such as:

```text
database.query
filesystem.read-arbitrary
key.export-private
credential.read
browser.call
kernel.eval-arbitrary
http.request-arbitrary
```

A separate root developer interface may exist, but it must be explicitly
privileged and must not be the protocol used by Flutter, the browser bridge, or
ordinary local applications.

## Migration rules

1. The extension remains the current writable authority until a deliberate
   profile migration is committed.
2. Daemon mode and extension-only portable mode are explicit; connection loss
   never silently changes the writable authority.
3. Private keys and provider credentials move only after the daemon vault and
   typed signing boundary are complete.
4. Browser effects remain in the extension and are independently revalidated
   there.
5. Flutter never receives raw secrets or direct database access.
6. Desktop and Server use the same protocol, state records, and daemon binary.

See issue #49 for the release train and issue #50 for this executable foundation.
