import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ZERO_HASH,
  actionBody,
  bytesToBase64Url,
  canonical,
  createIdentity,
  includeAction,
  sha256,
  signAction,
  verifyAction,
  verifyPersonalChain,
} from "../src/protocol.js";
import { migrateLegacyIdentityAndPersonalChain } from "../src/identity-migration.js";
import { createSyncEntry, SYNC_ENTRY_PROTOCOL } from "../src/sync-protocol.js";

async function createLegacyIdentity(handle = "alice") {
  const keys = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const publicKey = await globalThis.crypto.subtle.exportKey("jwk", keys.publicKey);
  const identity = {
    type: "GreenwaysIdentityCard",
    version: 1,
    identityId: `identity/${handle}`,
    handle,
    keyId: await sha256(canonical(publicKey)),
    algorithm: "ECDSA-P256-SHA256",
    publicKey,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  return { identity, privateKey: keys.privateKey };
}

async function legacyInclusion(identity, previous, action, includedAt) {
  const body = {
    protocol: "greenways-personal-chain/1",
    chainId: identity.identityId,
    sequence: (previous?.sequence ?? 0) + 1,
    previousHash: previous?.eventHash ?? ZERO_HASH,
    actionRoot: action.root,
    includedAt,
  };
  return { ...body, eventHash: await sha256(canonical(body)) };
}

async function legacyFixture() {
  const identityRecord = await createLegacyIdentity();
  const firstAction = await signAction(actionBody({
    type: "@greenways/project-created",
    actor: identityRecord.identity,
    payload: { title: "Migration" },
  }), identityRecord.privateKey);
  const secondAction = await signAction(actionBody({
    type: "@greenways/checkpoint-created",
    actor: identityRecord.identity,
    payload: { artifacts: ["sha256:artifact"] },
  }), identityRecord.privateKey);
  const firstInclusion = await legacyInclusion(
    identityRecord.identity,
    null,
    firstAction,
    "2026-01-02T00:00:00.000Z",
  );
  const secondInclusion = await legacyInclusion(
    identityRecord.identity,
    firstInclusion,
    secondAction,
    "2026-01-03T00:00:00.000Z",
  );
  return {
    identityRecord,
    actions: [firstAction, secondAction],
    inclusions: [firstInclusion, secondInclusion],
    outbox: [secondAction],
  };
}

function repositoryFor(data) {
  const replacements = [];
  return {
    replacements,
    async get(store, key) {
      assert.equal(store, "identity");
      assert.equal(key, "owner");
      return data.identityRecord ?? null;
    },
    async values(store) {
      return data[store] ?? [];
    },
    async replacePersonalChain(change) {
      replacements.push(change);
    },
  };
}

test("hardens a legacy identity and queues its complete rebuilt chain with an audit bridge", async () => {
  const fixture = await legacyFixture();
  fixture.actions.reverse();
  fixture.inclusions.reverse();
  const inputActions = structuredClone(fixture.actions);
  const repository = repositoryFor(fixture);

  const result = await migrateLegacyIdentityAndPersonalChain(repository);

  assert.equal(result.migrated, true);
  assert.equal(result.privateKeyHardened, true);
  assert.equal(result.inclusionCount, 2);
  assert.deepEqual(result.queuedRoots, fixture.inclusions.slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((inclusion) => inclusion.actionRoot));
  assert.deepEqual(result.previouslyPendingRoots, [fixture.outbox[0].root]);
  assert.equal(repository.replacements.length, 1);
  const replacement = repository.replacements[0];
  assert.equal(Object.hasOwn(replacement, "actions"), false);
  assert.equal(replacement.identityRecord.privateKey.extractable, false);
  await assert.rejects(() => globalThis.crypto.subtle.exportKey(
    "jwk",
    replacement.identityRecord.privateKey,
  ));
  assert.deepEqual(replacement.identityRecord.identity, fixture.identityRecord.identity);
  assert.deepEqual(fixture.actions, inputActions);
  assert.deepEqual(
    replacement.inclusions.map((inclusion) => inclusion.actionRoot),
    fixture.inclusions.slice().sort((a, b) => a.sequence - b.sequence).map((inclusion) => inclusion.actionRoot),
  );
  assert.equal(await verifyPersonalChain(replacement.inclusions, {
    [fixture.identityRecord.identity.keyId]: fixture.identityRecord.identity.publicKey,
  }), true);

  assert.equal(replacement.outbox.length, 2);
  for (const entry of replacement.outbox) {
    assert.equal(entry.protocol, SYNC_ENTRY_PROTOCOL);
    assert.equal(entry.inclusion.actionRoot, entry.action.root);
  }

  assert.equal(replacement.identityRecord.personalChainMigrations.length, 1);
  const migration = replacement.identityRecord.personalChainMigrations[0];
  assert.equal(migration.type, "@greenways/personal-chain-migrated");
  assert.equal(await verifyAction(migration, fixture.identityRecord.identity.publicKey), true);
  assert.deepEqual(migration.payload.previouslyPendingRoots, [fixture.outbox[0].root]);
  assert.equal(migration.payload.legacyHead, fixture.inclusions
    .slice().sort((a, b) => a.sequence - b.sequence).at(-1).eventHash);
  assert.equal(migration.payload.signedHead, replacement.inclusions.at(-1).eventHash);
  assert.deepEqual(migration.payload.mappings.map((mapping) => mapping.actionRoot),
    replacement.inclusions.map((inclusion) => inclusion.actionRoot));

  const proof = await signAction(actionBody({
    type: "@greenways/migration-verified",
    actor: fixture.identityRecord.identity,
  }), replacement.identityRecord.privateKey);
  assert.equal(await verifyAction(proof, fixture.identityRecord.identity.publicKey), true);

  const rerun = repositoryFor({
    identityRecord: replacement.identityRecord,
    actions: fixture.actions,
    inclusions: replacement.inclusions,
    outbox: replacement.outbox,
  });
  assert.deepEqual(await migrateLegacyIdentityAndPersonalChain(rerun), {
    migrated: false,
    reason: "current",
  });
  assert.equal(rerun.replacements.length, 0);
});

test("rejects a controller key that does not match the stored public identity", async () => {
  const fixture = await legacyFixture();
  fixture.identityRecord.privateKey = (await createLegacyIdentity("mallory")).privateKey;
  const repository = repositoryFor(fixture);

  await assert.rejects(
    migrateLegacyIdentityAndPersonalChain(repository),
    /private key does not match/,
  );
  assert.equal(repository.replacements.length, 0);
});

test("rejects tampered actions and legacy inclusion hashes before replacement", async (context) => {
  await context.test("tampered action", async () => {
    const fixture = await legacyFixture();
    fixture.actions[0] = { ...fixture.actions[0], payload: { title: "Substituted" } };
    const repository = repositoryFor(fixture);
    await assert.rejects(
      migrateLegacyIdentityAndPersonalChain(repository),
      /invalid root or signature/,
    );
    assert.equal(repository.replacements.length, 0);
  });

  await context.test("tampered inclusion", async () => {
    const fixture = await legacyFixture();
    fixture.inclusions[1] = { ...fixture.inclusions[1], eventHash: `sha256:${"f".repeat(64)}` };
    const repository = repositoryFor(fixture);
    await assert.rejects(
      migrateLegacyIdentityAndPersonalChain(repository),
      /invalid event hash/,
    );
    assert.equal(repository.replacements.length, 0);
  });

  await context.test("owner-signed malformed action", async () => {
    const fixture = await legacyFixture();
    const malformed = await signAction({
      protocol: "greenways-action/1",
      id: "action/AAAAAAAAAAAAAAAAAAAAAA",
      actor: {
        identityId: fixture.identityRecord.identity.identityId,
        handle: fixture.identityRecord.identity.handle,
        keyId: fixture.identityRecord.identity.keyId,
      },
      workflowRoot: null,
      subject: null,
      payload: {},
      createdAt: "2026-01-01T00:00:00.000Z",
    }, fixture.identityRecord.privateKey);
    fixture.actions = [malformed];
    fixture.inclusions = [];
    fixture.outbox = [];
    const repository = repositoryFor(fixture);
    await assert.rejects(
      migrateLegacyIdentityAndPersonalChain(repository),
      /invalid owner-controlled action schema/,
    );
    assert.equal(repository.replacements.length, 0);
  });
});

test("rejects mixed chain schemas and an outbox that is not the validated pending subset", async (context) => {
  await context.test("mixed inclusions", async () => {
    const fixture = await legacyFixture();
    fixture.inclusions[1] = await includeAction(
      fixture.identityRecord.identity,
      fixture.identityRecord.privateKey,
      null,
      fixture.actions[1],
    );
    const repository = repositoryFor(fixture);
    await assert.rejects(
      migrateLegacyIdentityAndPersonalChain(repository),
      /mixes legacy and signed inclusions/,
    );
    assert.equal(repository.replacements.length, 0);
  });

  await context.test("unrelated pending action", async () => {
    const fixture = await legacyFixture();
    const outsider = await createLegacyIdentity("outsider");
    fixture.outbox = [await signAction(actionBody({
      type: "@greenways/checkpoint-created",
      actor: outsider.identity,
    }), outsider.privateKey)];
    const repository = repositoryFor(fixture);
    await assert.rejects(
      migrateLegacyIdentityAndPersonalChain(repository),
      /validated pending action/,
    );
    assert.equal(repository.replacements.length, 0);
  });
});

test("is idempotent for an already hardened signed chain", async () => {
  const identityRecord = await createIdentity("alice");
  const action = await signAction(actionBody({
    type: "@greenways/project-created",
    actor: identityRecord.identity,
  }), identityRecord.privateKey);
  const inclusion = await includeAction(
    identityRecord.identity,
    identityRecord.privateKey,
    null,
    action,
  );
  const repository = repositoryFor({
    identityRecord,
    actions: [action],
    inclusions: [inclusion],
    outbox: [createSyncEntry(action, inclusion)],
  });

  assert.deepEqual(await migrateLegacyIdentityAndPersonalChain(repository), {
    migrated: false,
    reason: "current",
  });
  assert.equal(repository.replacements.length, 0);
});

test("rejects a signed chain that is not bound to the stored owner identity", async () => {
  const identityRecord = await createIdentity("alice");
  const action = await signAction(actionBody({
    type: "@greenways/project-created",
    actor: identityRecord.identity,
  }), identityRecord.privateKey);
  const inclusion = await includeAction(
    { ...identityRecord.identity, identityId: "identity/mallory" },
    identityRecord.privateKey,
    null,
    action,
  );
  const repository = repositoryFor({
    identityRecord,
    actions: [action],
    inclusions: [inclusion],
    outbox: [createSyncEntry(action, inclusion)],
  });

  await assert.rejects(
    migrateLegacyIdentityAndPersonalChain(repository),
    /invalid owner-bound schema/,
  );
  assert.equal(repository.replacements.length, 0);
});

test("rejects a cryptographically signed inclusion with an invalid current schema", async () => {
  const identityRecord = await createIdentity("alice");
  const action = await signAction(actionBody({
    type: "@greenways/project-created",
    actor: identityRecord.identity,
  }), identityRecord.privateKey);
  const valid = await includeAction(
    identityRecord.identity,
    identityRecord.privateKey,
    null,
    action,
  );
  const { eventHash: ignoredHash, signature: ignoredSignature, ...body } = valid;
  body.includedAt = "not-a-timestamp";
  const signature = bytesToBase64Url(new Uint8Array(await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    identityRecord.privateKey,
    new TextEncoder().encode(canonical(body)),
  )));
  const inclusion = { ...body, eventHash: await sha256(canonical(body)), signature };
  const repository = repositoryFor({
    identityRecord,
    actions: [action],
    inclusions: [inclusion],
    outbox: [createSyncEntry(action, inclusion)],
  });

  await assert.rejects(
    migrateLegacyIdentityAndPersonalChain(repository),
    /invalid owner-bound schema/,
  );
  assert.equal(repository.replacements.length, 0);
});
