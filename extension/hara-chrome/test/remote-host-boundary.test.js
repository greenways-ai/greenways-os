import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("relay transport modules do not import trusted browser runtime authority", async () => {
  const source = `${await read("../src/remote-host-client.js")}\n${await read("../src/remote-host-protocol.js")}`;
  for (const forbidden of [
    /runtime-host-core/u,
    /host-bridge/u,
    /resp-client/u,
    /broker\.eval/u,
    /HOST_CALL_PORT/u,
    /chrome\./u,
    /browser\.dom/u,
    /chrome\.api/u,
    /indexeddb/iu,
    /\bROOT\b/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("transport client remains dormant until a restricted sandbox executor is added", async () => {
  const runtimeHost = await read("../src/runtime-host.js");
  const manifest = JSON.parse(await read("../manifest.json"));
  assert.doesNotMatch(runtimeHost, /remote-host-client/u);
  assert.equal("host_permissions" in manifest, false);
  assert.equal("optional_host_permissions" in manifest, false);
});
