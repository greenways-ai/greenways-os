import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_PAIRING_CHALLENGE_PROTOCOL,
  MCP_READ_TOOLS,
  normalizeMcpPairingChallenge,
} from "../src/mcp-access-protocol.js";
import { canonical, sha256 } from "../src/protocol.js";

const now = () => new Date("2026-08-11T06:00:00.000Z");

async function challenge(overrides = {}) {
  const body = {
    protocol: MCP_PAIRING_CHALLENGE_PROTOCOL,
    id: "mcp/challenge/adapter-example-0001",
    client: {
      id: "chatgpt.greenways",
      name: "ChatGPT",
      uri: "https://chatgpt.com/",
    },
    scopes: ["greenways.read"],
    tools: MCP_READ_TOOLS,
    requestDigest: `sha256:${"a".repeat(64)}`,
    nonce: "01234567-89ab-4def-8123-456789abcdef",
    issuedAt: "2026-08-11T05:59:00.000Z",
    expiresAt: "2026-08-11T06:04:00.000Z",
    ...overrides,
  };
  return { ...body, root: await sha256(canonical(body)) };
}

test("accepts only the exact read-only Greenways challenge", async () => {
  const value = await challenge();
  const normalized = await normalizeMcpPairingChallenge(value, { now });
  assert.equal(normalized.id, value.id);
  assert.deepEqual(normalized.scopes, ["greenways.read"]);
  assert.deepEqual(normalized.tools, MCP_READ_TOOLS);
  assert.ok(Object.isFrozen(normalized));
});

test("rejects changed roots, extra tools, extra fields, and expired challenges", async () => {
  const value = await challenge();
  await assert.rejects(
    normalizeMcpPairingChallenge({ ...value, client: { ...value.client, name: "Changed" } }, { now }),
    (error) => error.code === "CHALLENGE_ROOT_INVALID",
  );
  const tools = [...MCP_READ_TOOLS, "kernel/eval"];
  await assert.rejects(
    normalizeMcpPairingChallenge(await challenge({ tools }), { now }),
    /reviewed Greenways read set/,
  );
  await assert.rejects(
    normalizeMcpPairingChallenge({ ...value, token: "forbidden" }, { now }),
    /unsupported field: token/,
  );
  await assert.rejects(
    normalizeMcpPairingChallenge(await challenge({
      issuedAt: "2026-08-11T05:50:00.000Z",
      expiresAt: "2026-08-11T05:55:00.000Z",
    }), { now }),
    (error) => error.code === "CHALLENGE_EXPIRED",
  );
});
