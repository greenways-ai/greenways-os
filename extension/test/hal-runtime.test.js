import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { start } from "../src/hara-vm.mjs";
import { encodeHalValue } from "../src/hal-transport.js";
import {
  CAPABILITY_DEFINITIONS,
  CORE_SERVICES,
} from "../src/core-services.js";

const resources = {
  "gw.os.adaptor": fs.readFileSync(new URL("../../src/gw/os/adaptor.hal", import.meta.url), "utf8"),
  "gw.os.kernel": fs.readFileSync(new URL("../../src/gw/os/kernel.hal", import.meta.url), "utf8"),
  "gw.os.services": fs.readFileSync(new URL("../../src/gw/os/services.hal", import.meta.url), "utf8"),
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

  const oldConnector = '{"id" "hestia-connector" "version" "0.2.0" "category" "installable" "publisher" {"id" "greenways-ai"} "capabilities" ["hestia/connect" "network/https" "network/loopback" "storage/local"] "launch" {"handler" "packaged-surface" "surfaceId" "hestia-connector"}}';
  const newConnector = '{"id" "hestia-connector" "version" "0.3.0" "category" "installable" "publisher" {"id" "greenways-ai"} "capabilities" ["hestia/connect" "network/https" "network/loopback" "storage/local"] "launch" {"handler" "packaged-surface" "surfaceId" "hestia-connector"}}';
  const oldInstalled = `(get (gw.os.kernel/dispatch "apps/install" [${bootstrap} ${oldConnector}]) "state")`;
  assert.equal(
    runtime.eval(`(get (first (get (get (get (gw.os.kernel/dispatch "apps/update" [${oldInstalled} ${newConnector}]) "state") "apps") "installed")) "version")`),
    '"0.3.0"',
  );

  const historiaManifest = '{"id" "historia" "category" "installable" "publisher" {"id" "greenways-ai"} "capabilities" ["historia/import" "network/loopback" "tabs/open"] "launch" {"handler" "native-hybrid" "url" "http://127.0.0.1:4319/"}}';
  const installed = `(get (gw.os.kernel/dispatch "apps/install" [${bootstrap} ${historiaManifest}]) "state")`;
  assert.equal(
    runtime.eval(`(get (get (first (get (get ${installed} "apps") "installed")) "launch") "url")`),
    '"http://127.0.0.1:4319/"',
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
    () => runtime.eval(`(gw.os.kernel/dispatch "apps/install" [${bootstrap} {"id" "historia" "category" "installable" "launch" {"handler" "native-hybrid" "url" "http:\/\/127.0.0.1:9999\/"}}])`),
    /URL is not bound/,
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
    /Packaged app surface capabilities are not bound/,
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

test("Hara exposes resident core services and owns capability grant transitions", async () => {
  const runtime = await start({ resources });
  runtime.require("gw.os.kernel");

  assert.equal(
    runtime.eval('(count (gw.os.kernel/dispatch "core/services" []))'),
    "10",
  );
  assert.equal(
    runtime.eval('(get (first (gw.os.kernel/dispatch "core/services" [])) "id")'),
    '"kernel"',
  );
  assert.equal(
    runtime.eval('(get (gw.os.services/capability-definition "key/sign") "service")'),
    '"keyring"',
  );
  assert.equal(
    runtime.eval(`(= (gw.os.kernel/dispatch "core/services" []) ${encodeHalValue(CORE_SERVICES)})`),
    "true",
  );
  const capabilityProjection = CAPABILITY_DEFINITIONS.map((definition) => ({
    protocol: definition.protocol,
    id: definition.id,
    service: definition.service,
    risk: definition.risk,
    grantable: definition.grantable,
    trustedPublishers: definition.trustedPublishers,
  }));
  assert.equal(
    runtime.eval(`(= (gw.os.kernel/dispatch "capabilities/vocabulary" []) ${encodeHalValue(capabilityProjection)})`),
    "true",
  );

  const bootstrap = '(gw.os.kernel/dispatch "app/bootstrap" [])';
  const digest = `sha256:${"a".repeat(64)}`;
  const moduleManifest = `{"protocol" "greenways-app/1"
    "id" "signing-room"
    "version" "0.1.0"
    "publisher" {"id" "example" "name" "Example"}
    "name" "Signing room"
    "description" "Exercises an exact key grant."
    "category" "installable"
    "capabilities" ["hara/module" "key/sign"]
    "launch" {"handler" "hal-module"}
    "kind" "hal-module"
    "channel" "preview"
    "lockDigest" "${digest}"
    "source" {"kind" "github" "owner" "example" "repo" "signing-room" "sha" "${"b".repeat(40)}"}}`;
  const installed = `(get (gw.os.kernel/dispatch "apps/install" [${bootstrap} ${moduleManifest}]) "state")`;
  const grant = `{"protocol" "greenways-capability-grant/1"
    "id" "grant/signing-room-0001"
    "subject" {"kind" "app" "appId" "signing-room" "version" "0.1.0" "publisherId" "example" "lockDigest" "${digest}"}
    "capability" "key/sign"
    "constraints" {"purpose" "publication-receipt"}
    "issuedAt" "2026-08-06T00:00:00.000Z"
    "expiresAt" nil
    "revokedAt" nil}`;
  const granted = `(get (gw.os.kernel/dispatch "capabilities/grant" [${installed} ${grant}]) "state")`;

  assert.equal(
    runtime.eval(`(get (first (get (get ${granted} "capabilities") "grants")) "capability")`),
    '"key/sign"',
  );
  assert.equal(
    runtime.eval(`(get (gw.os.kernel/dispatch "capabilities/check" [${granted} "signing-room" "key/sign" "2026-08-06T00:30:00.000Z"]) "id")`),
    '"grant/signing-room-0001"',
  );
  assert.match(
    runtime.eval(`(get (gw.os.kernel/dispatch "capabilities/grant" [${installed} ${grant}]) "effects")`),
    /"save-grants"/,
  );

  const removedResult = `(gw.os.kernel/dispatch "apps/remove" [${granted} "signing-room" "2026-08-06T00:45:00.000Z"])`;
  const removed = `(get ${removedResult} "state")`;
  assert.equal(
    runtime.eval(`(get (first (get (get ${removed} "capabilities") "grants")) "revokedAt")`),
    '"2026-08-06T00:45:00.000Z"',
  );
  assert.match(runtime.eval(`(get ${removedResult} "effects")`), /"save-grants"/);
  const restoredAfterRemoval = `(get (gw.os.kernel/dispatch "apps/restore" [${removed} [${moduleManifest}]]) "state")`;
  assert.equal(
    runtime.eval(`(gw.os.kernel/dispatch "capabilities/check" [${restoredAfterRemoval} "signing-room" "key/sign" "2026-08-06T01:00:00.000Z"])`),
    "nil",
  );

  const revoked = `(get (gw.os.kernel/dispatch "capabilities/revoke" [${granted} "grant/signing-room-0001" "2026-08-06T01:00:00.000Z"]) "state")`;
  assert.equal(
    runtime.eval(`(gw.os.kernel/dispatch "capabilities/check" [${revoked} "signing-room" "key/sign" "2026-08-06T01:30:00.000Z"])`),
    "nil",
  );
});
