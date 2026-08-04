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

test("Hara owns the installed app lifecycle and emits identifier-only launch effects", async () => {
  const runtime = await start({ resources });
  runtime.require("gw.os.kernel");
  const bootstrap = '(gw.os.kernel/dispatch "app/bootstrap" [])';
  const restored = `(get (gw.os.kernel/dispatch "apps/restore" [${bootstrap} [{"id" "greenways-home" "category" "system" "publisher" {"id" "greenways-ai"} "capabilities" ["identity/local" "storage/local"] "launch" {"handler" "extension-page" "path" "src/studio.html#home"}} {"id" "hestia-connector" "category" "installable" "publisher" {"id" "greenways-ai"} "capabilities" ["hestia/connect" "network/https" "network/loopback" "storage/local"] "launch" {"handler" "packaged-surface" "surfaceId" "hestia-connector"}}]]) "state")`;

  assert.equal(
    runtime.eval(`(get (get ${bootstrap} "apps") "installed")`),
    "[]",
  );
  assert.equal(
    runtime.eval(`(get (gw.os.kernel/dispatch "apps/open" [${restored} "greenways-home"]) "effects")`),
    '[{"effect" "browser" "method" "open-app" "args" ["greenways-home"]}]',
  );
  assert.equal(
    runtime.eval(`(get (gw.os.kernel/dispatch "apps/open" [${restored} "hestia-connector"]) "effects")`),
    '[{"effect" "ui" "method" "open-surface" "args" ["hestia-connector" {"appId" "hestia-connector"}]}]',
  );
  const openedConnector = `(get (gw.os.kernel/dispatch "apps/open" [${restored} "hestia-connector"]) "state")`;
  assert.equal(
    runtime.eval(`(get (get ${openedConnector} "surface") "active")`),
    '"hestia-connector"',
  );
  const refreshedConnector = `(get (gw.os.kernel/dispatch "apps/restore" [${openedConnector} [(first (get (get ${restored} "apps") "installed")) (nth (get (get ${restored} "apps") "installed") 1)]]) "state")`;
  assert.equal(
    runtime.eval(`(get (get ${refreshedConnector} "apps") "active")`),
    '"hestia-connector"',
  );
  assert.match(
    runtime.eval(`(get (gw.os.kernel/dispatch "apps/restore" [${openedConnector} [(first (get (get ${restored} "apps") "installed"))]]) "effects")`),
    /"ui" "method" "close-surface"/,
  );
  assert.match(
    runtime.eval(`(get (gw.os.kernel/dispatch "apps/remove" [${openedConnector} "hestia-connector"]) "effects")`),
    /"ui" "method" "close-surface"/,
  );
  assert.equal(
    runtime.eval(`(get (get (get (gw.os.kernel/dispatch "surface/close" [${openedConnector}]) "state") "apps") "active")`),
    "nil",
  );

  const hostileManifest = '{"id" "historia" "category" "installable" "launch" {"handler" "web-tab" "url" "javascript:alert(1)" "code" "steal()"}}';
  const installed = `(get (gw.os.kernel/dispatch "apps/install" [${bootstrap} ${hostileManifest}]) "state")`;
  assert.equal(
    runtime.eval(`(get (get (first (get (get ${installed} "apps") "installed")) "launch") "url")`),
    "nil",
  );
  assert.equal(
    runtime.eval(`(get (gw.os.kernel/dispatch "apps/open" [${installed} "historia"]) "effects")`),
    '[{"effect" "browser" "method" "open-app" "args" ["historia"]}]',
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/open" [${bootstrap} "historia"])`),
    /App is not installed/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/remove" [${restored} "greenways-home"])`),
    /System apps cannot be removed/,
  );
  const forgedSystemState = `(assoc ${bootstrap} "apps" {"installed" [{"id" "greenways-home" "category" "installable" "launch" {"handler" "web-tab"}}] "active" nil})`;
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/remove" [${forgedSystemState} "greenways-home"])`),
    /System apps cannot be removed/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/install" [${bootstrap} {"id" "fake-system" "category" "system" "launch" {"handler" "extension-page"}}])`),
    /Only reserved app ids can use the system category/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/install" [${bootstrap} {"id" "remote-surface" "category" "installable" "launch" {"handler" "packaged-surface" "surfaceId" "https:\/\/remote.invalid\/code"}}])`),
    /Packaged app surface is not installed/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/install" [${bootstrap} {"id" "connector-alias" "category" "installable" "publisher" {"id" "greenways-ai"} "capabilities" ["hestia/connect" "network/https" "network/loopback" "storage/local"] "launch" {"handler" "packaged-surface" "surfaceId" "hestia-connector"}}])`),
    /Packaged app surface does not match the app id/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/install" [${bootstrap} {"id" "hestia-connector" "category" "installable" "publisher" {"id" "third-party"} "capabilities" ["hestia/connect" "network/https" "network/loopback" "storage/local"] "launch" {"handler" "packaged-surface" "surfaceId" "hestia-connector"}}])`),
    /Packaged app surface publisher is not trusted/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/install" [${bootstrap} {"id" "hestia-connector" "category" "installable" "publisher" {"id" "greenways-ai"} "capabilities" ["hestia/connect" "network/loopback"] "launch" {"handler" "packaged-surface" "surfaceId" "hestia-connector"}}])`),
    /Packaged app surface capabilities are incomplete/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/restore" [${bootstrap} [{"id" "greenways-home" "category" "system" "publisher" {"id" "attacker"} "capabilities" ["identity/local" "storage/local"] "launch" {"handler" "extension-page" "path" "src/studio.html#home"}}]])`),
    /System app publisher is not trusted/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/restore" [${bootstrap} [{"id" "greenways-home" "category" "system" "publisher" {"id" "greenways-ai"} "capabilities" ["identity/local" "storage/local" "tabs/open"] "launch" {"handler" "extension-page" "path" "src/studio.html#home"}}]])`),
    /System app capabilities are not bound to its id/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/restore" [${bootstrap} [{"id" "fake-system" "category" "system" "launch" {"handler" "extension-page"}}]])`),
    /Only reserved app ids can use the system category/,
  );
  assert.throws(
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/restore" [${bootstrap} [{"id" "greenways-home" "category" "installable" "launch" {"handler" "web-tab"}}]])`),
    /Reserved system app ids must use the system category/,
  );
});

test("HAL transport rejects invalid and circular host values with their path", () => {
  assert.throws(() => encodeHalValue({ graph: { scale: Number.NaN } }), /\.graph\.scale must be a finite number/);
  const value = { graph: {} };
  value.graph.parent = value;
  assert.throws(() => encodeHalValue(value), /\.graph\.parent contains a circular reference/);
});
