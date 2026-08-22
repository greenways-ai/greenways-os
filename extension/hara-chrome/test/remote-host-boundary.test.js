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

test("restricted executor modules do not import trusted browser runtime authority", async () => {
  const source = `${await read("../src/remote-sandbox-executor.js")}\n${await read("../src/remote-sandbox-wasm.js")}`;
  for (const forbidden of [
    /runtime-host-core/u,
    /host-bridge/u,
    /resp-client/u,
    /createBrowserBroker/u,
    /broker\.eval/u,
    /HOST_CALL_PORT/u,
    /chrome\./u,
    /browser\.dom/u,
    /chrome\.api/u,
    /browser\.site/u,
    /indexeddb/iu,
    /createFilesystem/u,
    /register-resources/u,
    /\bROOT\b/u,
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
  assert.match(source, /hostCalls:\s*Object\.freeze\(\{\}\)/u);
  assert.match(source, /filesystemHost:\s*null/u);
});

test("transport and executor remain dormant until real browser-Wasm proof is added", async () => {
  const runtimeHost = await read("../src/runtime-host.js");
  const manifest = JSON.parse(await read("../manifest.json"));
  assert.doesNotMatch(runtimeHost, /remote-host-client/u);
  assert.doesNotMatch(runtimeHost, /remote-sandbox-executor/u);
  assert.doesNotMatch(runtimeHost, /remote-sandbox-wasm/u);
  assert.equal("host_permissions" in manifest, false);
  assert.equal("optional_host_permissions" in manifest, false);
});
