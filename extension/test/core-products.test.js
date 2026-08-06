import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [html, runtime, theme, keyringProtocol, packageProtocol] = await Promise.all([
  readFile(new URL("../src/launcher.html", import.meta.url), "utf8"),
  readFile(new URL("../src/core-products.js", import.meta.url), "utf8"),
  readFile(new URL("../src/core-products.css", import.meta.url), "utf8"),
  readFile(new URL("../../protocol/keyring.md", import.meta.url), "utf8"),
  readFile(new URL("../../protocol/packages.md", import.meta.url), "utf8"),
]);

test("loads the keyring/package hierarchy after connection decorators", () => {
  assert.match(html, /href="core-products\.css"/);
  const home = html.indexOf('src="home-node.js"');
  const beacon = html.indexOf('src="beacon-surface.js"');
  const core = html.indexOf('src="core-products.js"');
  assert.ok(home >= 0 && beacon > home && core > beacon);
  assert.match(runtime, /Keys first\. Packages second\./);
  assert.match(runtime, /data-open-keyring/);
  assert.match(runtime, /data-manage-packages/);
  assert.match(runtime, /data-core-connections/);
});

test("demotes network connections beneath package management without duplicating them", () => {
  assert.match(runtime, /moving the legacy card here also demotes Beacon without duplicating it/);
  assert.match(runtime, /OPTIONAL CONNECTIONS/);
  assert.doesNotMatch(runtime, /new BeaconClient/);
  assert.doesNotMatch(runtime, /new HestiaClient/);
});

test("documents no-key-export and no-remote-code boundaries", () => {
  assert.match(keyringProtocol, /must not receive the underlying key material/);
  assert.match(keyringProtocol, /credential\/get/);
  assert.match(packageProtocol, /cannot be installed as remote extension logic/);
  assert.match(packageProtocol, /Keyring and Package Manager are core host services/);
  assert.match(theme, /var\(--gw-canvas\)/);
  assert.doesNotMatch(theme, /https?:\/\//);
});
