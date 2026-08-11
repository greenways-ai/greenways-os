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
  sha256,
  signAction,
  verifyAction,
  verifyEvidenceBundle,
  verifyFurnishingBundle,
  verifyPublicCredential,
  verifyPersonalChain,
  verifyPersonalChainMigration,
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
  assert.equal(privateKey.extractable, false);
  await assert.rejects(() => globalThis.crypto.subtle.exportKey("jwk", privateKey));
  assert.equal(identity.keyId, await sha256(canonical(identity.publicKey)));
  assert.equal(identity.publicKey.kty, "EC");
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

test("personal inclusions are owner signed and hash linked", async () => {
  const { identity, privateKey } = await createIdentity("alice");
  const firstAction = await signAction(actionBody({
    type: "@greenways/project-created", actor: identity, payload: { title: "Release" }
  }), privateKey);
  const secondAction = await signAction(actionBody({
    type: "@greenways/steward-run", actor: identity, payload: { checks: 5 }
  }), privateKey);
  const first = await includeAction(identity, privateKey, null, firstAction);
  const second = await includeAction(identity, privateKey, first, secondAction);
  const publicKeys = { [identity.keyId]: identity.publicKey };
  assert.equal(first.previousHash, ZERO_HASH);
  assert.equal(first.keyId, identity.keyId);
  assert.ok(first.signature);
  assert.equal(await verifyPersonalChain([first, second], publicKeys), true);
  assert.equal(await verifyPersonalChain([first, second], {}), false);

  const { eventHash: ignoredHash, signature, ...forgedBody } = {
    ...second,
    includedAt: "2099-01-01T00:00:00.000Z"
  };
  const forged = { ...forgedBody, eventHash: await sha256(canonical(forgedBody)), signature };
  assert.equal(await verifyPersonalChain([first, forged], publicKeys), false);
  assert.equal(await verifyPersonalChain([first, { ...second, sequence: 9 }], publicKeys), false);

  const mallory = await createIdentity("mallory");
  const { eventHash: ignoredFirstHash, signature: firstSignature, ...firstBody } = first;
  const wrongKeyBody = { ...firstBody, keyId: mallory.identity.keyId };
  const wrongKey = {
    ...wrongKeyBody,
    eventHash: await sha256(canonical(wrongKeyBody)),
    signature: firstSignature
  };
  assert.equal(await verifyPersonalChain([wrongKey], {
    ...publicKeys,
    [mallory.identity.keyId]: mallory.identity.publicKey
  }), false);
  await assert.rejects(
    includeAction(identity, mallory.privateKey, first, secondAction),
    /chain owner's key/
  );
});

test("evidence bundle verifies actions and personal inclusion", async () => {
  const { identity, privateKey } = await createIdentity("alice");
  const action = await signAction(actionBody({
    type: "@greenways/checkpoint-created", actor: identity, payload: { artifacts: [] }
  }), privateKey);
  const inclusion = await includeAction(identity, privateKey, null, action);
  const legacyHash = `sha256:${"a".repeat(64)}`;
  const migration = await signAction(actionBody({
    type: "@greenways/personal-chain-migrated",
    actor: identity,
    subject: identity.identityId,
    payload: {
      protocol: "greenways-personal-chain-migration/0-alpha",
      fromProtocol: "greenways-personal-chain/0-alpha-unsigned",
      toProtocol: "greenways-personal-chain/0-alpha",
      legacyHead: legacyHash,
      signedHead: inclusion.eventHash,
      mappings: [{
        sequence: 1,
        actionRoot: action.root,
        legacyEventHash: legacyHash,
        signedEventHash: inclusion.eventHash,
      }],
      previouslyPendingRoots: [action.root],
    },
  }), privateKey);
  assert.equal(await verifyPersonalChainMigration(
    migration,
    [inclusion],
    { [identity.keyId]: identity.publicKey },
  ), true);
  const laterAction = await signAction(actionBody({
    type: "@greenways/checkpoint-extended", actor: identity, payload: { artifacts: ["later"] }
  }), privateKey);
  const laterInclusion = await includeAction(identity, privateKey, inclusion, laterAction);
  assert.equal(await verifyPersonalChainMigration(
    migration,
    [inclusion, laterInclusion],
    { [identity.keyId]: identity.publicKey },
  ), true);
  const extendedBundle = await createEvidenceBundle({
    identity,
    actions: [action, laterAction],
    inclusions: [inclusion, laterInclusion],
    project: { id: "workload/extended" },
    personalChainMigrations: [migration],
  });
  assert.deepEqual(await verifyEvidenceBundle(extendedBundle), { valid: true, errors: [] });
  const bundle = await createEvidenceBundle({
    identity,
    actions: [action],
    inclusions: [inclusion],
    project: { id: "workload/1" },
    personalChainMigrations: [migration],
  });
  assert.deepEqual(await verifyEvidenceBundle(bundle), { valid: true, errors: [] });
  const result = await verifyEvidenceBundle({ ...bundle, project: { id: "changed" } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("bundle-root-mismatch"));

  const { eventHash: ignoredHash, signature, ...changedInclusionBody } = {
    ...inclusion,
    includedAt: "2099-01-01T00:00:00.000Z"
  };
  const changedInclusion = {
    ...changedInclusionBody,
    eventHash: await sha256(canonical(changedInclusionBody)),
    signature
  };
  const { root: ignoredRoot, ...changedBundleBody } = { ...bundle, inclusions: [changedInclusion] };
  const changedBundle = {
    ...changedBundleBody,
    root: await sha256(canonical(changedBundleBody))
  };
  const changedResult = await verifyEvidenceBundle(changedBundle);
  assert.equal(changedResult.valid, false);
  assert.ok(changedResult.errors.includes("personal-chain-invalid"));

  const invalidMigration = {
    ...migration,
    payload: { ...migration.payload, signedHead: `sha256:${"f".repeat(64)}` },
  };
  const { root: ignoredMigrationRoot, ...invalidMigrationBundleBody } = {
    ...bundle,
    personalChainMigrations: [invalidMigration],
  };
  const invalidMigrationBundle = {
    ...invalidMigrationBundleBody,
    root: await sha256(canonical(invalidMigrationBundleBody)),
  };
  const migrationResult = await verifyEvidenceBundle(invalidMigrationBundle);
  assert.ok(migrationResult.errors.includes("personal-chain-migration-invalid:0"));
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
  const credential = { protocol: "greenways-public-credential/0-alpha", identity };
  assert.equal(await verifyPublicCredential(credential), true);
  assert.equal(await verifyPublicCredential({ ...credential, identity: { ...identity, handle: "renamed" } }), true);
  assert.equal(await verifyPublicCredential({ ...credential, identity: { ...identity, keyId: "sha256:wrong" } }), false);
});
