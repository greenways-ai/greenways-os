import assert from "node:assert/strict";
import test from "node:test";
import {
  ROOT_APP_PROTOCOL,
  ROOT_APPS,
  getRootApp,
  resolveRootAppUrl,
} from "../src/root-apps.js";

test("publishes one fixed preinstalled root DevTools app", () => {
  assert.equal(ROOT_APP_PROTOCOL, "greenways-root-app/1");
  assert.deepEqual(ROOT_APPS.map(({ id }) => id), ["greenways-devtools"]);
  const devtools = getRootApp("greenways-devtools");
  assert.equal(devtools.preinstalled, true);
  assert.equal(devtools.removable, false);
  assert.deepEqual(devtools.authority, ["kernel/inspect", "kernel/evaluate", "devtools/bridge"]);
  assert.ok(Object.isFrozen(ROOT_APPS));
  assert.ok(Object.isFrozen(devtools));
  assert.ok(Object.isFrozen(devtools.authority));
});

test("root app URLs resolve only to packaged extension pages", () => {
  const runtime = { getURL: (path) => `chrome-extension://root/${path}` };
  assert.equal(
    resolveRootAppUrl("greenways-devtools", runtime),
    "chrome-extension://root/src/devtools.html",
  );
  assert.throws(() => resolveRootAppUrl("missing", runtime), /Unknown Greenways root app/);
  assert.throws(() => resolveRootAppUrl("greenways-devtools", {}), /runtime is unavailable/);
});
