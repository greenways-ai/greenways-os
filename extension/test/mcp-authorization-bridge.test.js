import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/mcp-authorization-bridge.js", import.meta.url), "utf8");

test("requires the inert challenge and reviewed assertion field", () => {
  assert.match(source, /greenways-mcp-pairing-challenge/);
  assert.match(source, /data-greenways-mcp-assertion/);
  assert.match(source, /Approve with Greenways OS/);
  assert.match(source, /operation:\s*"approve"/);
});

test("never submits, clicks, intercepts requests, or reads browser credentials", () => {
  assert.doesNotMatch(source, /requestSubmit\s*\(/);
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|chrome\.cookies|webRequest/);
  assert.doesNotMatch(source, /Authorization\s*[:=]|Bearer\s+|access[_-]?token|api[_-]?key/i);
});
