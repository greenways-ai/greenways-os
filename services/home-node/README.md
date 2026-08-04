# Greenways Home Node development slice

This service is a runnable reference for the `greenways-home/1` browser-link
protocol. It is intentionally small and in-memory. It demonstrates the trust
boundary before storage, service proxying, or deployment packaging is added.

It supports:

- self-signed home-node discovery and node-key pinning;
- one-time browser pairing codes;
- a separate non-extractable signing key per browser;
- node-signed pairing, status, and unpair receipts;
- signed browser presence with timestamp, request-target, body-hash, and nonce checks;
- replay rejection and signed unpairing; and
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

Set `HOST`, `PORT`, `GREENWAYS_HOME_ID`, or `GREENWAYS_HOME_NAME` to change the
development values. Plain HTTP must stay on loopback. A server reachable over a
LAN or private network must be placed behind HTTPS.

The current registry is deliberately ephemeral. A production node still needs
persistent device records, an authenticated local administration surface,
certificate provisioning, key rotation and revocation policy, rate limiting,
audit receipts, and reviewed adapters for each advertised service.
