import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_MANIFEST_PROTOCOL,
  APP_CAPABILITIES,
  PACKAGED_SURFACE_IDS,
  RUNTIME_HANDLERS,
  SYSTEM_APP_IDS,
  getBuiltinAppCatalog,
  getAppManifest,
  resolveAppById,
  resolveAppLaunch,
  validateAppCatalog,
  validateAppManifest,
} from "../src/app-catalog.js";

const catalogPromise = getBuiltinAppCatalog();
assert.equal(getBuiltinAppCatalog(), catalogPromise);
const BUILTIN_APP_CATALOG = await catalogPromise;
const BUILTIN_APPS = await getBuiltinAppCatalog();

function manifest(overrides = {}) {
  return {
    protocol: APP_MANIFEST_PROTOCOL,
    id: "hara-playground",
    version: "0.1.0",
    publisher: { id: "hara-lang", name: "Hara Lang" },
    name: "Hara Playground",
    description: "A safe test manifest.",
    category: "installable",
    capabilities: ["hara/evaluate", "tabs/open"],
    launch: { handler: "web-tab", url: "https://playground.hara-lang.org/" },
    ...overrides,
  };
}

test("publishes the ordinary apps beside fixed Kernel DevTools", () => {
  assert.deepEqual(BUILTIN_APP_CATALOG.map(({ id }) => id), [
    "greenways-worlds",
    "chats",
    "chatgpt-provider",
    "mcp-access",
    "userscripts",
    "hara-playground",
  ]);
  assert.equal(BUILTIN_APPS, BUILTIN_APP_CATALOG);
  assert.equal(APP_MANIFEST_PROTOCOL, "greenways-app/0-alpha");
  assert.deepEqual(SYSTEM_APP_IDS, ["greenways-worlds"]);
  assert.deepEqual(RUNTIME_HANDLERS, [
    "extension-page", "packaged-surface", "native-hybrid", "web-tab", "hal-module"
  ]);
  assert.deepEqual(PACKAGED_SURFACE_IDS, ["chats", "chatgpt-provider", "mcp-access", "userscripts"]);
  assert.ok(APP_CAPABILITIES.includes("network/loopback"));
  assert.ok(Object.isFrozen(BUILTIN_APP_CATALOG));
  assert.ok(BUILTIN_APP_CATALOG.every(Object.isFrozen));
  assert.ok(BUILTIN_APP_CATALOG.every(({ publisher }) => Object.isFrozen(publisher)));
});

test("Chats is derived from its HAL project and keeps its packaged surface", () => {
  const chats = getAppManifest("chats");
  assert.deepEqual(chats.launch, { handler: "packaged-surface", surfaceId: "chats" });
  assert.equal(chats.requirement, undefined);
  assert.deepEqual(chats.capabilities, [
    "hara/module",
    "storage/local",
    "chats/capture",
    "tahto/read",
    "tahto/write",
    "hestia/propose",
    "hestia/execute",
  ]);
  assert.equal(chats.project.coordinate, "greenways-ai/chats");
  assert.equal(chats.project.digest, "sha256:d9d493664a082fe4d95bca4d924d7560c9fcba5b928971254f65a8bb3bbe9429");
  assert.equal(
    getAppManifest("userscripts").project.digest,
    "sha256:3144e69d0417738ee5e3fb4268e6543b7596443468d5d60d232f466134f058dd",
  );
});

test("Greenways for ChatGPT is a bound foreground provider surface", () => {
  const provider = getAppManifest("chatgpt-provider");
  assert.deepEqual(provider.launch, { handler: "packaged-surface", surfaceId: "chatgpt-provider" });
  assert.deepEqual(provider.capabilities, [
    "hara/module",
    "storage/local",
    "model/provide",
    "tabs/open",
  ]);
  assert.equal(provider.project.coordinate, "greenways-ai/chatgpt-provider");
  assert.equal(provider.project.digest, "sha256:a5b68c916745dbd67fa830b31e7a745a4e597ea7c1d31dca60ca66d54cdfe0c0");
});

test("Greenways MCP Access is a bound pairing surface", () => {
  const access = getAppManifest("mcp-access");
  assert.deepEqual(access.launch, { handler: "packaged-surface", surfaceId: "mcp-access" });
  assert.deepEqual(access.capabilities, ["hara/module", "mcp/pair"]);
  assert.equal(access.project.coordinate, "greenways-ai/mcp-access");
});

test("resolves only normalized catalog launches", () => {
  assert.equal(resolveAppById("chats").launch.surfaceId, "chats");
  assert.equal(resolveAppById("missing-app"), null);
  assert.deepEqual(resolveAppLaunch("chats"), { appId: "chats", handler: "packaged-surface", surfaceId: "chats" });
  assert.throws(() => resolveAppLaunch("missing-app"), /Unknown app id/);
  assert.throws(() => resolveAppById("../../unsafe"), /lowercase app identifier/);
});

test("normalizes labels and freezes nested launch data", () => {
  const output = validateAppManifest(manifest({ name: "  Hara Playground  " }));
  assert.equal(output.name, "Hara Playground");
  assert.ok(Object.isFrozen(output));
  assert.ok(Object.isFrozen(output.capabilities));
  assert.ok(Object.isFrozen(output.launch));
  assert.ok(Object.isFrozen(output.publisher));
});

test("requires a versioned protocol and attributable publisher", () => {
  assert.throws(
    () => validateAppManifest(manifest({ protocol: "greenways-app/1" })),
    /protocol must be greenways-app\/0-alpha/
  );
  assert.throws(
    () => validateAppManifest(manifest({ version: "latest" })),
    /must be a semantic version/
  );
  assert.throws(
    () => validateAppManifest(manifest({ publisher: { id: "Greenways AI", name: "Greenways AI" } })),
    /lowercase app identifier/
  );
});

test("implements SemVer 2.0 including prerelease and build metadata", () => {
  for (const version of [
    "0.0.0",
    "1.2.3",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha+build.7",
    "1.0.0+20260804.sha-abcdef",
  ]) {
    assert.equal(validateAppManifest(manifest({ version })).version, version);
  }
  for (const version of [
    "01.0.0",
    "1.01.0",
    "1.0.01",
    "1.0.0-01",
    "1.0.0-alpha..1",
    "1.0.0-alpha.",
    "1.0.0+",
    "1.0",
  ]) {
    assert.throws(() => validateAppManifest(manifest({ version })), /must be a semantic version/);
  }
});

test("rejects executable, module, and source declarations at any depth", () => {
  for (const field of ["executable", "module", "source", "moduleUrl", "remote_source_url"]) {
    assert.throws(
      () => validateAppManifest(manifest({ launch: {
        handler: "web-tab",
        url: "https://playground.hara-lang.org/",
        [field]: "https://evil.example/app.js",
      } })),
      /cannot declare executable, module, source, script, or entrypoint fields/
    );
  }
});

test("rejects runtime handlers, surfaces, and capabilities outside the allowlists", () => {
  assert.throws(
    () => validateAppManifest(manifest({ launch: { handler: "remote-module", url: "https://evil.example/" } })),
    /handler is not allowlisted/
  );
  assert.throws(
    () => validateAppManifest(manifest({ capabilities: ["tabs/open", "device/root"] })),
    /non-allowlisted capability device\/root/
  );
  assert.throws(
    () => validateAppManifest(manifest({
      id: "unknown-surface",
      capabilities: ["hestia/connect"],
      launch: { handler: "packaged-surface", surfaceId: "unknown-surface" },
    })),
    /surfaceId is not allowlisted/
  );
});

test("rejects unsafe or unapproved launch URLs", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "http://playground.hara-lang.org/",
    "https://evil.example/",
    "https://playground.hara-lang.org/?module=evil",
  ]) {
    assert.throws(
      () => validateAppManifest(manifest({ launch: { handler: "web-tab", url } })),
      /allowlisted launch URL|query or fragment/
    );
  }
  assert.throws(
    () => validateAppManifest(manifest({
      id: "historia",
      capabilities: ["historia/import", "network/loopback"],
      launch: { handler: "native-hybrid", url: "http://localhost:4319/" },
      requirement: {
        kind: "companion",
        id: "historia-local",
        name: "Historia local companion",
        description: "Required locally.",
      },
    })),
    /not an allowlisted launch URL/
  );
});

test("requires native-hybrid companion disclosure and handler capabilities", () => {
  const native = manifest({
    id: "historia",
    capabilities: ["historia/import", "network/loopback"],
    launch: { handler: "native-hybrid", url: "http://127.0.0.1:4319/" },
  });
  assert.throws(() => validateAppManifest(native), /must declare a companion requirement/);
  assert.throws(
    () => validateAppManifest({
      ...native,
      requirement: {
        kind: "companion",
        id: "historia-local",
        name: "Historia local companion",
        description: "Required locally.",
      },
    }),
    /native-hybrid apps require tabs\/open/
  );
  assert.throws(
    () => validateAppManifest(manifest({ capabilities: ["hara/evaluate"] })),
    /web-tab apps require tabs\/open/
  );
});

test("binds the Chats packaged surface to its app, publisher, and capabilities", () => {
  const chats = {
    protocol: APP_MANIFEST_PROTOCOL,
    id: "chats",
    version: "0.2.0",
    publisher: { id: "greenways-ai", name: "Greenways AI" },
    name: "Chats",
    description: "Search local AI conversations.",
    category: "installable",
    capabilities: ["chats/capture", "storage/local"],
    launch: { handler: "packaged-surface", surfaceId: "chats" },
  };
  assert.equal(validateAppManifest(chats).launch.surfaceId, "chats");
  assert.throws(
    () => validateAppManifest({ ...chats, id: "chats-alias" }),
    /bound to app chats from publisher greenways-ai/
  );
  assert.throws(
    () => validateAppManifest({ ...chats, publisher: { id: "other-publisher", name: "Other" } }),
    /bound to app chats from publisher greenways-ai/
  );
  for (const capability of ["chats/capture", "storage/local"]) {
    assert.throws(
      () => validateAppManifest({
        ...chats,
        capabilities: chats.capabilities.filter((entry) => entry !== capability),
      }),
      new RegExp(`chats requires ${capability.replace("/", "\\/")}`)
    );
  }
});

test("binds the ChatGPT provider surface to reviewed authority", () => {
  const provider = getAppManifest("chatgpt-provider");
  assert.equal(validateAppManifest(provider).launch.surfaceId, "chatgpt-provider");
  assert.throws(
    () => validateAppManifest({ ...provider, id: "chatgpt-provider-alias" }),
    /bound to app chatgpt-provider from publisher greenways-ai/,
  );
  for (const capability of ["model/provide", "storage/local", "tabs/open"]) {
    assert.throws(
      () => validateAppManifest({
        ...provider,
        capabilities: provider.capabilities.filter((entry) => entry !== capability),
      }),
      new RegExp(`chatgpt-provider requires ${capability}`),
    );
  }
});

test("binds system IDs to their publisher, path, and exact capabilities", () => {
  const worlds = getAppManifest("greenways-worlds");
  assert.equal(validateAppManifest(worlds).launch.path, "src/world.html");
  assert.throws(
    () => validateAppManifest({
      ...worlds,
      id: "fake-system",
      publisher: { id: "attacker", name: "Attacker" },
    }),
    /system app id, publisher, and packaged path are not bound together/,
  );
  assert.throws(
    () => validateAppManifest({ ...worlds, category: "installable" }),
    /reserved system app ids must use their packaged system binding/,
  );
  assert.throws(
    () => validateAppManifest({ ...worlds, capabilities: [...worlds.capabilities, "storage/local"] }),
    /capabilities must match the packaged binding/,
  );
});

test("rejects unknown fields, duplicate capabilities, and duplicate app ids", () => {
  assert.throws(() => validateAppManifest(manifest({ permissions: [] })), /unsupported field permissions/);
  assert.throws(
    () => validateAppManifest(manifest({ capabilities: ["tabs/open", "tabs/open"] })),
    /cannot contain duplicates/
  );
  assert.throws(() => validateAppCatalog([manifest(), manifest()]), /ids must be unique/);
});
