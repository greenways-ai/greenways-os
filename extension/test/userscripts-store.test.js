import assert from "node:assert/strict";
import test from "node:test";
import {
  USERSCRIPT_LIMITS,
  USERSCRIPT_RECORD_PROTOCOL,
  USERSCRIPTS_APP_ID,
  USERSCRIPTS_CAPABILITY,
  userscriptProjectionEntries,
  validateUserscriptCollection,
  validateUserscriptRecord,
} from "../src/userscripts-store.js";

function record(overrides = {}) {
  return {
    protocol: USERSCRIPT_RECORD_PROTOCOL,
    id: "script/abc123",
    name: "Dim example pages",
    matches: ["https://example.com/*"],
    runAt: "document_idle",
    enabled: false,
    source: "document.documentElement.style.filter = 'brightness(0.8)';",
    digest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
    ...overrides,
  };
}

test("accepts a bounded, plain userscript record", () => {
  const output = validateUserscriptRecord(record());
  assert.equal(output.protocol, USERSCRIPT_RECORD_PROTOCOL);
  assert.equal(output.id, "script/abc123");
  assert.deepEqual(output.matches, ["https://example.com/*"]);
  assert.ok(Object.isFrozen(output));
  assert.ok(Object.isFrozen(output.matches));
});

test("rejects unsupported protocols, ids, and fields", () => {
  assert.throws(() => validateUserscriptRecord(record({ protocol: "greenways-userscript/0" })), /protocol/);
  assert.throws(() => validateUserscriptRecord(record({ id: "Script/ABC" })), /id/);
  assert.throws(() => validateUserscriptRecord(record({ id: "script/" })), /id/);
  assert.throws(() => validateUserscriptRecord(record({ extra: true })), /unsupported field/);
  assert.throws(() => validateUserscriptRecord(record({ enabled: "yes" })), /enabled/);
});

test("accepts only http(s) Chrome match patterns", () => {
  for (const matches of [
    ["javascript:alert(1)"],
    ["file:///etc/passwd"],
    ["ftp://example.com/*"],
    ["https://"],
    ["https://example.com"],
    ["http://exa mple.com/*"],
  ]) {
    assert.throws(() => validateUserscriptRecord(record({ matches })), /match pattern/i, matches[0]);
  }
  const output = validateUserscriptRecord(record({
    matches: ["*://*.example.com/*", "http://example.com/path/*", "https://*/*"],
  }));
  assert.equal(output.matches.length, 3);
  assert.throws(() => validateUserscriptRecord(record({ matches: [] })), /cannot be empty/);
  assert.throws(
    () => validateUserscriptRecord(record({ matches: ["https://example.com/*", "https://example.com/*"] })),
    /duplicates/,
  );
  assert.throws(
    () => validateUserscriptRecord(record({ matches: Array.from({ length: USERSCRIPT_LIMITS.matches + 1 }, (_, index) => `https://e${index}.example.com/*`) })),
    /match patterns/,
  );
});

test("bounds run-at, source, and timestamps", () => {
  assert.throws(() => validateUserscriptRecord(record({ runAt: "document_middle" })), /run-at/);
  assert.throws(() => validateUserscriptRecord(record({ source: "" })), /source/);
  assert.throws(() => validateUserscriptRecord(record({ source: "x".repeat(USERSCRIPT_LIMITS.sourceBytes + 1) })), /source/);
  assert.throws(() => validateUserscriptRecord(record({ digest: "sha256:nope" })), /digest/);
  assert.throws(() => validateUserscriptRecord(record({ updatedAt: "2026-08-06T00:00:00.000Z" })), /updatedAt/);
  assert.throws(() => validateUserscriptRecord(record({ createdAt: "yesterday" })), /timestamp/);
});

test("bounds collections and rejects duplicate ids", () => {
  assert.deepEqual(validateUserscriptCollection([]), []);
  const many = Array.from({ length: USERSCRIPT_LIMITS.scripts + 1 }, (_, index) => record({ id: `script/s${index}` }));
  assert.throws(() => validateUserscriptCollection(many), /32 scripts/);
  assert.throws(
    () => validateUserscriptCollection([record(), record()]),
    /unique/,
  );
});

test("projects records into store entries", () => {
  const entries = userscriptProjectionEntries([record()]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0][0], "script/abc123");
  assert.equal(entries[0][1].name, "Dim example pages");
});

test("exposes the bound app identity", () => {
  assert.equal(USERSCRIPTS_APP_ID, "userscripts");
  assert.equal(USERSCRIPTS_CAPABILITY, "userscripts/manage");
});
