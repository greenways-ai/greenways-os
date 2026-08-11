import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssetRegistry } from "../src/asset-registry.js";
import { runCli } from "../src/cli.js";

function pngHeader() {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(64, 16);
  bytes.writeUInt32BE(48, 20);
  return bytes;
}

function capture() {
  let value = "";
  return {
    stream: { write: (chunk) => { value += String(chunk); } },
    value: () => value,
  };
}

test("CLI imports, resolves and verifies an image", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "greenways-assets-cli-"));
  await writeFile(join(cwd, "image.png"), pngHeader());
  const root = join(cwd, "catalog");
  const registryFactory = (requestedRoot) => new AssetRegistry(requestedRoot, {
    now: () => new Date("2026-08-11T04:00:00.000Z"),
    idFactory: () => "44444444-4444-4444-8444-444444444444",
  });
  const importedOutput = capture();
  const imported = await runCli([
    "import", "image.png", "--root", root,
    "--title", "CLI image",
    "--project", "visual-language",
    "--collection", "flowers",
    "--alias", "flowers/cli-image",
    "--provider", "openai-image",
  ], { cwd, stdout: importedOutput.stream, registryFactory });
  assert.equal(imported.asset.title, "CLI image");
  assert.equal(JSON.parse(importedOutput.value()).asset.id, imported.asset.id);

  const verifiedOutput = capture();
  const verified = await runCli(["verify", "flowers/cli-image", "--root", root], {
    cwd,
    stdout: verifiedOutput.stream,
    registryFactory,
  });
  assert.equal(verified.assetId, imported.asset.id);
  assert.equal(JSON.parse(verifiedOutput.value()).mime, "image/png");
});

test("CLI rejects unknown options", async () => {
  await assert.rejects(
    () => runCli(["init", "--unknown", "value"], { stdout: capture().stream }),
    /unknown option/,
  );
});
