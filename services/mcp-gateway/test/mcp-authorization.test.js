import assert from "node:assert/strict";
import test from "node:test";
import { createGreenwaysMcpAuthorizationHandler } from "../src/mcp-authorization.js";
import {
  GreenwaysMcpPairingService,
  MCP_PAIRING_SCOPE,
  MemoryMcpPairingRepository,
  createMcpPairingAssertion,
} from "../src/mcp-pairing.js";
import { canonical, sha256 } from "../src/protocol.js";

const cryptoProvider = globalThis.crypto;
const NOW = new Date("2026-08-11T05:30:00.000Z");

function uuidSequence() {
  let counter = 100;
  return () => `89abcdef-0123-4567-8abc-${(counter++).toString(16).padStart(12, "0")}`;
}

async function controller() {
  const keys = await cryptoProvider.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const exported = await cryptoProvider.subtle.exportKey("jwk", keys.publicKey);
  const publicKey = {
    kty: "EC",
    crv: "P-256",
    x: exported.x,
    y: exported.y,
    ext: true,
    key_ops: ["verify"],
  };
  return {
    identity: {
      id: "identity/alice-authorization",
      handle: "alice",
      keyId: await sha256(canonical(publicKey), cryptoProvider),
      algorithm: "ECDSA-P256-SHA256",
      publicKey,
    },
    privateKey: keys.privateKey,
  };
}

function oauthRequest(overrides = {}) {
  return {
    clientId: "chatgpt.greenways",
    redirectUri: "https://chatgpt.com/aip/callback",
    scope: [MCP_PAIRING_SCOPE],
    state: "state-must-not-be-reflected",
    codeChallenge: "pkce-example",
    codeChallengeMethod: "S256",
    ...overrides,
  };
}

function oauthHelpers(overrides = {}) {
  const calls = { parsed: [], lookup: [], completed: [] };
  return {
    calls,
    async parseAuthRequest(request) {
      calls.parsed.push(request.url);
      return oauthRequest();
    },
    async lookupClient(clientId) {
      calls.lookup.push(clientId);
      return {
        clientId,
        clientName: "ChatGPT <Greenways>",
        clientUri: "https://chatgpt.com/",
      };
    },
    async completeAuthorization(value) {
      calls.completed.push(value);
      return { redirectTo: "https://chatgpt.com/aip/callback?code=greenways-code" };
    },
    ...overrides,
  };
}

function createRig(oauth = oauthHelpers()) {
  const repository = new MemoryMcpPairingRepository();
  const pairingService = new GreenwaysMcpPairingService({
    repository,
    now: () => new Date(NOW),
    randomUUID: uuidSequence(),
    cryptoProvider,
  });
  const handler = createGreenwaysMcpAuthorizationHandler({
    pairingService,
    getOAuth: () => oauth,
  });
  return { repository, pairingService, handler, oauth };
}

async function challengeFrom(response) {
  const source = await response.text();
  const match = source.match(/<script id="greenways-mcp-pairing-challenge" type="application\/json">([^<]+)<\/script>/);
  assert.ok(match, "embedded pairing challenge");
  return { challenge: JSON.parse(match[1]), source };
}

async function signedAssertion(challenge) {
  const actor = await controller();
  const assertion = await createMcpPairingAssertion(challenge, {
    identity: actor.identity,
    device: {
      id: "greenways-browser-primary",
      name: "Primary browser",
      kind: "browser-extension",
    },
    now: () => new Date(NOW),
    sign: async (bytes) => new Uint8Array(await cryptoProvider.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      actor.privateKey,
      bytes,
    )),
  });
  return { actor, assertion };
}

test("renders a no-store authorization challenge without reflecting raw OAuth state", async () => {
  const { handler, oauth } = createRig();
  const response = await handler.fetch(new Request("https://mcp.greenways.ai/authorize"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  const { challenge, source } = await challengeFrom(response);
  assert.equal(challenge.client.id, "chatgpt.greenways");
  assert.equal(challenge.scopes[0], MCP_PAIRING_SCOPE);
  assert.equal(challenge.tools.length, 9);
  assert.match(source, /data-greenways-mcp-assertion/);
  assert.match(source, /ChatGPT &lt;Greenways&gt;/);
  assert.doesNotMatch(source, /state-must-not-be-reflected/);
  assert.deepEqual(oauth.calls.lookup, ["chatgpt.greenways"]);
});

test("completes OAuth with the identity ID and minimal connection-only auth props", async () => {
  const { handler, oauth, repository } = createRig();
  const getResponse = await handler.fetch(new Request("https://mcp.greenways.ai/authorize"));
  const { challenge } = await challengeFrom(getResponse);
  const { actor, assertion } = await signedAssertion(challenge);
  const form = new URLSearchParams({
    challengeId: challenge.id,
    assertion: JSON.stringify(assertion),
  });
  const response = await handler.fetch(new Request("https://mcp.greenways.ai/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  }));

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "https://chatgpt.com/aip/callback?code=greenways-code");
  assert.equal(oauth.calls.completed.length, 1);
  const completed = oauth.calls.completed[0];
  assert.equal(completed.userId, actor.identity.id);
  assert.deepEqual(completed.scope, [MCP_PAIRING_SCOPE]);
  assert.deepEqual(Object.keys(completed.props).sort(), ["connectionId", "protocol"]);
  assert.equal(completed.props.protocol, "greenways-mcp-auth-context/1");
  const connection = await repository.getConnection(completed.props.connectionId);
  assert.equal(connection.identity.id, actor.identity.id);
  assert.equal(connection.client.id, "chatgpt.greenways");
});

test("fails closed for unknown clients, unsupported scopes, and malformed assertions", async () => {
  const unknownOAuth = oauthHelpers({ lookupClient: async () => null });
  const unknown = createRig(unknownOAuth);
  const unknownResponse = await unknown.handler.fetch(new Request("https://mcp.greenways.ai/authorize"));
  assert.equal(unknownResponse.status, 400);

  const scopeOAuth = oauthHelpers({
    parseAuthRequest: async () => oauthRequest({ scope: [MCP_PAIRING_SCOPE, "greenways.write"] }),
  });
  const scope = createRig(scopeOAuth);
  const scopeResponse = await scope.handler.fetch(new Request("https://mcp.greenways.ai/authorize"));
  assert.equal(scopeResponse.status, 400);
  assert.match(await scopeResponse.text(), /exactly greenways.read/);

  const malformed = createRig();
  const getResponse = await malformed.handler.fetch(new Request("https://mcp.greenways.ai/authorize"));
  const { challenge } = await challengeFrom(getResponse);
  const response = await malformed.handler.fetch(new Request("https://mcp.greenways.ai/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ challengeId: challenge.id, assertion: "not-json" }),
  }));
  assert.equal(response.status, 400);
  assert.match(await response.text(), /must be JSON/);
});

test("contains OAuth provider failures and leaves the challenge retryable", async () => {
  let fail = true;
  const oauth = oauthHelpers({
    completeAuthorization: async () => {
      if (fail) throw new Error("oauth-storage-secret");
      return { redirectTo: "https://chatgpt.com/aip/callback?code=retried" };
    },
  });
  const { handler, repository } = createRig(oauth);
  const getResponse = await handler.fetch(new Request("https://mcp.greenways.ai/authorize"));
  const { challenge } = await challengeFrom(getResponse);
  const { assertion } = await signedAssertion(challenge);
  const body = new URLSearchParams({ challengeId: challenge.id, assertion: JSON.stringify(assertion) });

  const failed = await handler.fetch(new Request("https://mcp.greenways.ai/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  }));
  assert.equal(failed.status, 502);
  assert.doesNotMatch(await failed.text(), /oauth-storage-secret/);
  assert.equal((await repository.getSession(challenge.id)).state, "open");
  assert.equal(repository.connections.size, 0);

  fail = false;
  const retried = await handler.fetch(new Request("https://mcp.greenways.ai/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ challengeId: challenge.id, assertion: JSON.stringify(assertion) }),
  }));
  assert.equal(retried.status, 302);
});
