import assert from "node:assert/strict";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { createStudioArchive } from "../src/studio-surface.js";

test("exports Hara track metadata and original audio into a portable archive", async () => {
  const audio = new TextEncoder().encode("local audio bytes");
  const store = {
    get(id) {
      assert.equal(id, "local:1");
      return { file: { arrayBuffer: async () => audio.buffer } };
    },
  };
  const { archive, manifest } = await createStudioArchive({
    tracks: [{ id: "local:1", name: "Piano: Take 1.wav", mediaType: "audio/wav", size: audio.byteLength }],
  }, store, { now: () => new Date("2026-08-04T00:00:00.000Z") });

  const files = unzipSync(archive);
  assert.equal(manifest.format, "greenways-studio/0.1");
  assert.equal(manifest.exportedAt, "2026-08-04T00:00:00.000Z");
  assert.equal(manifest.tracks[0].assetPath, "audio/01-Piano- Take 1.wav");
  assert.equal(new TextDecoder().decode(files[manifest.tracks[0].assetPath]), "local audio bytes");
  assert.deepEqual(JSON.parse(strFromU8(files["studio.json"])), manifest);
});

test("requires every exported Hara track to retain a host audio asset", async () => {
  await assert.rejects(
    createStudioArchive({ tracks: [{ id: "missing", name: "Missing.wav" }] }, { get: () => undefined }),
    /Local audio is unavailable/,
  );
});
