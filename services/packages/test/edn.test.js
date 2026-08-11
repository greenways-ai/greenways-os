import assert from "node:assert/strict";
import test from "node:test";
import { encodeEdn } from "../src/edn.js";

test("encodes registry data deterministically with sorted keyword keys", () => {
  assert.equal(
    encodeEdn({ z: 2, "index/protocol": "greenways-registry-index/0-alpha", packages: { "greenways:notes": { version: "1.0.0" } } }),
    '{:index/protocol "greenways-registry-index/0-alpha" :packages {"greenways:notes" {:version "1.0.0"}} :z 2}',
  );
});

test("rejects unsupported and non-finite values", () => {
  assert.throws(() => encodeEdn(Number.NaN), /non-finite/);
  assert.throws(() => encodeEdn(new Date()), /plain objects/);
  assert.throws(() => encodeEdn(undefined), /cannot encode/);
});
