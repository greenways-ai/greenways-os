import assert from "node:assert/strict";
import test from "node:test";
import { appApprovalIdentity, validateReleaseModuleManifest } from "../src/app.js";

function manifest(overrides = {}) {
  return {
    protocol: "greenways-app/1",
    id: "fixture-app",
    version: "1.2.3",
    publisher: { id: "greenways-ai", name: "Greenways AI" },
    name: "Fixture app",
    description: "A verified release module.",
    category: "installable",
    capabilities: ["hara/module", "storage/local"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "release",
    lockDigest: `sha256:${"a".repeat(64)}`,
    source: {
      kind: "registry",
      registry: "https://packages.greenways.ai/",
      coordinate: "greenways:fixture/app",
    },
    ...overrides,
  };
}

test("validates the same release module approval boundary used by the extension", () => {
  const output = validateReleaseModuleManifest(manifest());
  assert.deepEqual(appApprovalIdentity(output), {
    id: "fixture-app",
    version: "1.2.3",
    publisherId: "greenways-ai",
    capabilities: ["hara/module", "storage/local"],
    handler: "hal-module",
    lockDigest: `sha256:${"a".repeat(64)}`,
  });
});

test("rejects undeclared capability, code fields, and non-registry release sources", () => {
  assert.throws(
    () => validateReleaseModuleManifest(manifest({ capabilities: ["hara/module", "device/root"] })),
    /non-allowlisted capability/,
  );
  assert.throws(
    () => validateReleaseModuleManifest(manifest({ sourceUrl: "https://evil.invalid/app.hal" })),
    /executable, module, source, script, or entrypoint fields|unsupported field/,
  );
  assert.throws(
    () => validateReleaseModuleManifest(manifest({ source: { kind: "github", owner: "x", repo: "y", sha: "a".repeat(40) } })),
    /source.*unsupported field|source.kind must be registry/,
  );
});
