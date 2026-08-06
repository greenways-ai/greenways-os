import assert from "node:assert/strict";
import test from "node:test";
import { RespCommandDecoder, respBulk, respError, respJson, respSimple } from "../src/resp.js";

function command(...args) {
  return Buffer.from(`*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`);
}

test("parses fragmented RESP2 command arrays", () => {
  const source = command("GW.EVAL", "gw.devtools", "(+ 20 22)");
  const decoder = new RespCommandDecoder();
  assert.deepEqual(decoder.push(source.subarray(0, 7)), []);
  assert.deepEqual(decoder.push(source.subarray(7)), [["GW.EVAL", "gw.devtools", "(+ 20 22)"]]);
});

test("supports simple inline diagnostics while bounding requests", () => {
  const decoder = new RespCommandDecoder();
  assert.deepEqual(decoder.push(Buffer.from("PING hello\r\n")), [["PING", "hello"]]);
  assert.throws(() => decoder.push(Buffer.alloc(1024 * 1024 + 1)), /exceeds/);
});

test("encodes simple, error, bulk, and JSON replies", () => {
  assert.equal(respSimple("OK").toString(), "+OK\r\n");
  assert.equal(respError("bad\nthing").toString(), "-ERR bad thing\r\n");
  assert.equal(respBulk("λ").toString(), "$2\r\nλ\r\n");
  assert.equal(respJson({ answer: 42 }).toString(), '$13\r\n{"answer":42}\r\n');
});
