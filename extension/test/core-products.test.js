import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEVTOOLS_ROUTES,
  LAUNCHER_ROUTES,
  routeFromHash,
  sidebarMarkup,
} from "../src/app-shell.js";

const [html, launcher, shell, keyringSurface, devtools, keyringProtocol, packageProtocol] = await Promise.all([
  readFile(new URL("../src/launcher.html", import.meta.url), "utf8"),
  readFile(new URL("../src/launcher.js", import.meta.url), "utf8"),
  readFile(new URL("../src/app-shell.css", import.meta.url), "utf8"),
  readFile(new URL("../src/keyring-surface.css", import.meta.url), "utf8"),
  readFile(new URL("../src/devtools.js", import.meta.url), "utf8"),
  readFile(new URL("../../protocol/keyring.md", import.meta.url), "utf8"),
  readFile(new URL("../../protocol/packages.md", import.meta.url), "utf8"),
]);

test("launcher and DevTools share one compact settings navigation", () => {
  assert.match(html, /href="app-shell\.css"/);
  assert.match(html, /href="keyring-surface\.css"/);
  assert.doesNotMatch(html, /core-products|core-order|beacon-surface/);
  const navigation = sidebarMarkup("developer");
  for (const label of ["Home", "Apps", "Connections", "General", "Keyring", "Kernel", "Developer", "RESP Bridge", "About"]) {
    assert.match(navigation, new RegExp(`>${label}<`));
  }
  assert.match(navigation, /data-route="developer" aria-current="page"/);
  assert.equal(routeFromHash("#apps", LAUNCHER_ROUTES, "home"), "apps");
  assert.equal(routeFromHash("#bridge", DEVTOOLS_ROUTES, "kernel"), "bridge");
});

test("uses compact system-adaptive groups instead of website heroes", () => {
  assert.match(shell, /grid-template-columns: 210px/);
  assert.match(shell, /prefers-color-scheme: dark/);
  assert.match(shell, /@media \(max-width: 720px\)/);
  assert.match(shell, /-apple-system/);
  assert.match(keyringSurface, /\.keyring-overlay/);
  assert.match(launcher, /renderedRoute !== route/);
  assert.match(launcher, /function homePage/);
  assert.match(launcher, /function appsPage/);
  assert.match(launcher, /function connectionsPage/);
  assert.doesNotMatch(launcher, /Program the OS|Your browser,<br>/);
  assert.doesNotMatch(devtools, /devtools-hero|PREINSTALLED ROOT APP/);
});

test("keeps keyring, package, and privileged developer boundaries explicit", () => {
  assert.match(launcher, /openKeyringSurface/);
  assert.match(launcher, /data-install-app/);
  assert.match(devtools, /clientKind: "devtools"/);
  assert.match(devtools, /devtools\/eval/);
  assert.match(keyringProtocol, /must not receive the underlying key material/);
  assert.match(packageProtocol, /cannot be installed as remote extension logic/);
});
