import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("launcher lifecycle controls stay disabled until startup initialization completes", async () => {
  const source = await readFile(new URL("../src/launcher.js", import.meta.url), "utf8");
  const start = source.indexOf("async function start()");
  const hydration = source.indexOf("await session.start();", start);
  const ready = source.indexOf("kernelReady = true;", hydration);

  assert.match(source, /let kernelReady = false;/);
  assert.match(source, /kernelReady \? "" : ' disabled aria-disabled="true"'/);
  assert.ok(start >= 0 && hydration > start, "startup must await kernel hydration");
  assert.ok(ready > hydration, "lifecycle controls must become ready only after hydration");
});
