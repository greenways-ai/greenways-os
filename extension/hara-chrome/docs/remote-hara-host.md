# Remote Hara execution host

## Status

Hara Chrome now contains the transport client for the Phase 1 language-owned
Hara execution path:

```text
mcp.hara-lang.org / local hara-mcp
  -> http://127.0.0.1:<port>
  <- Hara Chrome outbound register / poll / result
```

The implementation is intentionally **dormant** in the unpacked extension. It
is exercised with a real HTTP relay fixture in Node tests, but `runtime-host.js`
does not import it and `manifest.json` does not yet request loopback host
permission. This prevents a transport proof from being mistaken for Hara
semantic execution.

The next bounded slice supplies the executor: every `execute` command must
create one fresh restricted Rust/Wasm Sandbox with no browser, network,
persistence, parent runtime, or trusted `ROOT` authority. Only after that
adapter and its capability-negative tests exist should the offscreen document
start this client.

## Modules

`src/remote-host-protocol.js` is the closed wire boundary. It validates:

- `hara.execution-host/0-alpha` descriptors;
- `hara.mcp-pure/0-alpha` eval, call, and check requests;
- `hara.execution-result/0-alpha` terminal results;
- `hara.loopback-relay/0-alpha` registration, polling, commands, errors, and
  result acknowledgements; and
- exact source, output, body, poll, identifier, timestamp, JSON, and lifecycle
  bounds.

`src/remote-host-client.js` owns the outbound lifecycle:

```text
stopped
  -> connecting
  -> ready | degraded
  -> offline -> connecting
  -> faulted | stopped
```

It accepts an injected executor interface:

```js
{
  execute(request, { signal, descriptor }) -> terminalResult,
  cancel?(requestId, reason),
  close?()
}
```

The transport never imports the existing broker, runtime host core, RESP
client, host-call bridge, Chrome API, DOM service, provider services, or
IndexedDB filesystem. The executor is the only future seam into Hara runtime
code, and it must be implemented by the restricted-sandbox slice rather than
by adapting the trusted browser kernel.

## Local relay contract

The base URL must be exactly an explicit IPv4 loopback origin:

```text
http://127.0.0.1:<1..65535>
```

The client rejects HTTPS, `localhost`, IPv6, wildcard, LAN and public hosts,
credentials, paths, queries, and fragments. It never follows redirects and it
constructs only three fixed requests:

```text
POST /v0/host/register
POST /v0/host/poll
POST /v0/host/result
```

Each request carries one development bearer token in the `Authorization`
header. The token is never included in descriptors, commands, terminal
results, status snapshots, diagnostics, request bodies, or error projection.
No caller-supplied method, path, URL, or headers are accepted.

## Command and result laws

- At most one request is active.
- `execute` and `cancel` command IDs are remembered in a bounded in-memory
  window.
- Exact redelivery is acknowledged without a second execution or cancellation.
- Changed content under a command ID, request ID, execute command ID, or cancel
  command ID is a fatal collision.
- The next successful poll acknowledges exactly one command ID.
- Cancellation aborts the executor signal and invokes the optional explicit
  cancel method once.
- A terminal result must remain bound to request ID, host ID, generation,
  backend, runtime build, Hara version, pure profile, and source digest.
- One terminal candidate is immutable. If the relay processes it but its HTTP
  response is lost, reconnect submits the exact same bytes and accepts the
  relay's duplicate acknowledgement.
- Stopping aborts active fixture work and clears retained command and terminal
  state. Final `close()` also closes the injected executor.

## Evidence boundary

The test executor labels every result as a transport fixture and does not
interpret Hara source. A fixture response therefore proves only:

```text
closed values
  + authenticated outbound HTTP
  + host generation
  + command acknowledgement
  + duplicate suppression
  + cancellation
  + reconnect
  + terminal retry
```

It does not prove parsing, compilation, evaluation, namespace loading, Wasm
isolation, source-bundle mounting, capability denial, or cleanup by the Hara
runtime.

## Focused validation

```sh
cd extension/hara-chrome
node --test \
  test/remote-host-protocol.test.js \
  test/remote-host-client.test.js \
  test/remote-host-boundary.test.js
make test-fast
```

The boundary test also verifies that the transport modules contain no import or
reference to the trusted runtime, browser/DOM authority, RESP, host calls,
IndexedDB, or `ROOT`, and that the production extension has not activated the
client prematurely.
