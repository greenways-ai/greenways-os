import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DaemonBrowserConnection,
  LOCAL_CREDENTIAL_PROTOCOL,
  readBrowserCredential,
} from "../src/daemon-client.js";

const DIGEST = `sha256:${"0".repeat(64)}`;

function response(request, value) {
  return `${JSON.stringify({
    protocol: "greenways-local-result/0-alpha",
    requestId: request.requestId,
    outcome: "ok",
    value,
    error: null,
  })}\n`;
}

async function fixtureCredential(directory, overrides = {}) {
  const path = join(directory, "browser-bridge.json");
  const value = {
    protocol: LOCAL_CREDENTIAL_PROTOCOL,
    clientId: "local/client/0123456789abcdef0123456789abcdef",
    role: "browser-bridge",
    token: `gwc_${"A".repeat(43)}`,
    issuedAtUnixMs: 1_786_500_000_000,
    ...overrides,
  };
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return { path, value };
}

test("reads only a private exact browser-bridge credential", async () => {
  const directory = await mkdtemp(join(tmpdir(), "greenways-browser-credential-"));
  const { path, value } = await fixtureCredential(directory);
  assert.deepEqual(await readBrowserCredential(path), value);

  const wrong = await fixtureCredential(directory, { role: "developer" });
  await assert.rejects(() => readBrowserCredential(wrong.path), { code: "authentication-rejected" });
});

test("opens one authenticated daemon session and projects no bearer authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "greenways-browser-daemon-"));
  const socketPath = join(directory, "greenwaysd.sock");
  const { path: credentialPath, value: credential } = await fixtureCredential(directory);
  const sessionId = "local/session/0123456789abcdef0123456789abcdef";
  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const at = buffer.indexOf("\n");
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        if (request.operation === "client.session.open") {
          socket.write(response(request, {
            protocol: "greenways-local-session/0-alpha",
            id: sessionId,
            clientId: credential.clientId,
            role: "browser-bridge",
            label: "Chrome browser bridge",
            openedAtUnixMs: 1_786_500_000_100,
            expiresAtUnixMs: 1_786_500_300_100,
            remainingRequests: 128,
          }));
        } else if (request.operation === "status") {
          socket.write(response(request, {
            protocol: "greenways-daemon-status/0-alpha",
            nodeId: "node/0123456789abcdef0123456789abcdef",
            daemonVersion: "0.1.0",
            localProtocol: "greenways-local/0-alpha",
            generation: 7,
            stateRevision: 42,
            processId: 100,
            startedAtUnixMs: 1_786_499_000_000,
            observedAtUnixMs: 1_786_500_000_200,
            profileMode: "desktop",
            authorityMode: "daemon",
          }));
        } else if (request.operation === "client.whoami") {
          socket.write(response(request, {
            protocol: "greenways-local-client/0-alpha",
            id: credential.clientId,
            role: "browser-bridge",
            label: "Chrome browser bridge",
            createdAtUnixMs: credential.issuedAtUnixMs,
            revokedAtUnixMs: null,
          }));
        } else if (request.operation === "identity.public-card") {
          socket.write(response(request, {
            protocol: "greenways-signed-profile-identity/0-alpha",
            subject: {
              protocol: "greenways-profile-identity/0-alpha",
              id: "identity/0123456789abcdef0123456789abcdef",
              handle: "chris",
              keyId: DIGEST,
              algorithm: "p256-sha256-fixed",
              publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
              createdAtUnixMs: 1_786_400_000_000,
            },
            subjectRoot: DIGEST,
            signature: "signature",
          }));
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  const { connection, snapshot } = await DaemonBrowserConnection.connect({
    socketPath,
    credentialPath,
    now: () => 1_786_500_001_000,
  });
  const encoded = JSON.stringify(snapshot);
  assert.equal(snapshot.actor.role, "browser-bridge");
  assert.equal(snapshot.identity.handle, "chris");
  assert.equal(snapshot.session.remainingRequests, 125);
  assert.equal(encoded.includes(credential.token), false);
  assert.equal(encoded.includes(sessionId), false);
  assert.deepEqual(requests.map(({ operation }) => operation), [
    "client.session.open",
    "status",
    "client.whoami",
    "identity.public-card",
  ]);

  connection.close();
  await new Promise((resolve) => server.close(resolve));
});
