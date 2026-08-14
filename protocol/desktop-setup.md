# Greenways Desktop local setup

Status: `0-alpha`, initial public-identity creation slice

Greenways Desktop uses a separate process-isolated setup protocol to inspect and establish the fixed installation-local boundary around `greenwaysd`. Flutter expresses one closed semantic operation and receives bounded component state. It does not receive filesystem paths, credential bytes, daemon session IDs, private keys, recovery material, provider credentials, or generic process authority.

## Current slice

This slice implements:

```text
inspect
install-daemon
issue-desktop-client
create-identity
repair-permissions
```

The remaining protocol names are reserved but unavailable until their own reviewed slices:

```text
install-browser-bridge
verify
```

An unavailable operation returns `setup-operation-unavailable`; it is not reinterpreted as a generic command.

## Request

```json
{
  "protocol": "greenways-desktop-setup/0-alpha",
  "requestId": "desktop/request/…",
  "operation": "install-daemon",
  "handle": null
}
```

The request has exactly four fields. `handle` is non-null only for `create-identity`; all other operations require `handle: null`. It accepts no executable path, Greenways home, socket path, credential path, role, daemon method, LaunchAgent label, browser host name, extension origin, key-store service, identity ID, algorithm, timestamp, recovery value, or arbitrary argument.

The public identity handle must already be normalized: 1–48 lowercase ASCII letters, numbers, dots, dashes, or underscores, beginning and ending with an alphanumeric character.

## Result

```json
{
  "protocol": "greenways-desktop-setup-result/0-alpha",
  "requestId": "desktop/request/…",
  "snapshot": {
    "protocol": "greenways-desktop-setup-status/0-alpha",
    "state": "credential-required",
    "components": [
      {"kind": "greenways-home", "state": "ready"},
      {
        "kind": "daemon",
        "state": "ready",
        "version": "greenwaysd 0.1.0",
        "digest": "sha256:…",
        "publicId": "ai.greenways.greenwaysd"
      },
      {"kind": "desktop-client", "state": "credential-required"},
      {"kind": "identity", "state": "identity-optional"},
      {"kind": "browser-companion", "state": "browser-companion-optional"}
    ],
    "permittedActions": ["issue-desktop-client", "inspect"],
    "observedAtUnixMs": 1,
    "error": null
  }
}
```

Every component object uses the exact `greenways-desktop-setup-component/0-alpha` protocol and the fixed order shown above. Public version, digest, and identifier metadata may appear only for a component in `ready`. All other actionable states carry one bounded error code rather than a path or raw operating-system error.

## Fixed macOS daemon service

The packaged application contains exact sibling executables:

```text
Greenways Desktop.app/Contents/Resources/greenways-desktop-bridge
Greenways Desktop.app/Contents/Resources/greenwaysd
```

The Rust companion derives every installation location internally from the current macOS user home and its own executable location. The current fixed service contract is:

```text
Greenways home:       $HOME/.greenways
state:                $HOME/.greenways/state
run/socket:           $HOME/.greenways/run/greenwaysd.sock
Desktop credential:  $HOME/.greenways/clients/desktop.json
identity metadata:   $HOME/.greenways/state/profile-identity.json
logs:                 $HOME/.greenways/log
installed daemon:     $HOME/Library/Application Support/Greenways/bin/greenwaysd
LaunchAgent:          $HOME/Library/LaunchAgents/ai.greenways.greenwaysd.plist
label:                ai.greenways.greenwaysd
```

These paths are implementation facts and are not projected to Flutter or copied into diagnostics.

Before installation, the companion verifies that the packaged daemon is a regular, non-writable executable whose exact `--version` identity matches the Desktop build. Installation then:

1. creates only the fixed Greenways-owned directories with private modes;
2. copies the packaged daemon to a same-directory temporary file;
3. commits the executable with an atomic rename;
4. verifies the installed digest and version against the packaged executable;
5. writes the exact LaunchAgent through the same atomic pattern;
6. unloads only the fixed service label when already present;
7. bootstraps and kickstarts only that fixed LaunchAgent.

The LaunchAgent contains only the installed daemon path, `--home`, the fixed Greenways home, fixed log paths, and service-lifecycle settings. It contains no credentials, sessions, private keys, provider material, recovery values, or browser data.

Closing Greenways Desktop does not unload the LaunchAgent and does not stop `greenwaysd`.

## Initial Desktop client enrollment

`issue-desktop-client` is available only when the inspected aggregate state is exactly `credential-required`. It accepts no arguments. The Rust setup companion fixes the complete subject and destination:

```text
label:        Greenways Desktop
role:         desktop
registry:     $HOME/.greenways/state/local-clients.json
credential:   $HOME/.greenways/clients/desktop.json
```

The operation:

1. rejects an existing fixed credential without overwriting it;
2. rejects unsafe or incorrectly permissioned registry state;
3. stops only the fixed `ai.greenways.greenwaysd` service;
4. opens the daemon-owned local-client registry through `greenways-authority`;
5. refuses to create another client when an active Desktop record already exists without the fixed credential;
6. issues one exact `desktop` client directly to the fixed private credential file;
7. persists only the token digest in the registry;
8. reads and verifies the credential against the committed registry record;
9. restarts the fixed daemon service; and
10. returns a new inspection snapshot containing only the public local-client ID.

The credential token is never returned to Flutter, serialized into the setup response, copied into diagnostics, or passed through a process argument. An existing wrong-role credential remains `credential-role-mismatch`. An orphaned active Desktop registry record becomes `manual-recovery-required` rather than silently creating a second client.

## Initial public identity

`create-identity` is available only when the inspected aggregate state is exactly `identity-optional`. The request supplies one normalized public handle and no private or authority-bearing material. The Rust setup companion fixes the metadata destination, signing algorithm, key-store service, identity identifier generation, and timestamp source.

The operation:

1. validates the normalized public handle before changing process state;
2. rejects an existing, unsafe, or incorrectly permissioned fixed identity metadata path;
3. stops only the fixed `ai.greenways.greenwaysd` service;
4. opens `greenways-identity::ProfileIdentityVault` at the fixed metadata path;
5. creates one self-signed P-256 public identity;
6. stores the private signing key only in the operating-system keyring;
7. atomically persists only the signed public identity metadata with private mode;
8. verifies the private key against the signed public card;
9. restarts the fixed daemon service; and
10. returns a new inspection snapshot containing only the public identity ID.

The handle is public input, but the setup response does not echo it. Private key bytes, key-store handles, signatures, subject roots, metadata paths, recovery material, and arbitrary identity records never enter Flutter or copyable diagnostics. If creation fails after service stop, the companion attempts to restore the daemon before returning a bounded failure.

Identity is optional for installation-local Desktop operation. **Continue without identity** changes only the current Desktop destination; it does not persist a waiver, synthesize an identity, or grant Hestia authority.

## Inspection and recovery states

Inspection rejects symbolic links, unexpected file types, wrong ownership, unsafe sockets, malformed credentials, wrong Desktop roles, malformed identity metadata, executable identity drift, and LaunchAgent drift.

The current actionable transitions are:

```text
not-inspected                 -> inspect
install-required              -> install-daemon | inspect
upgrade-required              -> install-daemon | inspect
restart-required              -> install-daemon | inspect
permission-repair-required    -> repair-permissions | inspect
credential-required           -> issue-desktop-client | inspect
identity-optional             -> create-identity | inspect
all other inspected states    -> inspect
```

Permission repair changes modes only on fixed, already-owned Greenways directories and files. Missing components are not invented by permission repair. Unexpected ownership or symbolic links require manual recovery rather than replacement.

## Confidentiality

Rust and Dart both use closed schemas. Dart rejects confidential-looking values including local credential prefixes, daemon session prefixes, key-store handles, and private Greenways paths. Copyable diagnostics contain only:

- setup protocol and aggregate state;
- component kind and bounded state;
- public daemon version, digest, or service label when ready;
- public local-client or identity ID when ready;
- permitted semantic actions;
- timestamp and redacted error code.

## Deliberate limits

This slice does not replace or revoke a Desktop credential; recover from an interrupted replacement; import, recover, replace, rotate, or export an identity; expose recovery material; install a browser companion; perform final local/substrate verification; forward page or provider operations; establish Hestia room membership; update arbitrary software; accept custom paths; execute arbitrary local packages; or provide Windows or Linux Desktop service installation.
