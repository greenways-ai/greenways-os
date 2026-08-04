import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [html, homeNodeRuntime, homeNodeTheme, protocol] = await Promise.all([
  source("../src/launcher.html"),
  source("../src/home-node.js"),
  source("../src/home-node.css"),
  source("../../protocol/home-node.md"),
]);

test("launcher promotes the Hestia Home Node above applications", () => {
  assert.match(html, /href="home-node\.css"/);
  assert.match(html, /src="home-node\.js"/);
  assert.match(homeNodeRuntime, /HOME NODE \/ PRIVATE SERVICE HOST/);
  assert.match(homeNodeRuntime, /Give your browsers a home you control\./);
  assert.match(homeNodeRuntime, /data-home-node-action/);
});

test("home-node presentation extends the canonical Greenways language", () => {
  assert.match(homeNodeTheme, /var\(--gw-canvas\)|var\(--gw-surface\)/);
  assert.match(homeNodeTheme, /assets\/brand\/hestia-small\.svg/);
  assert.match(homeNodeTheme, /var\(--launcher-hestia\)/);
  assert.doesNotMatch(homeNodeTheme, /--night|--forest|--moss|--glass|--hara-/);
  assert.doesNotMatch(homeNodeTheme, /https?:\/\//);
});

test("home-node control composes with the reviewed launcher", () => {
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
