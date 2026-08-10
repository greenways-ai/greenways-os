import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

test("extension requests only its required root-OS permissions", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["sidePanel", "alarms", "storage", "nativeMessaging", "scripting", "userScripts"]);
  assert.equal(manifest.side_panel.default_path, "src/launcher.html");
  assert.equal(manifest.action.default_title, "Open Greenways OS");
  assert.equal(manifest.action.default_icon["32"], "src/assets/icons/greenways-32.png");
  assert.equal(manifest.icons["128"], "src/assets/icons/greenways-128.png");
  assert.equal(manifest.minimum_chrome_version, "120");
  assert.equal(manifest.background.service_worker, "dist/background.js");
  assert.equal(manifest.background.type, "module");
});

test("powerful browser permissions are absent", () => {
  const declared = new Set([
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
  ]);

  assert.equal(declared.has("nativeMessaging"), true);
  assert.equal(declared.has("scripting"), true);
  for (const forbidden of ["debugger", "tabs", "webRequest"]) {
    assert.equal(declared.has(forbidden), false, forbidden);
  }
});

test("network access remains optional and user-granted", () => {
  assert.equal("host_permissions" in manifest, false);
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
});

test("extension pages allow bundled Hara WebAssembly without allowing remote code", () => {
  const policy = manifest.content_security_policy.extension_pages;
  assert.match(policy, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(policy, /worker-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.doesNotMatch(policy, /\bblob:/);
  assert.doesNotMatch(policy, /(?:^|\s)'unsafe-eval'(?:;|\s|$)/);
  assert.doesNotMatch(policy, /script-src[^;]*https?:/);
});
