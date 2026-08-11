import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import {
  requireSingleAppEntry,
  verifyLockedPackageBundle,
} from "../src/harp.js";
import { sha256 } from "../src/crypto.js";

const encoder = new TextEncoder();

async function fixture({ extra = {} } = {}) {
  const source = encoder.encode("(ns fixture.app) (defn view [] 42)");
  const sourceDigest = await sha256(source);
  const packageEdn = encoder.encode(`{:harp/format \"0.0.0-alpha\" :files {"src/fixture/app.hal" {:sha256 "${sourceDigest}" :size ${source.byteLength}}} :resources {"fixture.app" "src/fixture/app.hal"} :greenways/app {:entry "fixture.app/view"}}`);
  const archive = zipSync({
    "package.edn": packageEdn,
    "src/fixture/app.hal": source,
    ...extra,
  });
  const lock = `{:lock/format \"0.0.0-alpha\" :packages {"greenways:fixture" {:version "1.0.0" :packages/url "https://packages.example/fixture.harp" :harp-sha256 "${await sha256(archive)}" :size ${archive.byteLength}}}}`;
  const request = async () => ({
    ok: true,
    arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
  });
  return { lock, request };
}

test("re-verifies a bounded HARP archive before publication", async () => {
  const { lock, request } = await fixture();
  const bundle = await verifyLockedPackageBundle(lock, request);
  assert.equal(requireSingleAppEntry(bundle), "fixture.app/view");
  assert.equal(bundle.resources["fixture.app"], "(ns fixture.app) (defn view [] 42)");
});

test("rejects archive content that is not covered by package.edn", async () => {
  const { lock, request } = await fixture({ extra: { "src/hidden.hal": encoder.encode("(ns hidden)") } });
  await assert.rejects(verifyLockedPackageBundle(lock, request), /undeclared file/);
});
