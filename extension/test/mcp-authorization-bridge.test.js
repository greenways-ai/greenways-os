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

test("never submits, clicks, or reads browser credential state", () => {
  assert.doesNotMatch(source, /requestSubmit\s*\(/);
  assert.doesNotMatch(source, /\.submit\s*\(/);
  assert.doesNotMatch(source, /\.click\s*\(/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie/);
  assert.doesNotMatch(source, /Authorization|Bearer|access[_-]?token|api[_-]?key/i);
});
