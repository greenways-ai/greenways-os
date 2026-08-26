import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
import {
  installLockedPackages,
  installPackageProvider,
  loadLockedPackageResources
} from "./src/packages.js";

const encoder = new TextEncoder();

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(bytes) {
  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

async function fixture() {
  const source = encoder.encode("(ns demo.world) (def world {:title \"Demo\"})");
  const sourceDigest = await digest(source);
  const manifest = encoder.encode(
    `{:files {"src/demo/world.hal" {:size ${source.byteLength} :sha256 "${sourceDigest}"}} `
      + `:resources {"demo.world" "src/demo/world.hal"}}`
  );
  const archive = zipSync({
    "package.edn": manifest,
    "src/demo/world.hal": source
  });
  const archiveDigest = await digest(archive);
  const registryCommit = "a".repeat(40);
  const identityRevision = "b".repeat(40);
  const lock = `{:lock/format \"0.0.0-alpha\" :packages {"demo:world" `
    + `{:version "1.0.0" :tap "hara" :registry-commit "${registryCommit}" `
    + `:identity-revision "${identityRevision}" :archive-sha256 "${archiveDigest}" `
    + `:namespaces [demo.world]}}}`;
  const registry = `{:registry/packages {"demo:world" {"1.0.0" `
    + `{:archive-sha256 "${archiveDigest}" :identity-revision "${identityRevision}"}}}}`;
  return { archive, lock, registry, registryCommit, archiveDigest };
}

test("exact locks use the pinned registry and digest object endpoint", async () => {
  const { archive, lock, registry, registryCommit, archiveDigest } = await fixture();
  const requested = [];
  const resources = await loadLockedPackageResources(lock, async (url) => {
    requested.push(url);
    return new Response(url.includes("/v1/registry") ? registry : archive);
  }, "https://packages.example");

  assert.deepEqual(requested, [
    `https://packages.example/v1/registry?ref=${registryCommit}`,
    `https://packages.example/objects/sha256/${archiveDigest.slice(7)}`
  ]);
  assert.equal(resources["demo.world"], "(ns demo.world) (def world {:title \"Demo\"})");
});

test("installation is atomic when a locked archive fails verification", async () => {
  const { archive, lock, registry } = await fixture();
  const registered = [];
  const runtime = {
    registerResource(namespace, source) {
      registered.push([namespace, source]);
    }
  };
  const corrupt = archive.slice();
  corrupt[corrupt.length - 1] ^= 1;

  await assert.rejects(
    installLockedPackages(runtime, lock, {
      origin: "https://packages.example",
      fetch: async (url) => new Response(url.includes("/v1/registry") ? registry : corrupt)
    }),
    /digest mismatch/
  );
  assert.deepEqual(registered, []);
});

test("the package provider activates and unloads an exact target", async () => {
  const { archive, lock, registry } = await fixture();
  const registered = [];
  const removed = [];
  let handler;
  const runtime = {
    registerResource(namespace, source) {
      registered.push([namespace, source]);
    },
    raw: {
      registerPackageLock() {},
      install_host_handler(value) { handler = value; },
      unregister_resource(namespace) { removed.push(namespace); }
    }
  };
  const provider = installPackageProvider(runtime, lock, {
    origin: "https://packages.example",
    fetch: async (url) => new Response(url.includes("/v1/registry") ? registry : archive)
  });

  await handler("package", "ensure", [{ "package/coordinate": "demo:world" }]);
  assert.equal(provider.active.has("demo:world"), true);
  assert.equal(registered[0][0], "demo.world");
  assert.deepEqual(
    await handler("package", "unload", [{ "package/coordinate": "demo:world" }, {}]),
    ["demo:world"]
  );
  assert.deepEqual(removed, ["demo.world"]);
});
