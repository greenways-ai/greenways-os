import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import { resolvePreviewModule } from "../src/preview-client.js";

const encoder = new TextEncoder();
const sha256 = async (bytes) => `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;

async function fixture() {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const source = encoder.encode("(ns notes.app) (defn view [] {\"type\" \"text\"})");
  const packageEdn = encoder.encode(`{:harp/format 1 :files {"src/notes/app.hal" {:sha256 "${await sha256(source)}" :size ${source.byteLength}}} :resources {"notes.app" "src/notes/app.hal"} :greenways/app {:entry "notes.app/view"}}`);
  const archive = zipSync({ "package.edn": packageEdn, "src/notes/app.hal": source });
  const lock = `{:lock/format 2 :packages {"greenways:notes" {:version "1.0.0" :distribution/path "dist/notes.harp" :harp-sha256 "${await sha256(archive)}" :size ${archive.byteLength}}}}`;
  const app = `{:app/protocol "greenways-app/1" :app/id "notes" :app/version "1.0.0-preview.1" :app/publisher {:publisher/id "greenways-ai" :publisher/name "Greenways AI"} :app/name "Notes" :app/description "Preview notes." :app/category "installable" :app/capabilities ["hara/module" "storage/local"]}`;
  const responses = new Map([
    [`https://raw.githubusercontent.com/greenways-ai/notes/${sha}/greenways.app.edn`, app],
    [`https://raw.githubusercontent.com/greenways-ai/notes/${sha}/project.lock.edn`, lock],
    [`https://raw.githubusercontent.com/greenways-ai/notes/${sha}/dist/notes.harp`, archive],
  ]);
  const request = async (url) => {
    const value = responses.get(url);
    if (value === undefined) return { ok: false, status: 404, headers: new Headers() };
    if (typeof value === "string") {
      return { ok: true, status: 200, headers: new Headers(), text: async () => value };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    };
  };
  const client = {
    request,
    async resolveCommit() { return sha; },
    async text(url) {
      const response = await request(url);
      if (!response.ok) throw new Error(`fixture missing ${url}`);
      return response.text();
    },
  };
  return { client, sha };
}

test("preview resolution pins the displayed SHA and verifies the same lock pipeline", async () => {
  const { client, sha } = await fixture();
  const preview = await resolvePreviewModule({
    repository: "greenways-ai/notes",
    ref: sha,
    mode: "strict",
    client,
  });
  assert.equal(preview.resolvedSha, sha);
  assert.equal(preview.manifest.channel, "preview");
  assert.equal(preview.manifest.source.sha, sha);
  assert.equal(preview.manifest.lockDigest, preview.bundle.lockDigest);
  assert.equal(preview.staged.entry, "notes.app/view");
});

test("strict preview mode rejects mutable refs before GitHub resolution", async () => {
  let resolved = false;
  await assert.rejects(resolvePreviewModule({
    repository: "greenways-ai/notes",
    ref: "main",
    mode: "strict",
    client: { async resolveCommit() { resolved = true; } },
  }), /requires a full 40-character commit SHA/);
  assert.equal(resolved, false);
});

test("development preview resolves a branch but persists only its commit SHA", async () => {
  const { client, sha } = await fixture();
  const preview = await resolvePreviewModule({
    repository: "greenways-ai/notes",
    ref: "feature/view",
    mode: "dev",
    client,
  });
  assert.equal(preview.requestedRef, "feature/view");
  assert.equal(preview.resolvedSha, sha);
  assert.equal(preview.manifest.source.sha, sha);
});
