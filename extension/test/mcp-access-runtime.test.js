import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_ACCESS_MESSAGE_TYPE,
  MCP_ACCESS_PROTOCOL,
  createMcpAccessRuntime,
} from "../src/mcp-access-runtime.js";
import { MCP_READ_TOOLS } from "../src/mcp-access-protocol.js";
import { canonical, sha256 } from "../src/protocol.js";

const now = () => new Date("2026-08-11T06:10:00.000Z");

async function challenge() {
  const body = {
    protocol: "greenways-mcp-pairing-challenge/0-alpha",
    id: "mcp/challenge/runtime-example-0001",
    client: { id: "chatgpt.greenways", name: "ChatGPT", uri: "https://chatgpt.com/" },
    scopes: ["greenways.read"],
    tools: MCP_READ_TOOLS,
    requestDigest: `sha256:${"a".repeat(64)}`,
    nonce: "01234567-89ab-4def-8123-456789abcdef",
    issuedAt: "2026-08-11T06:09:00.000Z",
    expiresAt: "2026-08-11T06:14:00.000Z",
  };
  return { ...body, root: await sha256(canonical(body)) };
}

function message(operation, challengeValue) {
  return {
    type: MCP_ACCESS_MESSAGE_TYPE,
    protocol: MCP_ACCESS_PROTOCOL,
    operation,
    challenge: challengeValue,
  };
}

const sender = {
  id: "greenways-extension",
  frameId: 0,
  documentId: "document-mcp-authorization-0001",
  url: "https://mcp.greenways.ai/authorize",
  tab: { id: 17, incognito: false },
};

test("registers only the reviewed authorization adapter and signs after explicit approval", async () => {
  let registered = [];
  let authorityChecks = 0;
  const signingCalls = [];
  const runtime = createMcpAccessRuntime({
    runtime: { id: "greenways-extension" },
    now,
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => registered,
      unregisterContentScripts: async () => { registered = []; },
      registerContentScripts: async (entries) => { registered = entries; },
    },
    keyring: {
      async status() {
        return { controller: { handle: "alice", algorithm: "ECDSA-P256-SHA256" } };
      },
      async signMcpPairingChallenge(value, options) {
        signingCalls.push({ value, options });
        return { protocol: "greenways-mcp-pairing-assertion/0-alpha", challengeId: value.id };
      },
    },
    assertAuthority: async () => { authorityChecks += 1; },
  });

  assert.equal((await runtime.call("mcp-access/status")).enabled, false);
  const enabled = await runtime.call("mcp-access/set-enabled", [true]);
  assert.equal(enabled.enabled, true);
  assert.equal(registered[0].id, "greenways-mcp-authorization");
  assert.deepEqual(registered[0].matches, ["https://mcp.greenways.ai/*"]);

  const value = await challenge();
  const hello = await runtime.handlePageMessage(message("hello", value), sender);
  assert.equal(hello.ready, true);
  assert.equal(signingCalls.length, 0);

  const approved = await runtime.handlePageMessage(message("approve", value), sender);
  assert.equal(approved.assertion.challengeId, value.id);
  assert.equal(signingCalls.length, 1);
  assert.equal(signingCalls[0].options.device.kind, "browser-extension");
  assert.match(signingCalls[0].options.device.id, /^greenways-browser\//);
  assert.equal(authorityChecks, 2);
});

test("rejects unapproved pages, nested frames, incognito, and changed challenge roots", async () => {
  const runtime = createMcpAccessRuntime({
    runtime: { id: "greenways-extension" },
    now,
    permissions: { contains: async () => true },
    scripting: {
      getRegisteredContentScripts: async () => [],
      unregisterContentScripts: async () => {},
      registerContentScripts: async () => {},
    },
    keyring: {
      async status() { return { controller: {} }; },
      async signMcpPairingChallenge() { throw new Error("must not sign"); },
    },
  });
  const value = await challenge();
  await assert.rejects(
    runtime.handlePageMessage(message("hello", value), { ...sender, url: "https://attacker.example/authorize" }),
    (error) => error.code === "CALLER_DENIED",
  );
  await assert.rejects(
    runtime.handlePageMessage(message("hello", value), { ...sender, frameId: 3 }),
    (error) => error.code === "CALLER_DENIED",
  );
  await assert.rejects(
    runtime.handlePageMessage(message("hello", value), { ...sender, tab: { id: 17, incognito: true } }),
    (error) => error.code === "CALLER_DENIED",
  );
  await assert.rejects(
    runtime.handlePageMessage(message("hello", { ...value, client: { ...value.client, name: "Changed" } }), sender),
    (error) => error.code === "CHALLENGE_ROOT_INVALID",
  );
});
