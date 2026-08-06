import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_CAPABILITIES,
  APP_CHANNELS,
  RUNTIME_HANDLERS,
  validateAppManifest,
} from "../src/app-catalog.js";

const LOCK = `sha256:${"a".repeat(64)}`;

function moduleManifest(overrides = {}) {
  return {
    protocol: "greenways-app/1",
    id: "greenways-notes",
    version: "1.2.0",
    publisher: { id: "greenways-ai", name: "Greenways AI" },
    name: "Notes",
    description: "A bounded HAL notes app.",
    category: "installable",
    capabilities: ["hara/module", "storage/local"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "release",
    lockDigest: LOCK,
    source: {
      kind: "registry",
      registry: "https://packages.greenways.ai/",
      coordinate: "greenways:notes",
    },
    ...overrides,
  };
}

test("publishes hal-module and hara/module as closed vocabulary entries", () => {
  assert.ok(RUNTIME_HANDLERS.includes("hal-module"));
  assert.ok(APP_CAPABILITIES.includes("hara/module"));
  assert.deepEqual(APP_CHANNELS, ["bundled", "release", "preview"]);
});

test("accepts a release module with an exact registry source and lock digest", () => {
  const output = validateAppManifest(moduleManifest());
  assert.equal(output.launch.handler, "hal-module");
  assert.equal(output.lockDigest, LOCK);
  assert.deepEqual(output.source, {
    kind: "registry",
    registry: "https://packages.greenways.ai/",
    coordinate: "greenways:notes",
  });
});

test("accepts only a pinned GitHub SHA for preview provenance", () => {
  const preview = moduleManifest({
    version: "1.2.0-preview.1",
    channel: "preview",
    source: {
      kind: "github",
      owner: "greenways-ai",
      repo: "greenways-notes",
      sha: "0123456789abcdef0123456789abcdef01234567",
    },
  });
  assert.equal(validateAppManifest(preview).source.sha, preview.source.sha);
  assert.throws(
    () => validateAppManifest({ ...preview, source: { ...preview.source, sha: "main" } }),
    /pinned 40-character commit sha/,
  );
});

test("keeps executable source out of manifests even for hal-module", () => {
  assert.throws(
    () => validateAppManifest(moduleManifest({ source: {
      kind: "registry",
      registry: "https://packages.greenways.ai/",
      coordinate: "greenways:notes",
      source: "(ns attacker)",
    } })),
    /cannot declare executable, module, source, script, or entrypoint fields/,
  );
  assert.throws(
    () => validateAppManifest(moduleManifest({ launch: {
      handler: "hal-module",
      entrypoint: "notes.app/view",
    } })),
    /cannot declare executable, module, source, script, or entrypoint fields/,
  );
});

test("requires channel-bound source kinds, hara/module, and a strict digest", () => {
  assert.throws(
    () => validateAppManifest(moduleManifest({ capabilities: ["storage/local"] })),
    /require hara\/module/,
  );
  assert.throws(
    () => validateAppManifest(moduleManifest({ lockDigest: "sha256:abc" })),
    /64 lowercase hex/,
  );
  assert.throws(
    () => validateAppManifest(moduleManifest({
      channel: "release",
      source: { kind: "github", owner: "greenways-ai", repo: "notes", sha: "a".repeat(40) },
    })),
    /must be registry for the release channel/,
  );
  assert.throws(
    () => validateAppManifest(moduleManifest({
      channel: "preview",
      source: { kind: "registry", registry: "https://packages.greenways.ai/", coordinate: "greenways:notes" },
    })),
    /must be github for the preview channel/,
  );
});
