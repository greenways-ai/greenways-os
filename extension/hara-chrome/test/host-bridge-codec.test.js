import assert from "node:assert/strict";
import { test } from "node:test";
import { HtaKeyword, HtaSymbol } from "../vendor/hta.js";
import { fromPlain, toPlain } from "../src/host-bridge.js";

test("runtime Port codec preserves Hara keywords, symbols, maps, sets, and bytes", () => {
  const value = new Map([
    [new HtaKeyword("state"), new HtaKeyword("ready")],
    [new HtaSymbol("x"), new Set([1, 2])],
    [new HtaKeyword("bytes"), new Uint8Array([1, 2, 3])],
  ]);
  const plain = toPlain(value);
  assert.equal(plain.__haraValue, "map");
  const restored = fromPlain(structuredClone(plain));
  assert.equal(restored instanceof Map, true);
  const entries = [...restored.entries()];
  assert.equal(entries[0][0] instanceof HtaKeyword, true);
  assert.equal(entries[0][1] instanceof HtaKeyword, true);
  assert.equal(entries[1][0] instanceof HtaSymbol, true);
  assert.equal(entries[1][1] instanceof Set, true);
  assert.equal(entries[2][1] instanceof Uint8Array, true);
  assert.deepEqual([...entries[2][1]], [1, 2, 3]);
});
