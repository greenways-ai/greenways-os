import assert from "node:assert/strict";
import test from "node:test";
import { inspectImage } from "../src/image-metadata.js";

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("inspects PNG dimensions from exact bytes", () => {
  assert.deepEqual(inspectImage(pngHeader(1122, 1402)), {
    mime: "image/png",
    extension: "png",
    width: 1122,
    height: 1402,
  });
});

test("inspects SVG dimensions from a viewBox", () => {
  assert.deepEqual(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 480"></svg>')), {
    mime: "image/svg+xml",
    extension: "svg",
    width: 640,
    height: 480,
  });
});

test("rejects unsupported bytes", () => {
  assert.throws(() => inspectImage(Buffer.from("not an image")), /Unsupported image format/);
});
