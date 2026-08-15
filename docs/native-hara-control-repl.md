# Native Hara Greenways control REPL

The control REPL is a separate native Hara project under `repl/`. It is for
local Greenways development and deliberately does **not** add process authority
to the main `greenways/greenways-os` Hara project. The main project retains an
empty capability set. Only `greenways/greenways-control-repl` declares
`:process`, and every launcher invocation also supplies `--allow-process`.

The REPL uses the supported `greenways` CLI. It does not call private daemon
methods, parse credential files, attach to the Flutter process, or expose a
root/developer daemon interface. Daemon authority remains the role and grants
held by the dedicated local-client credential.

## Prerequisites

The repository pins:

- Flutter `3.47.0`;
- Dart `3.13.0` or newer;
- Rust `1.85.1`;
- a native `hara` CLI supporting `--project`, `--offline`, and
  `--allow-process`.

The macOS setup command fails before installation or credential mutation when
those versions are unavailable. Run its non-mutating preflight first:

```bash
repl/bin/setup-macos
```

After installing the pinned toolchain, apply the setup:

```bash
repl/bin/setup-macos --apply
```

The setup command performs all credential and service checks before replacing
the installed app. It builds the release app and packages the `greenways`
binary in `Greenways Desktop.app/Contents/Resources/greenways`. It preserves a
valid existing developer credential. When no credential exists, it refuses:

- symlinks, non-regular files, wrong owners, and modes other than `0600`;
- an inactive or wrong-role credential;
- any active developer registry entry whose credential is absent;
- a duplicate active client labelled `Hara REPL`.

Only after those checks can it stop `ai.greenways.greenwaysd`, issue
`~/.greenways/clients/developer.json` with role `developer` and label
`Hara REPL`, and restore the service through an exit trap. It never uses a
replace option and never stops unrelated services. Finally it launches Desktop
and verifies both developer `whoami` and a live Desktop snapshot.

Environment overrides:

```text
GREENWAYS_HOME
GREENWAYS_CLI
GREENWAYS_DEVELOPER_CREDENTIAL
HARA_BIN
```

## Start the REPL

The default is an offline native REPL with no RESP listener:

```bash
repl/bin/greenways-repl
```

Enable Hara's local RESP listener explicitly for editor attachment:

```bash
repl/bin/greenways-repl --resp
```

The launcher verifies the daemon, authenticates the credential as role
`developer`, ensures the running Desktop control socket is live, prints initial
`require` examples, and starts Hara with explicit process permission.

## Daemon API

```clojure
(require '[gw.repl.greenwaysd :as greenwaysd])

(greenwaysd/status)
(greenwaysd/paths)
(greenwaysd/whoami)
(greenwaysd/vault-status)
(greenwaysd/clients)
(greenwaysd/identity-status)
(greenwaysd/identity-card)
(greenwaysd/capabilities-status)
(greenwaysd/capabilities)
```

Every function also accepts a client map:

```clojure
(def local
  {:home "/Users/me/.greenways"
   :cli "/Applications/Greenways Desktop.app/Contents/Resources/greenways"
   :credential "/Users/me/.greenways/clients/developer.json"})

(greenwaysd/whoami local)
```

Tests can inject `:runner`; the runner receives one argv vector and an options
map. No shell command string is constructed.

Successful `greenways-local-result/0-alpha` envelopes return their unwrapped
`value`. Failures throw `ex-info` containing only:

```clojure
{:greenways/op "whoami"
 :greenways/code "authentication-rejected"
 :greenways/exit 1}
```

Raw stderr, credential material, and unvalidated response objects are never put
in exception data.

## Capability checks and provider invocation

A capability check requires exact application approval evidence:

```clojure
(greenwaysd/capability-check
 {:capability "model/generate"
  :app-id "hara-playground"
  :app-version "1.0.0"
  :publisher "hara-lang"
  :approval-digest "sha256:..."
  :lock-digest "sha256:..."})
```

Provider invocation remains subject to the daemon's existing application
approval and capability grant. The REPL does not approve applications or issue
grants. Prompt text is written to the child process stdin and never appears in
argv:

```clojure
(greenwaysd/invoke
 {:profile "openai/default"
  :model "gpt-5"
  :app-id "hara-playground"
  :app-version "1.0.0"
  :publisher "hara-lang"
  :approval-digest "sha256:..."
  :lock-digest "sha256:..."
  :max-output-tokens 2048
  :timeout-ms 60000
  :prompt "Generate a Greenways program."})
```

A denied or missing grant remains a structured daemon failure. Use the existing
offline `greenways-admin application ...` and `greenways-admin capability ...`
workflows with the daemon stopped when approval administration is intended.

## Desktop API

```clojure
(require '[gw.repl.desktop :as desktop])

(desktop/status)
(desktop/connect)
(desktop/refresh)
(desktop/disconnect)
(desktop/show-window)
(desktop/quit)
```

The equivalent packaged CLI surface is:

```bash
GREENWAYS_CLI="/Applications/Greenways Desktop.app/Contents/Resources/greenways"
"$GREENWAYS_CLI" desktop status --json
"$GREENWAYS_CLI" desktop disconnect --json
"$GREENWAYS_CLI" desktop connect --json
"$GREENWAYS_CLI" desktop show-window --json
```

Each successful command returns only the validated public connection snapshot.
See [`../protocol/desktop-control.md`](../protocol/desktop-control.md) for the
closed socket protocol and confidentiality boundary.

## Tests

Rust and Flutter tests are part of the existing workspace CI:

```bash
cargo +1.85.1 fmt --all --check
cargo +1.85.1 test --workspace --all-targets
cargo +1.85.1 clippy --workspace --all-targets -- -D warnings

cd apps/greenways_desktop
flutter analyze
flutter test
tool/build_macos.sh
```

Hara files are run in fresh offline processes with explicit process permission:

```bash
repl/bin/test
```

The Hara tests inject process runners and cover environment defaults, argv
construction, envelope unwrapping, redacted structured failures, capability
arguments, provider prompt stdin, and Desktop snapshot validation.

## End-to-end acceptance

After setup:

```clojure
(require '[gw.repl.greenwaysd :as greenwaysd])
(require '[gw.repl.desktop :as desktop])

(greenwaysd/status)
(greenwaysd/whoami)       ;; role is developer
(desktop/status)
(desktop/disconnect)      ;; visible app updates immediately
(desktop/connect)
(desktop/show-window)
```

Then verify the existing Desktop connection surface and Chrome integration are
still functional. The control channel cannot run setup, recovery, identity
creation, or browser installation, so those paths remain exercised through
their existing interfaces.

## Troubleshooting

`Flutter 3.47.0 is required before mutation` means the repository-pinned SDK is
not active. Install/select it, rerun the setup preflight, then apply.

`developer credential is missing or unsafe` means the launcher found no regular
current-user mode-`0600` file at the configured path. Do not copy another
client's credential into place. Inspect registry state and revoke an orphan
before issuing a replacement.

`Greenways Desktop is unavailable` means the app is not running or its private
socket could not be proven safe. Launch the installed app. A non-socket or
wrong-mode entry at `~/.greenways/run/greenways-desktop.sock` is intentionally
not deleted automatically.

`desktop-busy` means a visible controller operation is already active. The
control protocol never queues overlapping state changes.

A provider invocation rejection is not a REPL installation failure. Inspect
`greenwaysd/capabilities`, the application approval digest, lock digest, and the
model-generate grant.

## Credential revocation

First obtain the developer client ID without printing its secret:

```clojure
(:id (greenwaysd/whoami))
```

Stop only `ai.greenways.greenwaysd`, revoke the ID through the existing offline
admin CLI, restore the service, and remove the now-invalid credential file:

```bash
launchctl kill SIGTERM "gui/$(id -u)/ai.greenways.greenwaysd"
target/release/greenways-admin client revoke \
  --id 'local/client/...' --home "$HOME/.greenways"
launchctl kickstart -k "gui/$(id -u)/ai.greenways.greenwaysd"
rm -f "$HOME/.greenways/clients/developer.json"
```

Revocation is explicit. Neither setup nor the REPL silently rotates or replaces
an existing developer credential.
