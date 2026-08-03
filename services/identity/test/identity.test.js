import assert from "node:assert/strict";
import test from "node:test";
import { actionBody, createIdentity, signAction } from "../../../extension/src/protocol.js";
import { createIdentityHandler } from "../src/http.js";
import { IdentityRegistry } from "../src/registry.js";

async function registration(handle) {
  const created = await createIdentity(handle);
  const body = actionBody({ type: "@greenways/identity-registered", actor: created.identity, subject: created.identity.identityId, payload: { identity: created.identity } });
  return { identity: created.identity, action: await signAction(body, created.privateKey) };
}

test("a controller can publish its signed public identity", async () => {
  const registry = new IdentityRegistry();
  const { identity, action } = await registration("river.studio");
  const resolution = await registry.register(action);
  assert.equal(resolution.identityId, identity.identityId);
  assert.equal(resolution.handle, "river.studio");
  assert.equal(resolution.currentKey.keyId, identity.keyId);
  assert.match(resolution.resolutionRoot, /^sha256:[a-f0-9]{64}$/);
});

test("handle collisions remain visible", async () => {
  const registry = new IdentityRegistry();
  await registry.register((await registration("shared-name")).action);
  await registry.register((await registration("shared-name")).action);
  const result = await registry.resolveHandle("@shared-name");
  assert.equal(result.candidates.length, 2);
  assert.notEqual(result.candidates[0].identityId, result.candidates[1].identityId);
});

test("claims cannot substitute another public key", async () => {
  const registry = new IdentityRegistry();
  const first = await registration("artist-one");
  const second = await registration("artist-two");
  await assert.rejects(registry.register({ ...first.action, payload: { identity: second.identity } }), /register itself|Invalid/);
});

test("HTTP profile exposes discovery, claims, identity and handle lookup", async () => {
  const handle = createIdentityHandler(new IdentityRegistry());
  const registered = await registration("maker");
  const post = await handle(new Request("https://id.greenways.ai/v1/claims", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(registered.action) }));
  assert.equal(post.status, 201);
  const identity = await handle(new Request(`https://id.greenways.ai/v1/identities/${encodeURIComponent(registered.identity.identityId)}`));
  assert.equal(identity.status, 200);
  const byHandle = await handle(new Request("https://id.greenways.ai/v1/handles/maker"));
  assert.equal((await byHandle.json()).candidates.length, 1);
  const discovery = await handle(new Request("https://id.greenways.ai/.well-known/greenways-identity"));
  assert.equal((await discovery.json()).privateKeysAccepted, false);
});
