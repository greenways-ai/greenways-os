import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import {
  createHomeNodeOperationQueue,
  createHomeNodeServer,
} from "../src/server.js";
import {
  HOME_ADMIN_PAIRING_PROTOCOL,
  HOME_ADMIN_REVOKED_PROTOCOL,
  HOME_ADMIN_STATUS_PROTOCOL,
  createHomeNodeAdmin,
} from "../src/admin.js";

const TEST_NOW = "2026-08-05T00:00:00.000Z";

function createFakeNode({ persistError = null } = {}) {
  let pairingNumber = 0;
  let persistCount = 0;
  const now = new Date(TEST_NOW);
  const node = {
    node: {
      id: "home.test",
      name: "Test Home",
      algorithm: "ECDSA-P256-SHA256",
      keyId: "sha256:test-home",
    },
    statePath: "/private/home/state.json",
    services: [{
      id: "historia",
      name: "Historia",
      kind: "memory",
      version: "1",
      capabilities: ["history.import"],
      status: "available",
    }],
    devices: new Map([["browser.one", {
      id: "browser.one",
      name: "Office browser",
      publicKey: { kty: "EC", crv: "P-256", x: "secret-x", y: "secret-y" },
      pairedAt: TEST_NOW,
      lastSeenAt: TEST_NOW,
    }]]),
    usedNonces: new Map([
      ["browser.one:nonce/used", now.getTime()],
      ["browser.other:nonce/used", now.getTime()],
    ]),
    pairing: null,
    now: () => new Date(TEST_NOW),
    pairingAvailable() {
      return Boolean(this.pairing && new Date(this.pairing.expiresAt).getTime() >= now.getTime());
    },
    discovery() {
      return {
        protocol: "greenways-home/1",
        node: this.node,
        pairing: { available: this.pairingAvailable() },
        services: this.services,
      };
    },
    issuePairingCode() {
      pairingNumber += 1;
      this.pairing = {
        code: `TEST-${String(pairingNumber).padStart(4, "0")}`,
        issuedAt: TEST_NOW,
        expiresAt: "2026-08-05T00:10:00.000Z",
      };
      return this.pairing;
    },
    persistState() {
      persistCount += 1;
      if (persistError) throw persistError;
    },
    get persistCount() {
      return persistCount;
    },
  };
  return node;
}

function deterministicSecrets(size) {
  return Buffer.alloc(size, 0x47);
}

async function startAdmin(node = createFakeNode()) {
  let origin = null;
  const admin = createHomeNodeAdmin({
    node,
    getOrigin: () => origin,
    now: () => new Date(TEST_NOW),
    randomBytesProvider: deterministicSecrets,
  });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin ?? "http://127.0.0.1");
    if (await admin.handle({ request, response, url })) return;
    response.writeHead(404).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    node,
    origin,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function rawRequest(url, { method = "GET", headers = {} } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function pageSession(response, html) {
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  const csrf = html.match(/<meta name="gw-csrf" content="([^"]+)"/)?.[1];
  assert.ok(cookie);
  assert.ok(csrf);
  return { cookie, csrf };
}

function adminHeaders(origin, cookie, csrf) {
  return {
    cookie,
    origin,
    "sec-fetch-site": "same-origin",
    "x-greenways-csrf": csrf,
  };
}

test("serializes compatibility mutations and recovers after an error", async () => {
  const runExclusive = createHomeNodeOperationQueue();
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const first = runExclusive(async () => {
    order.push("first:start");
    await gate;
    order.push("first:end");
  });
  const second = runExclusive(() => {
    order.push("second");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);

  await assert.rejects(runExclusive(() => { throw new Error("expected"); }), /expected/);
  assert.equal(await runExclusive(() => "ready"), "ready");
});

test("serves a local visual-language control plane with a strict session", async (t) => {
  const app = await startAdmin();
  t.after(app.close);

  const response = await fetch(`${app.origin}/admin`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Your browsers,/);
  assert.match(html, /GREENWAYS HOME NODE · LOCAL CONTROL PLANE/);
  assert.match(html, /--canvas:#f4f2ec/);
  assert.doesNotMatch(html, /<(?:link|img|script)[^>]+(?:src|href)="https?:/i);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(response.headers.get("content-security-policy"), /script-src 'nonce-/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/);

  const rebound = await rawRequest(`${app.origin}/admin`, {
    headers: { host: "attacker.example" },
  });
  assert.equal(rebound.status, 421);
  assert.equal(JSON.parse(rebound.body).error, "unexpected-host");
});

test("requires exact same-origin cookie and CSRF proof for admin APIs", async (t) => {
  const app = await startAdmin();
  t.after(app.close);
  const page = await fetch(`${app.origin}/admin`);
  const html = await page.text();
  const { cookie, csrf } = pageSession(page, html);

  const missing = await fetch(`${app.origin}/greenways/admin/v1/status`);
  assert.equal(missing.status, 403);

  const crossSite = await fetch(`${app.origin}/greenways/admin/v1/status`, {
    headers: {
      cookie,
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
      "x-greenways-csrf": csrf,
    },
  });
  assert.equal(crossSite.status, 403);

  const accepted = await fetch(`${app.origin}/greenways/admin/v1/status`, {
    headers: {
      cookie,
      "sec-fetch-site": "same-origin",
      "x-greenways-csrf": csrf,
    },
  });
  assert.equal(accepted.status, 200);
  const status = await accepted.json();
  assert.equal(status.protocol, HOME_ADMIN_STATUS_PROTOCOL);
  assert.equal(status.browsers[0].name, "Office browser");
  assert.equal(status.browsers[0].publicKey, undefined);
  assert.equal(status.statePath, undefined);
});

test("issues pairing codes and administratively revokes a browser grant", async (t) => {
  const app = await startAdmin();
  t.after(app.close);
  const page = await fetch(`${app.origin}/admin`);
  const html = await page.text();
  const { cookie, csrf } = pageSession(page, html);
  const headers = adminHeaders(app.origin, cookie, csrf);

  const pairingResponse = await fetch(`${app.origin}/greenways/admin/v1/pairing`, {
    method: "POST",
    headers,
  });
  assert.equal(pairingResponse.status, 200);
  const pairing = await pairingResponse.json();
  assert.equal(pairing.protocol, HOME_ADMIN_PAIRING_PROTOCOL);
  assert.equal(pairing.code, "TEST-0001");

  const revokeResponse = await fetch(`${app.origin}/greenways/admin/v1/devices/browser.one/revoke`, {
    method: "POST",
    headers,
  });
  assert.equal(revokeResponse.status, 200);
  const revoked = await revokeResponse.json();
  assert.equal(revoked.protocol, HOME_ADMIN_REVOKED_PROTOCOL);
  assert.equal(revoked.deviceId, "browser.one");
  assert.equal(app.node.devices.has("browser.one"), false);
  assert.equal(app.node.usedNonces.has("browser.one:nonce/used"), false);
  assert.equal(app.node.usedNonces.has("browser.other:nonce/used"), true);
  assert.equal(app.node.persistCount, 1);
});

test("rolls back administrative revocation when durable state cannot commit", async (t) => {
  const node = createFakeNode({ persistError: new Error("disk unavailable") });
  const app = await startAdmin(node);
  t.after(app.close);
  const page = await fetch(`${app.origin}/admin`);
  const html = await page.text();
  const { cookie, csrf } = pageSession(page, html);

  const response = await fetch(`${app.origin}/greenways/admin/v1/devices/browser.one/revoke`, {
    method: "POST",
    headers: adminHeaders(app.origin, cookie, csrf),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "state-unavailable");
  assert.equal(node.devices.has("browser.one"), true);
  assert.equal(node.usedNonces.has("browser.one:nonce/used"), true);
  assert.equal(node.persistCount, 1);
});

test("routes the local control plane before the extension-origin Home Link gate", async (t) => {
  const node = createFakeNode();
  const app = createHomeNodeServer({ node, host: "127.0.0.1", port: 0 });
  await app.listen();
  t.after(() => app.close());

  assert.equal(app.adminUrl, `${app.origin}/admin`);
  const page = await fetch(app.adminUrl);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Your browsers,/);

  const discovery = await fetch(`${app.origin}/.well-known/greenways-home`, {
    headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" },
  });
  assert.equal(discovery.status, 200);
  assert.equal((await discovery.json()).protocol, "greenways-home/1");

  const ordinaryWeb = await fetch(`${app.origin}/.well-known/greenways-home`, {
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(ordinaryWeb.status, 403);
  assert.equal((await ordinaryWeb.json()).error, "browser-origin-required");
});
