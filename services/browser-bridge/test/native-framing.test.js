import assert from "node:assert/strict";
import test from "node:test";
import { encodeNativeMessage, NativeMessageDecoder } from "../src/native-framing.js";

test("decodes split and adjacent Chrome native messages", () => {
  const first = encodeNativeMessage({ one: 1 });
  const second = encodeNativeMessage({ two: 2 });
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    { one: 1 },
    { two: 2 },
  ]);
});
