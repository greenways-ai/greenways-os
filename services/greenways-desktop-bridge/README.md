# Greenways Desktop bridge

`greenways-desktop-bridge` is the process-isolated local transport used by the Flutter Desktop shell. It deliberately remains a separate child process instead of loading daemon authority into Dart or a broad in-process plugin.

## Closed surface

The bridge reads newline-delimited `greenways-desktop-bridge/0-alpha` requests on stdin and writes one `greenways-desktop-bridge-result/0-alpha` response per request on stdout.

Accepted commands are:

```text
connect
refresh
disconnect
quit
```

It accepts no command-line arguments, paths, role, credential, token, provider profile, room authority, or arbitrary daemon operation. The Greenways home and fixed Desktop credential are resolved by the Rust process:

```text
$GREENWAYS_HOME or ~/.greenways
  run/greenwaysd.sock
  clients/desktop.json
```

The credential must be a private regular file enrolled with the `desktop` role. The token is zeroised by the existing local-client boundary and is never returned to Flutter.

## Public projection

A connected snapshot contains only:

- public daemon/node status;
- active Desktop client ID, role, and label;
- verified public profile identity, when configured;
- session opening/expiry timestamps and remaining request budget.

It omits the credential token, daemon session ID, private key, key-store handle, provider credential, provider handle, capability inventory, and room authority.
