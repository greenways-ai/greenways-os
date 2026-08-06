import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRegistryServer } from "../src/server.js";

test("serves the mutable signed index separately from immutable artifacts", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "greenways-registry-"));
  await mkdir(join(root, "v1", "packages"), { recursive: true });
  await writeFile(join(root, "v1", "index.edn"), "{:registry/protocol \"greenways-registry/1\"}");
  await writeFile(join(root, "v1", "packages", "fixture.harp"), "archive");
  const service = createRegistryServer({ root, host: "127.0.0.1", port: 0 });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${address.port}`;
  const index = await fetch(`${base}/v1/index.edn`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
  assert.match(index.headers.get("content-type"), /application\/edn/);
  const archive = await fetch(`${base}/v1/packages/fixture.harp`);
  assert.equal(archive.status, 200);
  assert.equal(archive.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(archive.headers.get("x-content-type-options"), "nosniff");
});

test("rejects traversal and unsupported methods", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "greenways-registry-"));
  const service = createRegistryServer({ root, host: "127.0.0.1", port: 0 });
  const address = await service.listen();
  context.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${address.port}`;
  assert.ok([400, 404].includes((await fetch(`${base}/%2e%2e/secret`)).status));
  assert.equal((await fetch(`${base}/v1/index.edn`, { method: "POST" })).status, 405);
});
