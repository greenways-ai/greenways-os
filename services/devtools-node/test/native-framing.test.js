import assert from "node:assert/strict";
import test from "node:test";
import { NativeMessageDecoder, encodeNativeMessage } from "../src/native-framing.js";

test("round-trips fragmented Chrome native-messaging frames", () => {
  const first = encodeNativeMessage({ type: "one", value: 1 });
  const second = encodeNativeMessage({ type: "two", value: [2] });
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second.subarray(0, 5)])), [{ type: "one", value: 1 }]);
  assert.deepEqual(decoder.push(second.subarray(5)), [{ type: "two", value: [2] }]);
});

test("rejects oversized and invalid native messages", () => {
  const decoder = new NativeMessageDecoder({ limit: 16 });
  const oversized = encodeNativeMessage({ value: "x".repeat(64) });
  assert.throws(() => decoder.push(oversized.subarray(0, 4)), /exceeds/);

  const frame = encodeNativeMessage({ value: 1 });
  const bodyLength = frame.length - 4;
  const invalid = Buffer.concat([frame.subarray(0, 4), Buffer.from("{"), Buffer.alloc(bodyLength - 1, 0x20)]);
  assert.throws(() => new NativeMessageDecoder().push(invalid), /invalid JSON/);
});
