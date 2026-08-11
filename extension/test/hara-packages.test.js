import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import {
  loadLockedPackageBundle,
  loadLockedPackageResources,
  lockedPackageAppEntry,
} from "../src/hara-packages.js";

const encoder = new TextEncoder();
const digest = async (bytes) => `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

async function fixture({ sourceText = "(ns example.package) (defn view [] 42)" } = {}) {
  const source = encoder.encode(sourceText);
  const sourceDigest = await digest(source);
  const packageEdn = encoder.encode(`{:harp/format \"0.0.0-alpha\" :files {"src/example/package.hal" {:sha256 "${sourceDigest}" :size ${source.byteLength}}} :resources {"example.package" "src/example/package.hal"} :greenways/app {:entry "example.package/view"}}`);
  const archive = zipSync({ "package.edn": packageEdn, "src/example/package.hal": source });
  const archiveDigest = await digest(archive);
  const lock = `{:lock/format \"0.0.0-alpha\" :packages {"hara:example/package" {:version "1.0.0" :packages/url "https://packages.example/package.harp" :harp-sha256 "${archiveDigest}" :size ${archive.byteLength}}}}`;
  const request = async () => ({
    ok: true,
    arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
  });
  return { source, archive, lock, request };
}

test("verified HARP resources are staged from a packages origin", async () => {
  const { lock, request } = await fixture();
  const resources = await loadLockedPackageResources(lock, request);
  assert.equal(resources["example.package"], "(ns example.package) (defn view [] 42)");
});

test("verified bundles retain exact lock and archive evidence for boot re-verification", async () => {
  const { archive, lock, request } = await fixture();
  const bundle = await loadLockedPackageBundle(lock, request);
  assert.match(bundle.lockDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(bundle.packages["hara:example/package"].archive.byteLength, archive.byteLength);
  assert.equal(bundle.packages["hara:example/package"].digest, await digest(archive));
  assert.equal(lockedPackageAppEntry(bundle), "example.package/view");
  assert.ok(Object.isFrozen(bundle.resources));
});

test("a mismatched locked package digest fails closed", async () => {
  const archive = zipSync({ "package.edn": encoder.encode("{:harp/format \"0.0.0-alpha\" :files {} :resources {}}") });
  const lock = `{:lock/format \"0.0.0-alpha\" :packages {"hara:example/package" {:packages/url "https://packages.example/package.harp" :harp-sha256 "sha256:${"0".repeat(64)}"}}}`;
  const request = async () => ({ ok: true, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) });
  await assert.rejects(loadLockedPackageResources(lock, request), /digest mismatch/);
});

test("a resource must be covered by the package file digest map", async () => {
  const source = encoder.encode("(ns example.package)");
  const packageEdn = encoder.encode('{:harp/format \"0.0.0-alpha\" :files {} :resources {"example.package" "src/example/package.hal"}}');
  const archive = zipSync({ "package.edn": packageEdn, "src/example/package.hal": source });
  const lock = `{:lock/format \"0.0.0-alpha\" :packages {"hara:example/package" {:packages/url "https://packages.example/package.harp" :harp-sha256 "${await digest(archive)}"}}}`;
  const request = async () => ({ ok: true, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) });
  await assert.rejects(loadLockedPackageBundle(lock, request), /undeclared file/);
});

test("a package graph must identify exactly one Greenways app entry", async () => {
  const source = encoder.encode("(ns example.package)");
  const sourceDigest = await digest(source);
  const packageEdn = encoder.encode(`{:harp/format \"0.0.0-alpha\" :files {"src/example/package.hal" {:sha256 "${sourceDigest}" :size ${source.byteLength}}} :resources {"example.package" "src/example/package.hal"}}`);
  const archive = zipSync({ "package.edn": packageEdn, "src/example/package.hal": source });
  const lock = `{:lock/format \"0.0.0-alpha\" :packages {"hara:example/package" {:packages/url "https://packages.example/package.harp" :harp-sha256 "${await digest(archive)}"}}}`;
  const request = async () => ({ ok: true, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) });
  const bundle = await loadLockedPackageBundle(lock, request);
  assert.throws(() => lockedPackageAppEntry(bundle), /exactly one Greenways app entry/);
});

test("archive files not covered by package.edn are rejected", async () => {
  const source = encoder.encode("(ns example.package)");
  const sourceDigest = await digest(source);
  const packageEdn = encoder.encode(`{:harp/format \"0.0.0-alpha\" :files {"src/example/package.hal" {:sha256 "${sourceDigest}" :size ${source.byteLength}}} :resources {"example.package" "src/example/package.hal"} :greenways/app {:entry "example.package/view"}}`);
  const archive = zipSync({
    "package.edn": packageEdn,
    "src/example/package.hal": source,
    "src/hidden.hal": encoder.encode("(ns hidden)"),
  });
  const lock = `{:lock/format \"0.0.0-alpha\" :packages {"hara:example/package" {:packages/url "https://packages.example/package.harp" :harp-sha256 "${await digest(archive)}"}}}`;
  const request = async () => ({ ok: true, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) });
  await assert.rejects(loadLockedPackageBundle(lock, request), /undeclared file/);
});
