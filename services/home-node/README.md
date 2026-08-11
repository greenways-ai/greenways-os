# Greenways Home Node development service

This service is the runnable reference for the `greenways-home/0-alpha` browser-link
protocol. It demonstrates a durable node identity and browser-grant boundary
before the wider Hestia service host, administration, and deployment system is
added.

It supports:

- a persistent self-signed Home Node identity and browser-side key pinning;
- short-lived, single-use browser pairing codes;
- a separate non-extractable signing key per browser profile;
- node-signed pairing, status, and unpair receipts;
- signed browser presence with timestamp, request-target, body-hash, and nonce
  checks;
- replay rejection across node restarts;
- persistent paired-browser public keys and last-seen records; and
- inert Hestia, Historia, and Hara service advertisements.

It does **not** send JavaScript, Wasm, HAL, HTML, executable manifests, service
credentials, or application state to the extension.

## Run

```sh
npm test
npm start
```

The development server listens on `http://127.0.0.1:58100` and prints a
one-time code. Open Greenways OS, choose **Connect home**, and enter that code.
The code is invalid after one successful pairing. Send `SIGUSR1` to the process
to issue another code:

```sh
kill -USR1 <pid>
```

The default state file is:

```text
~/.greenways/home-node/state.json
```

Override it with `GREENWAYS_HOME_STATE_PATH`. `GREENWAYS_HOME_ID` and
`GREENWAYS_HOME_NAME` configure the identity only when creating a new state
file; a later ID mismatch fails closed instead of silently replacing the node
that browsers pinned. `HOST` and `PORT` change the loopback listener.

The state file contains the Home Node private signing key, its public identity,
paired browser **public** keys, last-seen records, and the recent replay-nonce
cache. Pairing codes are never persisted. On POSIX systems a newly created
state directory is private and the state file is written with mode `0600` using
an atomic temporary-file, `fsync`, and rename sequence. Existing custom parent
directory permissions are not changed.

Treat this file as a sensitive backup: copying it restores the same node
identity and browser grants; losing it causes paired browsers to see a different
node key and require deliberate re-pairing. The key is protected by filesystem
permissions but is not yet encrypted or stored in an operating-system keychain.

Use the old disposable mode only for isolated protocol experiments:

```sh
npm run start:ephemeral
```

Plain HTTP must stay on loopback. A Home Node reachable over a LAN or private
network must sit behind HTTPS.

The reference service still needs an authenticated local administration
surface, certificate provisioning, encrypted or hardware-backed secret
storage, node-key rotation and recovery policy, rate limiting, audit receipts,
persistent service configuration, reviewed service adapters, and production
packaging.
