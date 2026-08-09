import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

test("installs one exact-origin Playground bridge", () => {
  assert.deepEqual(manifest.content_scripts, [{
    matches: ["https://playground.hara-lang.org/*"],
    js: ["dist/playground-bridge.js"],
    run_at: "document_start",
    all_frames: false,
  }]);
  assert.equal(manifest.content_scripts[0].matches.some((match) => match.includes("hara-lang.io")), false);
  assert.equal(manifest.content_scripts[0].matches.some((match) => match.includes("<all_urls>")), false);
});
