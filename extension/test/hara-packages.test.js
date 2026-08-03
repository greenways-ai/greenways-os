import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { loadLockedPackageResources } from "../src/hara-packages.js";

const encoder = new TextEncoder();
const digest = async (bytes) => `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

test("verified HARP resources are staged from a packages origin", async () => {
  const source = encoder.encode("(ns example.package) (def answer 42)");
  const sourceDigest = await digest(source);
  const packageEdn = encoder.encode(`{:harp/format 1 :files {"src/example/package.hal" {:sha256 "${sourceDigest}" :size ${source.byteLength}}} :resources {"example.package" "src/example/package.hal"}}`);
  const archive = zipSync({ "package.edn": packageEdn, "src/example/package.hal": source });
  const archiveDigest = await digest(archive);
  const lock = `{:lock/format 2 :packages {"hara:example/package" {:version "1.0.0" :packages/url "https://packages.example/package.harp" :harp-sha256 "${archiveDigest}" :size ${archive.byteLength}}}}`;
  const request = async () => ({ ok: true, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) });
  const resources = await loadLockedPackageResources(lock, request);
  assert.equal(resources["example.package"], "(ns example.package) (def answer 42)");
});

test("a mismatched locked package digest fails closed", async () => {
  const archive = zipSync({ "package.edn": encoder.encode("{:harp/format 1 :files {} :resources {}}") });
  const lock = `{:lock/format 2 :packages {"hara:example/package" {:packages/url "https://packages.example/package.harp" :harp-sha256 "sha256:${"0".repeat(64)}"}}}`;
  const request = async () => ({ ok: true, arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) });
  await assert.rejects(loadLockedPackageResources(lock, request), /digest mismatch/);
});
