import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(path, import.meta.url), "utf8");

const [html, theme, themeRuntime, launcher, greenwaysMark, hestiaMark, historiaMark] =
  await Promise.all([
    source("../src/launcher.html"),
    source("../src/visual-language.css"),
    source("../src/visual-language.js"),
    source("../src/launcher.css"),
    source("../src/assets/brand/greenways-small.svg"),
    source("../src/assets/brand/hestia-small.svg"),
    source("../src/assets/brand/historia-small.svg"),
  ]);

test("launcher declares the Greenways visual-language shell", () => {
  assert.match(html, /data-project="greenways"/);
  assert.match(html, /href="visual-language\.css"/);
  assert.match(html, /src="visual-language\.js"/);
  assert.match(html, /href="assets\/brand\/greenways-small\.svg"/);
  assert.match(html, /data-theme-toggle/);
});

test("shared extension tokens provide adaptive day and night material", () => {
  assert.match(theme, /--gw-canvas:\s*#f4f2ec/);
  assert.match(theme, /:root\[data-theme="dark"\]/);
  assert.match(theme, /--gw-canvas:\s*#050a08/);
  assert.match(theme, /--gw-verdigris:\s*#33a878/);
  assert.match(theme, /prefers-reduced-motion/);
});

test("theme control switches day and night in one click", () => {
  assert.match(themeRuntime, /const THEME_KEY = "gw-theme"/);
  assert.match(
    themeRuntime,
    /resolvedTheme === "dark" \? "light" : "dark"/,
  );
  assert.match(themeRuntime, /event\.shiftKey \? "auto"/);
  assert.match(themeRuntime, /localStorage\.setItem\(THEME_KEY/);
});

test("launcher uses canonical project sigils and no legacy forest palette", () => {
  assert.match(launcher, /assets\/brand\/greenways-small\.svg/);
  assert.match(launcher, /assets\/brand\/hestia-small\.svg/);
  assert.match(launcher, /assets\/brand\/historia-small\.svg/);
  assert.match(launcher, /assets\/brand\/hara-logo\.svg/);
  assert.match(launcher, /var\(--gw-canvas\)/);
  assert.doesNotMatch(launcher, /--night|--forest|--moss|--glass/);
});

test("bundled visual marks are local SVG assets", () => {
  for (const mark of [greenwaysMark, hestiaMark, historiaMark]) {
    assert.match(mark, /^<svg/);
    assert.match(mark, /viewBox="0 0 480 480"/);
    assert.doesNotMatch(mark, /<(?:image|script)\b/i);
    assert.doesNotMatch(mark, /url\(/i);
  }
  assert.match(greenwaysMark, /M240 90C395/);
  assert.match(hestiaMark, /M240 80L276\.7/);
  assert.match(historiaMark, /M50 390 180 160 310 390/);
});
