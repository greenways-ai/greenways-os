# `greenways-home` command

The Home Node command is the local operator interface for the Greenways browser-to-home relationship. It talks only to the loopback administrator control plane introduced in Greenways OS 0.4. It does not bypass browser-device signatures, expose the administrator surface to the LAN, or turn Home Link into a shared bearer-token system.

Run it from the service source tree with Node 22 or newer:

```sh
node bin/greenways-home.js --help
node bin/greenways-home.js run
```

The planned Homebrew formula installs the same entrypoint as `greenways-home` and runs `greenways-home run` through `brew services`.

## Daily commands

```sh
greenways-home status
greenways-home open
greenways-home pair
greenways-home devices
greenways-home services
greenways-home revoke browser.office
```

`status`, `devices`, `services`, `pair`, and `revoke` establish a short-lived local administrator session with the running node. The client carries the node's `HttpOnly` session cookie, CSRF token, exact loopback `Origin`, and same-origin Fetch Metadata. Every invocation creates a fresh session; no administrator credential is written to disk.

`open` launches the packaged visual-language control plane at `http://127.0.0.1:58100/admin`.

`pair` opens a ten-minute, single-use pairing window and prints the code to enter in Greenways OS. Issuing another code invalidates the previous one.

`revoke` removes only the named browser grant and its replay nonces. Other browser keys remain valid. Persistent nodes acknowledge success only after the updated state file commits.

Use `--json` with management commands for scripts:

```sh
greenways-home status --json
greenways-home devices --json
greenways-home pair --json
greenways-home revoke browser.office --json
```

## Running the node

```sh
greenways-home run \
  --name "Cedar Home" \
  --id home.cedar \
  --state-path ~/.greenways/home-node/state.json
```

The command maps run options onto the existing durable daemon:

- `--host` → `HOST`
- `--port` → `PORT`
- `--state-path` → `GREENWAYS_HOME_STATE_PATH`
- `--name` → `GREENWAYS_HOME_NAME`
- `--id` → `GREENWAYS_HOME_ID`

The default listener is `127.0.0.1:58100`. The control command intentionally rejects non-loopback administrator origins, even if a user later publishes the signed Home Link protocol through HTTPS, Tailscale, Headscale, or another route adapter.

Background start and stop belong to the host service manager. On Homebrew that will be:

```sh
brew services start greenways-home
brew services stop greenways-home
```

This separation avoids maintaining a second PID-file supervisor inside Greenways OS and lets macOS `launchd` or Linux `systemd` own restart and log policy.
