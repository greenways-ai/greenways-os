import assert from "node:assert/strict";
import test from "node:test";
import { getBuiltinAppCatalog } from "../src/app-catalog.js";
import {
  PACKAGE_MANAGER_PROTOCOL,
  PACKAGE_PROTOCOL,
  packageInventory,
  packageKindLabel,
  projectPackageCatalog,
} from "../src/package-manager.js";

const BUILTIN_APP_CATALOG = await getBuiltinAppCatalog();

test("projects the reviewed app catalogue as Greenways packages", () => {
  const packages = projectPackageCatalog(BUILTIN_APP_CATALOG);
  assert.equal(packages.length, 6);
  assert.ok(packages.every(({ protocol }) => protocol === PACKAGE_PROTOCOL));
  assert.deepEqual(packages.map(({ kind }) => kind), [
    "system",
    "bundled-module",
    "bundled-module",
    "bundled-module",
    "bundled-module",
    "web-application",
  ]);
  assert.ok(Object.isFrozen(packages));
  assert.ok(packages.every(Object.isFrozen));
});

test("reports installed, available, and update approval states", () => {
  const home = BUILTIN_APP_CATALOG.find(({ id }) => id === "greenways-worlds");
  const oldHestia = {
    ...BUILTIN_APP_CATALOG.find(({ id }) => id === "chats"),
    version: "0.1.0",
  };
  const inventory = packageInventory(BUILTIN_APP_CATALOG, [home, oldHestia]);
  assert.equal(inventory.protocol, PACKAGE_MANAGER_PROTOCOL);
  assert.equal(inventory.installed, 1);
  assert.equal(inventory.updates, 1);
  assert.equal(inventory.available, 4);
  assert.equal(inventory.entries.find(({ id }) => id === "chats").status, "update-available");
  assert.equal(inventory.entries.find(({ id }) => id === "mcp-access").status, "available");
});

test("uses product labels rather than treating every binding as a generic app", () => {
  assert.equal(packageKindLabel("system"), "SYSTEM PACKAGE");
  assert.equal(packageKindLabel("bundled-module"), "BUNDLED PACKAGE");
  assert.equal(packageKindLabel("companion"), "COMPANION PACKAGE");
  assert.equal(packageKindLabel("web-application"), "WEB PACKAGE");
  assert.throws(() => packageKindLabel("remote-code"), /Unsupported package kind/);
});
