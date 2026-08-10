import assert from "node:assert/strict";
import test from "node:test";
import { getAppManifest, getBuiltinAppCatalog } from "../src/app-catalog.js";
import { createCapabilityGrant } from "../src/core-services.js";
import { PlaygroundAiAuthority } from "../src/playground-ai-authority.js";

await getBuiltinAppCatalog();

const now = () => new Date("2026-08-09T00:00:00.000Z");
const manifest = getAppManifest("hara-playground");
const grant = createCapabilityGrant({
  id: "grant/hara-playground/model-generate/12345678",
  appId: "hara-playground",
  capability: "model/generate",
  constraints: { origins: ["https://playground.hara-lang.org"] },
}, manifest, { now });

function repository(global) {
  return { async get(store, id) { assert.deepEqual([store, id], ["kernel", "global"]); return global; } };
}

test("requires the current installed Playground approval and active grant", async () => {
  const authority = new PlaygroundAiAuthority({
    repository: repository({
      protocol: "greenways-kernel-global/1",
      installed: [manifest],
      grants: [grant],
    }),
    now,
  });
  const status = await authority.status();
  assert.equal(status.allowed, true);
  assert.equal(status.grant.id, grant.id);
  assert.equal((await authority.assert()).reason, "allowed");
});

test("fails closed for absent, stale, or ungranted app approval", async () => {
  const absent = new PlaygroundAiAuthority({ repository: repository(null), now });
  assert.equal((await absent.status()).reason, "kernel-not-initialized");
  await assert.rejects(() => absent.assert(), (error) => error.code === "APP_NOT_INSTALLED");

  const stale = new PlaygroundAiAuthority({
    repository: repository({
      protocol: "greenways-kernel-global/1",
      installed: [{ ...manifest, version: "0.1.0" }],
      grants: [],
    }),
    now,
  });
  assert.equal((await stale.status()).reason, "app-approval-stale");

  const ungranted = new PlaygroundAiAuthority({
    repository: repository({
      protocol: "greenways-kernel-global/1",
      installed: [manifest],
      grants: [],
    }),
    now,
  });
  assert.equal((await ungranted.status()).reason, "grant-required");
  await assert.rejects(() => ungranted.assert(), (error) => error.code === "CAPABILITY_DENIED");
});
