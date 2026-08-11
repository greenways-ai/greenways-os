import assert from "node:assert/strict";
import test from "node:test";
import { GreenwaysKeyring } from "../src/keyring.js";
import { MCP_READ_TOOLS } from "../src/mcp-access-protocol.js";
import { canonical, createIdentity, sha256 } from "../src/protocol.js";

class MemoryIdentityStore {
  constructor() { this.values = new Map(); }
  key(name, id) { return `${name}:${id}`; }
  async get(name, id) { return this.values.get(this.key(name, id)); }
  async put(name, id, value) { this.values.set(this.key(name, id), value); }
}

class MemorySessionStorage {
  async get(key) { return { [key]: undefined }; }
  async set() {}
  async remove() {}
}

const nowText = "2026-08-11T06:20:00.000Z";

async function challenge(overrides = {}) {
  const body = {
    protocol: "greenways-mcp-pairing-challenge/1",
    id: "mcp/challenge/keyring-example-0001",
    client: { id: "chatgpt.greenways", name: "ChatGPT", uri: "https://chatgpt.com/" },
    scopes: ["greenways.read"],
    tools: MCP_READ_TOOLS,
    requestDigest: `sha256:${"b".repeat(64)}`,
    nonce: "01234567-89ab-4def-8123-456789abcdef",
    issuedAt: "2026-08-11T06:19:00.000Z",
    expiresAt: "2026-08-11T06:24:00.000Z",
    ...overrides,
  };
  return { ...body, root: await sha256(canonical(body)) };
}

function keyring() {
  return new GreenwaysKeyring({
    identityStore: new MemoryIdentityStore(),
    sessionStorage: new MemorySessionStorage(),
    identityFactory: (handle) => createIdentity(handle, {
      now: () => nowText,
      cryptoProvider: globalThis.crypto,
    }),
    cryptoProvider: globalThis.crypto,
    now: () => nowText,
  });
}

function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
}

test("signs one exact MCP challenge without exporting the controller key", async () => {
  const service = keyring();
  const controller = await service.createController("alice");
  const value = await challenge();
  const assertion = await service.signMcpPairingChallenge(value, {
    device: {
      id: "greenways-browser/test-extension",
      name: "Greenways OS browser",
      kind: "browser-extension",
    },
    now: () => new Date(nowText),
  });

  assert.equal(assertion.protocol, "greenways-mcp-pairing-assertion/1");
  assert.equal(assertion.challengeId, value.id);
  assert.equal(assertion.challengeRoot, value.root);
  assert.equal(assertion.identity.id, controller.identityId);
  assert.equal(assertion.identity.keyId, controller.keyId);
  assert.equal(assertion.device.kind, "browser-extension");
  assert.doesNotMatch(JSON.stringify(assertion), /privateKey|\"d\"/);

  const { signature, ...body } = assertion;
  const publicKey = await globalThis.crypto.subtle.importKey(
    "jwk",
    assertion.identity.publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  assert.equal(await globalThis.crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    decodeBase64Url(signature),
    new TextEncoder().encode(canonical(body)),
  ), true);
});

test("rejects altered challenge content before signing", async () => {
  const service = keyring();
  await service.createController("alice");
  const value = await challenge();
  await assert.rejects(
    service.signMcpPairingChallenge({
      ...value,
      client: { ...value.client, name: "Changed" },
    }, {
      device: {
        id: "greenways-browser/test-extension",
        name: "Greenways OS browser",
        kind: "browser-extension",
      },
      now: () => new Date(nowText),
    }),
    (error) => error.code === "CHALLENGE_ROOT_INVALID",
  );
});
