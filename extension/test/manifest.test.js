import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

test("extension requests only its two required permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["sidePanel", "storage"]);
});

test("powerful browser permissions are absent", () => {
  const declared = new Set([
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
  ]);

  for (const forbidden of ["debugger", "tabs", "scripting", "webRequest"]) {
    assert.equal(declared.has(forbidden), false, forbidden);
  }
});

test("network access remains optional and user-granted", () => {
  assert.equal("host_permissions" in manifest, false);
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
});
