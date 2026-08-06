import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [html, homeNodeRuntime, homeNodeTheme, beaconRuntime, protocol] = await Promise.all([
  source("../src/launcher.html"),
  source("../src/home-node.js"),
  source("../src/home-node.css"),
  source("../src/beacon-surface.js"),
  source("../../protocol/home-node.md"),
]);

test("launcher demotes Home Link as migration support without breaking its control", () => {
  assert.match(html, /href="beacon\.css"/);
  assert.match(html, /src="beacon-surface\.js"/);
  assert.match(html, /href="home-node\.css"/);
  assert.match(html, /src="home-node\.js"/);
  assert.match(homeNodeRuntime, /LEGACY HOME LINK \/ DEVICE MIGRATION/);
  assert.match(homeNodeRuntime, /Give your browsers a home you control\./);
  assert.match(homeNodeRuntime, /Enable the old connector only when preserving or exporting/);
  assert.match(homeNodeRuntime, /Greenways Beacon/);
  assert.match(homeNodeRuntime, /data-home-node-action/);
  assert.match(beaconRuntime, /data-beacon/);
  assert.match(beaconRuntime, /A local way into Greenways Space\./);
});

test("home-node presentation extends the canonical Greenways language", () => {
  assert.match(homeNodeTheme, /var\(--gw-canvas\)|var\(--gw-surface\)/);
  assert.match(homeNodeTheme, /assets\/brand\/hestia-small\.svg/);
  assert.match(homeNodeTheme, /var\(--launcher-hestia\)/);
  assert.doesNotMatch(homeNodeTheme, /--night|--forest|--moss|--glass|--hara-/);
  assert.doesNotMatch(homeNodeTheme, /https?:\/\//);
});

test("legacy home-node control composes with the reviewed connector", () => {
  assert.match(homeNodeRuntime, /\[data-install-app\]/);
  assert.match(homeNodeRuntime, /\[data-open-app\]/);
  assert.match(homeNodeRuntime, /store\.get\("settings", "hestia"\)/);
  assert.doesNotMatch(homeNodeRuntime, /new KernelClient|requestOriginAccess|deviceToken/);
});

test("home link remains transport-independent and local-first", () => {
  assert.match(protocol, /Home Link is an application protocol/);
  assert.match(protocol, /Tailscale, Headscale, WireGuard/);
  assert.match(protocol, /route providers, not as identity or\s+application authorization/);
  assert.match(protocol, /unavailable node never prevents local app launch/);
  assert.match(protocol, /Native Messaging/);
});
