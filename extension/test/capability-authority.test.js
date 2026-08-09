import assert from "node:assert/strict";
import test from "node:test";
import { getAppManifest, validateAppManifest } from "../src/app-catalog.js";
import {
  CAPABILITY_DECISION_PROTOCOL,
  CapabilityAuthority,
  createVerifiedModuleRuntimeState,
} from "../src/capability-authority.js";
import { MODULE_RECORD_PROTOCOL } from "../src/module-record.js";

const LOCK = `sha256:${"a".repeat(64)}`;

function moduleManifest(overrides = {}) {
  return validateAppManifest({
    protocol: "greenways-app/1",
    id: "signing-room",
    version: "0.1.0",
    publisher: { id: "example", name: "Example" },
    name: "Signing Room",
    description: "Signs bounded publication receipts.",
    category: "installable",
    capabilities: ["hara/module", "key/sign"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "preview",
    lockDigest: LOCK,
    source: {
      kind: "github",
      owner: "example",
      repo: "signing-room",
      sha: "b".repeat(40),
    },
    ...overrides,
  });
}

function moduleRecord(manifest = moduleManifest(), overrides = {}) {
  return {
    protocol: MODULE_RECORD_PROTOCOL,
    id: manifest.id,
    manifest,
    lockSource: "{:lock/format 2 :packages {}}",
    lockDigest: manifest.lockDigest,
    entry: "signing.room/view",
    packages: {},
    installedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function repository(record) {
  return { get: async () => record ?? null };
}

function runtimeState(manifest = moduleManifest(), overrides = {}) {
  return createVerifiedModuleRuntimeState([{
    id: manifest.id,
    lockDigest: manifest.lockDigest,
    generation: 1,
    root: `app.${manifest.id}.g1`,
    ...overrides,
  }]);
}

test("accepts an exact bundled approval but not a stale or undeclared one", async () => {
  const historia = getAppManifest("chats");
  const authority = new CapabilityAuthority({
    moduleRepository: repository(null),
    moduleVerification: createVerifiedModuleRuntimeState([]),
  });

  const allowed = await authority.check({
    appId: historia.id,
    capability: "chats/capture",
  }, { installed: [historia] });
  assert.equal(allowed.protocol, CAPABILITY_DECISION_PROTOCOL);
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "verified-bundled-catalog");
  assert.equal(allowed.evidence.kind, "bundled-catalog");

  const undeclared = await authority.check({
    appId: historia.id,
    capability: "key/sign",
  }, { installed: [historia] });
  assert.equal(undeclared.allowed, false);
  assert.equal(undeclared.reason, "capability-not-declared");

  const stale = await authority.check({
    appId: historia.id,
    capability: "chats/capture",
  }, { installed: [{ ...historia, version: "0.0.1" }] });
  assert.equal(stale.allowed, false);
  assert.equal(stale.reason, "catalog-approval-stale");
});

test("requires a durable exact module record and boot-verified runtime generation", async () => {
  const manifest = moduleManifest();
  const missing = new CapabilityAuthority({
    moduleRepository: repository(null),
    moduleVerification: runtimeState(manifest),
  });
  assert.equal((await missing.check({
    appId: manifest.id,
    capability: "key/sign",
  }, { installed: [manifest] })).reason, "module-record-missing");

  const inactive = new CapabilityAuthority({
    moduleRepository: repository(moduleRecord(manifest)),
    moduleVerification: createVerifiedModuleRuntimeState([]),
  });
  assert.equal((await inactive.check({
    appId: manifest.id,
    capability: "key/sign",
  }, { installed: [manifest] })).reason, "module-runtime-unverified");

  const authority = new CapabilityAuthority({
    moduleRepository: repository(moduleRecord(manifest)),
    moduleVerification: runtimeState(manifest),
  });
  const allowed = await authority.check({
    appId: manifest.id,
    capability: "key/sign",
  }, { installed: [manifest] });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "verified-module-runtime");
  assert.equal(allowed.evidence.lockDigest, LOCK);
  assert.equal(allowed.evidence.generation, 1);
  assert.equal(allowed.evidence.root, "app.signing-room.g1");
  assert.equal("lockSource" in allowed.evidence, false);
  assert.equal("packages" in allowed.evidence, false);
});

test("a changed manifest or runtime digest cannot reuse an earlier module approval", async () => {
  const manifest = moduleManifest();
  const changed = moduleManifest({ version: "0.2.0" });
  const approvalMismatch = new CapabilityAuthority({
    moduleRepository: repository(moduleRecord(manifest)),
    moduleVerification: runtimeState(manifest),
  });
  assert.equal((await approvalMismatch.check({
    appId: changed.id,
    capability: "key/sign",
  }, { installed: [changed] })).reason, "module-approval-mismatch");

  const runtimeMismatch = new CapabilityAuthority({
    moduleRepository: repository(moduleRecord(manifest)),
    moduleVerification: {
      get: async () => ({
        id: manifest.id,
        lockDigest: `sha256:${"c".repeat(64)}`,
        generation: 1,
        root: "app.signing-room.g1",
      }),
    },
  });
  assert.equal((await runtimeMismatch.check({
    appId: manifest.id,
    capability: "key/sign",
  }, { installed: [manifest] })).reason, "module-runtime-unverified");
});

test("verified runtime state is closed, duplicate-free, and namespace-bound", () => {
  const manifest = moduleManifest();
  const state = runtimeState(manifest);
  assert.equal(state.get(manifest.id).lockDigest, LOCK);
  assert.deepEqual(state.list().map(({ id }) => id), [manifest.id]);
  assert.throws(() => createVerifiedModuleRuntimeState([{
    id: manifest.id,
    lockDigest: LOCK,
    generation: 1,
    root: "gw.os.kernel",
  }]), /namespace root/);
  assert.throws(() => createVerifiedModuleRuntimeState([
    { id: manifest.id, lockDigest: LOCK, generation: 1, root: "app.signing-room.g1" },
    { id: manifest.id, lockDigest: LOCK, generation: 2, root: "app.signing-room.g2" },
  ]), /duplicate app id/);
});
