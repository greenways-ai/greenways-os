import assert from "node:assert/strict";
import test from "node:test";
import { start } from "../src/hara-vm.mjs";
import { createHalModuleRuntime } from "../src/hal-module-runtime.js";

const LOCK_A = `sha256:${"a".repeat(64)}`;
const LOCK_B = `sha256:${"b".repeat(64)}`;

test("real Wasm installs, invokes, and reloads a HAL module generation", async () => {
  const runtime = await start({ resources: {} });
  for (const method of ["currentNamespace", "evalInNamespace", "registerResource", "require"]) {
    assert.equal(typeof runtime[method], "function");
  }
  const modules = createHalModuleRuntime(runtime);
  modules.installModule({
    id: "fixture",
    lockDigest: LOCK_A,
    entry: "fixture.app/view",
    resources: {
      "fixture.app": '(ns fixture.app) (defn view [value] {"type" "text" "text" value})',
    },
  });
  assert.match(modules.invoke("fixture", ['"one"']), /"one"/);
  assert.equal(modules.get("fixture").root, "app.fixture.g1");

  modules.reloadModule("fixture", {
    id: "fixture",
    lockDigest: LOCK_B,
    entry: "fixture.app/view",
    resources: {
      "fixture.app": '(ns fixture.app) (defn view [value] {"type" "status" "tone" "success" "text" value})',
    },
  });
  assert.match(modules.invoke("fixture", ['"two"']), /"success"/);
  assert.equal(modules.get("fixture").root, "app.fixture.g2");
  assert.equal(modules.get("fixture").lockDigest, LOCK_B);
});
