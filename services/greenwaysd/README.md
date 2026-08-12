# `greenwaysd`

`greenwaysd` is the first daemon-first Greenways service slice tracked by
[#50](https://github.com/greenways-ai/greenways-os/issues/50).

It runs independently of Flutter, Chrome, and any visible desktop window. The
first slice owns only:

- one persistent node identity;
- a monotonically increasing process generation;
- a bounded durable request receipt ledger;
- exact request-ID replay and collision fencing;
- a private Unix-domain socket; and
- closed `status` and `paths` reads.

It does **not** yet move the Hara kernel, Keyring, capability authority, package
runtime, sync engine, or application state out of the extension. Those migrations
must proceed behind explicit compatibility seams; daemon mode must never silently
fall back to another writable browser authority.

## Run

```sh
cargo run -p greenwaysd
```

By default state is stored beneath:

```text
$GREENWAYS_HOME
$HOME/.greenways
```

The layout is:

```text
~/.greenways/
├── run/greenwaysd.sock
└── state/daemon.json
```

Override it for development:

```sh
cargo run -p greenwaysd -- --home /tmp/greenways-dev
```

The daemon remains in the foreground. `systemd`, `launchd`, or a later Windows
service wrapper owns background lifecycle.

## Inspect

In another terminal:

```sh
cargo run -p greenways-cli -- status
cargo run -p greenways-cli -- status --json
cargo run -p greenways-cli -- paths
```

## Security boundary

- The socket directory is user-private and the socket is mode `0600` on Unix.
- Requests and responses are bounded and closed.
- Only two read operations exist in this slice.
- Exact request IDs are durable and cannot be reused with changed content.
- State replacement is atomic and fsynced before a success response is returned.
- No private key, credential, arbitrary database query, browser effect, or
  generic Hara evaluation is exposed.
- Windows named-pipe support is required before the first Windows package; the
  current implementation fails closed on non-Unix platforms.

See [`../../protocol/daemon.md`](../../protocol/daemon.md) for the normative
direction and [`../../docs/daemon-migration-inventory.md`](../../docs/daemon-migration-inventory.md)
for the extension-to-daemon responsibility map.

# Greenways provider vault

The daemon now owns provider-profile metadata and stores credential bytes in the operating-system keyring. Use the offline `greenways-admin` command while `greenwaysd` is stopped:

```sh
printf '%s' "$OPENAI_API_KEY" | \
  cargo run -p greenways-admin -- provider add \
    --id openai.personal \
    --provider openai \
    --label "Personal OpenAI"

cargo run -p greenways-admin -- provider list
```

The ordinary `greenways vault` command reads only the redacted `vault.status` projection. Provider credentials, keyring handles and profile labels are not available through the public local protocol.

The daemon does not expose credential reads, arbitrary signing, provider invocation, or secret-store handles. Typed provider invocation will be added behind authenticated daemon authority rather than returning credentials to local clients.

Local clients are enrolled through a separate daemon-owned registry. Desktop, CLI, browser-bridge, and developer roles are fixed at offline issuance, only a SHA-256 credential digest is stored, and revocation is final. A valid credential now opens a five-minute, 128-request session bound to the same Unix connection. `client.whoami` is available to every role; authority inventory remains denied to the browser bridge. Session credentials never enter durable receipts, while subsequent receipts are bound to the daemon-derived client ID and role.

## Authenticated provider invocation

The daemon now accepts the closed `provider.invoke` operation from authenticated Desktop, CLI and developer sessions. It resolves credentials only inside the daemon, calls one fixed provider endpoint, and returns a normalized text result. Browser-bridge invocation remains denied until daemon-owned application grants bind the exact app, origin, profile, model and limits.

Provider calls use a prepared durable claim before network access. Completed calls are replayable by exact actor and request bytes; uncertain calls are never retried automatically. See `protocol/provider-invoke.md`.
