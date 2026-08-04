import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { start } from "../src/hara-vm.mjs";
import { encodeHalValue } from "../src/hal-transport.js";

const resources = {
  "gw.os.adaptor": fs.readFileSync(new URL("../../src/gw/os/adaptor.hal", import.meta.url), "utf8"),
  "gw.os.kernel": fs.readFileSync(new URL("../../src/gw/os/kernel.hal", import.meta.url), "utf8"),
};

test("browser VM exposes the HAL kernel through its generated adaptor surface", async () => {
  const runtime = await start({ resources });
  runtime.require("gw.os.kernel");
  assert.equal(
    runtime.eval('(get (get gw.os.kernel/SURFACE "workflow/transition") "action")'),
    '"@greenways/workflow/transition"',
  );
  assert.equal(
    runtime.eval('(gw.os.kernel/dispatch "catalog/search" [[{"name" "apartment"} {"name" "splat-garden"}] "garden"])'),
    '[{"name" "splat-garden"}]',
  );
});

test("host objects are encoded as EDN maps for HAL dispatch", async () => {
  const runtime = await start({ resources });
  runtime.require("gw.os.kernel");
  const graph = {
    repository: { owner: "greenways-worlds", repo: "playbot", url: "https://github.com/greenways-worlds/playbot" },
    layers: [{ id: "playbot", assetUrl: "https://raw.githubusercontent.com/greenways-worlds/playbot/commit/world/playbot/lod-meta.json" }],
    diagnostics: []
  };
  const source = `(gw.os.kernel/dispatch "world/render" ${encodeHalValue([graph])})`;
  const result = runtime.eval(source);
  assert.match(result, /"scene"/);
  assert.match(result, /"render-world"/);
});

test("Hara carries touchpoint and studio track state", async () => {
  const runtime = await start({ resources });
  runtime.require("gw.os.kernel");
  const opening = runtime.eval('(gw.os.kernel/dispatch "world/touchpoint" [(gw.os.kernel/dispatch "app/bootstrap" []) {"id" "console" "surface" "studio" "label" "Open studio"}])');
  assert.match(opening, /"active" "studio"/);
  assert.match(opening, /"open-surface"/);
  const imported = runtime.eval('(gw.os.kernel/dispatch "studio/add-track" [(gw.os.kernel/dispatch "app/bootstrap" []) {"id" "local:1" "name" "Piano.wav" "size" 42}])');
  assert.match(imported, /"tracks" \[\{"id" "local:1"/);
  const exported = runtime.eval('(gw.os.kernel/dispatch "studio/export-project" [(get (gw.os.kernel/dispatch "studio/add-track" [(gw.os.kernel/dispatch "app/bootstrap" []) {"id" "local:1" "name" "Piano.wav" "size" 42}]) "state")])');
  assert.match(exported, /"export"/);
  assert.match(exported, /"studio-project"/);
});

test("HAL transport rejects invalid and circular host values with their path", () => {
  assert.throws(() => encodeHalValue({ graph: { scale: Number.NaN } }), /\.graph\.scale must be a finite number/);
  const value = { graph: {} };
  value.graph.parent = value;
  assert.throws(() => encodeHalValue(value), /\.graph\.parent contains a circular reference/);
});
