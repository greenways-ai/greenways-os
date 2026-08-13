# Greenways Desktop local setup

Status: `0-alpha`, daemon-service slice

Greenways Desktop uses a separate process-isolated setup protocol to inspect and establish the fixed installation-local boundary around `greenwaysd`. Flutter expresses one closed semantic operation and receives bounded component state. It does not receive filesystem paths, credential bytes, daemon session IDs, private keys, recovery material, provider credentials, or generic process authority.

## Current slice

This slice implements:

```text
inspect
install-daemon
repair-permissions
```

The remaining protocol names are reserved but unavailable until their own reviewed slices:

```text
issue-desktop-client
create-identity
install-browser-bridge
verify
```

An unavailable operation returns `setup-operation-unavailable`; it is not reinterpreted as a generic command.

## Request

```json
{
  "protocol": "greenways-desktop-setup/0-alpha",
  "requestId": "desktop/request/…",
  "operation": "install-daemon"
}
```

The request has exactly three fields. It accepts no executable path, Greenways home, socket path, credential path, role, daemon method, LaunchAgent label, browser host name, extension origin, or arbitrary argument.

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
    "permittedActions": ["inspect"],
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

## Inspection and recovery states

Inspection rejects symbolic links, unexpected file types, wrong ownership, unsafe sockets, malformed credentials, wrong Desktop roles, malformed identity metadata, executable identity drift, and LaunchAgent drift.

The current actionable transitions are:

```text
not-inspected                 -> inspect
install-required              -> install-daemon | inspect
upgrade-required              -> install-daemon | inspect
restart-required              -> install-daemon | inspect
permission-repair-required    -> repair-permissions | inspect
all other inspected states    -> inspect
```

Permission repair changes modes only on fixed, already-owned Greenways directories and files. Missing components are not invented by permission repair. Unexpected ownership or symbolic links require manual recovery rather than replacement.

## Confidentiality

Rust and Dart both use closed schemas. Dart rejects confidential-looking values including local credential prefixes, daemon session prefixes, key-store handles, and private Greenways paths. Copyable diagnostics contain only:

- setup protocol and aggregate state;
- component kind and bounded state;
- public daemon version, digest, or service label when ready;
- permitted semantic actions;
- timestamp and redacted error code.

## Deliberate limits

This slice does not issue, replace, or revoke a Desktop credential; create or recover identity; install a browser companion; forward page or provider operations; establish Hestia room membership; update arbitrary software; accept custom paths; execute arbitrary local packages; or provide Windows or Linux Desktop service installation.
