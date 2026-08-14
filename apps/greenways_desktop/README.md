# Greenways Desktop

Greenways Desktop is the local management shell for `greenwaysd`. The first release slice covers installation health, direct daemon connectivity, public identity verification and connection-bound session status.

## Authority boundary

The Flutter process does not parse Greenways local-client credentials or open the daemon socket. It starts the bundled `greenways-desktop-bridge` companion with no arguments and exchanges only the closed semantic commands:

```text
connect
refresh
disconnect
quit
```

The Rust companion owns credential loading, the authenticated Unix-socket connection and daemon session. Flutter receives only a bounded public projection; local credential tokens, daemon session IDs, private keys, provider credentials, provider handles and capability inventory are rejected.

The companion-process boundary is deliberate. It preserves the workspace-wide `unsafe_code = "forbid"` policy and gives the Desktop connection an independently testable lifetime without placing secrets in Dart heap objects.

The first-run setup surface uses a separate closed bridge protocol. It can inspect fixed component state, install or restart only the packaged macOS daemon service, enroll the exact initial `desktop` local client directly to its fixed private file, create one optional public identity while retaining its private key in the operating-system keyring, install the exact optional Chrome stable companion with a distinct `browser-bridge` credential, and repair only fixed private modes without exposing private paths, credentials, origins, or key material. See [`../../protocol/desktop-setup.md`](../../protocol/desktop-setup.md).

## Development

The packaged setup surface establishes the initial Desktop credential, optional public identity, and optional exact Chrome companion without a terminal. Identity and browser installation may each be deferred independently without changing durable state. Browser setup accepts no selectors and does not imply that the reserved final connection/substrate verification has run. For focused authority development, the equivalent offline client operation remains:

```bash
greenways-admin --state-dir ~/.greenways \
  client issue \
  --role desktop \
  --output ~/.greenways/clients/desktop.json
```

Then start the daemon and run the app from the repository root:

```bash
cd apps/greenways_desktop
flutter run -d macos
```

The macOS build phase compiles, verifies, embeds, and signs `greenways-desktop-bridge`, the exact `greenwaysd` service binary, and the self-contained `greenways-browser-bridge-host` executable. The browser host needs no ambient Node runtime or repository checkout. For focused Dart development, `GREENWAYS_DESKTOP_BRIDGE` may name a locally built companion executable; the setting is not exposed in the UI or persisted.

Closing the window hides it. The daemon remains independent, and the app remains available from its menu-bar item until **Quit Greenways Desktop** is selected.
