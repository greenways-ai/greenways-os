import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { packageExtension } from "../scripts/package-extension.mjs";

const execFileAsync = promisify(execFile);
const extensionRoot = fileURLToPath(new URL("..", import.meta.url));

test("packages a versioned, checksummed extension without development inputs", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "greenways-package-test-"));
  try {
    const result = await packageExtension({ extensionRoot, outputDirectory });
    const { stdout } = await execFileAsync("unzip", ["-Z1", result.archivePath]);
    const entries = stdout.trim().split("\n");
    assert.ok(entries.includes("manifest.json"));
    assert.ok(entries.includes("dist/background.js"));
    assert.ok(entries.includes("dist/playground-bridge.js"));
    assert.ok(entries.includes("dist/chatgpt-provider-bridge.js"));
    assert.ok(entries.includes("dist/mcp-authorization-bridge.js"));
    assert.ok(entries.includes("src/launcher.html"));
    assert.ok(entries.every((entry) => !/^(node_modules|test|scripts|release)\//.test(entry)));

    const checksum = await readFile(result.checksumPath, "utf8");
    assert.equal(checksum, `${result.sha256}  ${basename(result.archivePath)}\n`);
    const metadata = JSON.parse(await readFile(result.metadataPath, "utf8"));
    assert.equal(metadata.version, "0.4.0");
    assert.equal(metadata.sha256, result.sha256);
    assert.deepEqual(metadata.compatibility, [
      "greenways-playground-ai/0-alpha",
      "greenways-chatgpt-provider/0-alpha",
      "greenways-mcp-access/0-alpha",
    ]);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
