import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ZERO_HASH,
  actionBody,
  canonical,
  createEvidenceBundle,
  createFurnishingBundle,
  createIdentity,
  includeAction,
  normalizeHandle,
  signAction,
  verifyAction,
  verifyEvidenceBundle,
  verifyFurnishingBundle,
  verifyPublicCredential,
  verifyPersonalChain
} from "../src/protocol.js";

test("canonical representation orders nested object keys", () => {
  assert.equal(canonical({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
});

test("handles are aliases with a conservative portable shape", () => {
  assert.equal(normalizeHandle("@Alice.Studio"), "alice.studio");
  assert.throws(() => normalizeHandle("not a handle"), /Handle/);
});

test("identity signs a contribution and independent verification succeeds", async () => {
  const { identity, privateKey } = await createIdentity("alice");
  const body = actionBody({
    type: "@greenways/contribution-claimed",
    actor: identity,
    subject: "sha256:asset",
    payload: { action: "created" }
  });
  const signed = await signAction(body, privateKey);
  assert.equal(await verifyAction(signed, identity.publicKey), true);
  assert.equal(await verifyAction({ ...signed, subject: "sha256:tampered" }, identity.publicKey), false);
});

test("personal inclusions are local and hash linked", async () => {
  const { identity, privateKey } = await createIdentity("alice");
  const firstAction = await signAction(actionBody({
    type: "@greenways/project-created", actor: identity, payload: { title: "Release" }
  }), privateKey);
  const secondAction = await signAction(actionBody({
    type: "@greenways/steward-run", actor: identity, payload: { checks: 5 }
  }), privateKey);
  const first = await includeAction(identity.identityId, null, firstAction);
  const second = await includeAction(identity.identityId, first, secondAction);
  assert.equal(first.previousHash, ZERO_HASH);
  assert.equal(await verifyPersonalChain([first, second]), true);
  assert.equal(await verifyPersonalChain([first, { ...second, sequence: 9 }]), false);
});

test("evidence bundle verifies actions and personal inclusion", async () => {
  const { identity, privateKey } = await createIdentity("alice");
  const action = await signAction(actionBody({
    type: "@greenways/checkpoint-created", actor: identity, payload: { artifacts: [] }
  }), privateKey);
  const inclusion = await includeAction(identity.identityId, null, action);
  const bundle = await createEvidenceBundle({
    identity, actions: [action], inclusions: [inclusion], project: { id: "workload/1" }
  });
  assert.deepEqual(await verifyEvidenceBundle(bundle), { valid: true, errors: [] });
  const result = await verifyEvidenceBundle({ ...bundle, project: { id: "changed" } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("bundle-root-mismatch"));
});

test("room furnishings are signed, portable, and tamper evident", async () => {
  const { identity, privateKey } = await createIdentity("alice");
  const bundle = await createFurnishingBundle({
    identity, privateKey, title: "Repository garden",
    ideas: [{ id: "idea/1", title: "Map the repos", body: "", color: "fern", position: { x: 20, y: 30, z: 10 } }],
    repositories: [{ id: "repository/1", name: "greenways-os", fileCount: 4, nodes: [] }],
    parents: ["sha256:parent"], visibility: "shared"
  });
  assert.deepEqual(await verifyFurnishingBundle(bundle), { valid: true, errors: [] });
  assert.equal(bundle.furnishing.visibility, "shared");
  assert.deepEqual(bundle.furnishing.parents, ["sha256:parent"]);
  const changed = structuredClone(bundle);
  changed.furnishing.title = "Substituted room";
  assert.equal((await verifyFurnishingBundle(changed)).valid, false);
});

test("a public friend credential binds its identity to its key ID", async () => {
  const { identity } = await createIdentity("friend");
  const credential = { protocol: "greenways-public-credential/1", identity };
  assert.equal(await verifyPublicCredential(credential), true);
  assert.equal(await verifyPublicCredential({ ...credential, identity: { ...identity, handle: "renamed" } }), true);
  assert.equal(await verifyPublicCredential({ ...credential, identity: { ...identity, keyId: "sha256:wrong" } }), false);
});
