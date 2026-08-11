import assert from "node:assert/strict";
import test from "node:test";
import { appApprovalIdentity, sameManifestApproval } from "../src/app-launch.js";
import { validateAppManifest } from "../src/app-catalog.js";

const LOCK = `sha256:${"a".repeat(64)}`;

function manifest(overrides = {}) {
  return validateAppManifest({
    protocol: "greenways-app/0-alpha",
    id: "greenways-notes",
    version: "1.0.0",
    publisher: { id: "greenways-ai", name: "Greenways AI" },
    name: "Notes",
    description: "A bounded notes app.",
    category: "installable",
    capabilities: ["storage/local", "hara/module"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "release",
    lockDigest: LOCK,
    source: { kind: "registry", registry: "https://packages.greenways.ai/", coordinate: "greenways:notes" },
    ...overrides,
  });
}

test("module approval binds id, version, publisher, capabilities, handler, and lock digest", () => {
  assert.deepEqual(appApprovalIdentity(manifest()), {
    id: "greenways-notes",
    version: "1.0.0",
    publisherId: "greenways-ai",
    capabilities: ["hara/module", "storage/local"],
    handler: "hal-module",
    lockDigest: LOCK,
  });
});

test("a lock or capability change requires fresh approval", () => {
  const approved = manifest();
  assert.equal(sameManifestApproval(approved, manifest()), true);
  assert.equal(sameManifestApproval(approved, manifest({ lockDigest: `sha256:${"b".repeat(64)}` })), false);
  assert.equal(sameManifestApproval(approved, manifest({ capabilities: ["hara/module"] })), false);
});

test("channel provenance is retained but cannot grant privilege by changing approval identity", () => {
  const release = manifest();
  const preview = manifest({
    channel: "preview",
    source: {
      kind: "github",
      owner: "greenways-ai",
      repo: "greenways-notes",
      sha: "0123456789abcdef0123456789abcdef01234567",
    },
  });
  assert.equal(sameManifestApproval(release, preview), true);
  assert.notDeepEqual(release.source, preview.source);
});
