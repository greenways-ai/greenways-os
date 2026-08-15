# Greenways Desktop control protocol

Status: `0-alpha`, closed local protocol.

The running Flutter application owns one private same-user Unix socket at:

```text
$GREENWAYS_HOME/run/greenways-desktop.sock
```

When `GREENWAYS_HOME` is unset, the path is
`~/.greenways/run/greenways-desktop.sock`. The existing run directory is held
at mode `0700`; the socket is held at mode `0600`. The application rejects a
symlink, regular file, directory, live socket, wrong-mode stale socket, or a
socket that changes while stale recovery is being proved. It removes only the
socket it owns during clean shutdown.

## Framing and limits

Each connection carries exactly one UTF-8 JSON request followed by one newline.
The client closes its write half after the frame. The application returns
exactly one UTF-8 JSON result followed by one newline, flushes it, and closes the
connection.

- maximum request frame: 8 KiB including the newline;
- maximum result frame accepted by the packaged CLI: 256 KiB including the
  newline;
- no extra frames, trailing bytes, duplicate object keys admitted by a closed
  decoder, or unknown fields;
- request IDs are bounded public text matching
  `desktop/control/[A-Za-z0-9._:-]{8,160}`.

## Request

Protocol: `greenways-desktop-control/0-alpha`.

Exact fields:

```json
{
  "protocol": "greenways-desktop-control/0-alpha",
  "requestId": "desktop/control/00000001-0000000000000001-00000001",
  "command": "status"
}
```

The only commands are:

```text
status
connect
refresh
disconnect
show-window
quit
```

There is no setup, recovery, identity creation, browser installation, provider
method, arbitrary method name, argument object, credential field, or daemon
session selector.

## Result

Protocol: `greenways-desktop-control-result/0-alpha`.

Success has the exact fields below. `snapshot` is the existing validated
`greenways-desktop-connection-status/0-alpha` public projection and `error` is
null.

```json
{
  "protocol": "greenways-desktop-control-result/0-alpha",
  "requestId": "desktop/control/00000001-0000000000000001-00000001",
  "outcome": "ok",
  "snapshot": {
    "protocol": "greenways-desktop-connection-status/0-alpha",
    "state": "disconnected",
    "daemon": null,
    "actor": null,
    "identity": null,
    "hestiaImport": null,
    "session": null,
    "error": null,
    "observedAtUnixMs": 1
  },
  "error": null
}
```

Failure has the same exact outer fields, a null `snapshot`, and one exact public
error object:

```json
{
  "protocol": "greenways-desktop-control-result/0-alpha",
  "requestId": "desktop/control/00000001-0000000000000001-00000001",
  "outcome": "error",
  "snapshot": null,
  "error": {
    "code": "desktop-busy",
    "message": "Greenways Desktop is already processing a command."
  }
}
```

Malformed requests use a bounded generated rejection request ID when no valid
caller ID can be recovered. Valid requests are always correlated exactly.

## Execution and authority

Commands are serialized. A command arriving while another control command or
`ConnectionController` operation is active receives `desktop-busy`; it is not
queued. Connection operations call the existing `ConnectionController`, so the
visible app and tray update through their existing listener path. Window and
quit operations call the existing platform shell. `quit` sends and flushes its
snapshot before the control socket is closed and application shutdown begins.

The projection is scanned recursively before the CLI prints it. Secret-shaped
keys and values, including credentials, authorization data, private keys,
provider handles, and daemon session IDs, are rejected. The channel does not
create new daemon authority and cannot widen a developer credential.
