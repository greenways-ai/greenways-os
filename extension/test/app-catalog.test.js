import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_MANIFEST_PROTOCOL,
  APP_CAPABILITIES,
  BUILTIN_APP_CATALOG,
  BUILTIN_APPS,
  PACKAGED_SURFACE_IDS,
  RUNTIME_HANDLERS,
  SYSTEM_APP_IDS,
  getAppManifest,
  resolveAppById,
  resolveAppLaunch,
  validateAppCatalog,
  validateAppManifest,
} from "../src/app-catalog.js";

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

test("publishes the five declarative built-in apps", () => {
  assert.deepEqual(BUILTIN_APP_CATALOG.map(({ id }) => id), [
    "greenways-home",
    "greenways-worlds",
    "historia",
    "hestia-connector",
    "hara-playground",
  ]);
  assert.equal(BUILTIN_APPS, BUILTIN_APP_CATALOG);
  assert.equal(APP_MANIFEST_PROTOCOL, "greenways-app/1");
  assert.deepEqual(SYSTEM_APP_IDS, ["greenways-home", "greenways-worlds"]);
  assert.deepEqual(RUNTIME_HANDLERS, [
    "extension-page", "packaged-surface", "native-hybrid", "web-tab"
  ]);
  assert.deepEqual(PACKAGED_SURFACE_IDS, ["hestia-connector"]);
  assert.ok(APP_CAPABILITIES.includes("network/loopback"));
  assert.ok(Object.isFrozen(BUILTIN_APP_CATALOG));
  assert.ok(BUILTIN_APP_CATALOG.every(Object.isFrozen));
  assert.ok(BUILTIN_APP_CATALOG.every(({ publisher }) => Object.isFrozen(publisher)));
});

test("Historia is an explicit local native-hybrid app", () => {
  const historia = getAppManifest("historia");
  assert.deepEqual(historia.launch, {
    handler: "native-hybrid",
    url: "http://127.0.0.1:4319/",
  });
  assert.equal(historia.requirement.kind, "companion");
  assert.equal(historia.requirement.id, "historia-local");
  assert.ok(historia.capabilities.includes("network/loopback"));
});

test("resolves only normalized catalog launches", () => {
  assert.equal(resolveAppById("hestia-connector").launch.surfaceId, "hestia-connector");
  assert.equal(resolveAppById("missing-app"), null);
  assert.deepEqual(resolveAppLaunch("hara-playground"), {
    appId: "hara-playground",
    handler: "web-tab",
    url: "https://playground.hara-lang.org/",
  });
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
    () => validateAppManifest(manifest({ protocol: "greenways-app/2" })),
    /protocol must be greenways-app\/1/
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

test("binds the Hestia packaged surface to its app, publisher, and capabilities", () => {
  const hestia = {
    protocol: APP_MANIFEST_PROTOCOL,
    id: "hestia-connector",
    version: "0.2.0",
    publisher: { id: "greenways-ai", name: "Greenways AI" },
    name: "Hestia Connector",
    description: "Pair a local Hestia node.",
    category: "installable",
    capabilities: ["hestia/connect", "network/https", "network/loopback", "storage/local"],
    launch: { handler: "packaged-surface", surfaceId: "hestia-connector" },
  };
  assert.equal(validateAppManifest(hestia).launch.surfaceId, "hestia-connector");
  assert.throws(
    () => validateAppManifest({ ...hestia, id: "hestia-alias" }),
    /bound to app hestia-connector from publisher greenways-ai/
  );
  assert.throws(
    () => validateAppManifest({ ...hestia, publisher: { id: "other-publisher", name: "Other" } }),
    /bound to app hestia-connector from publisher greenways-ai/
  );
  for (const capability of ["hestia/connect", "network/https", "network/loopback", "storage/local"]) {
    assert.throws(
      () => validateAppManifest({
        ...hestia,
        capabilities: hestia.capabilities.filter((entry) => entry !== capability),
      }),
      new RegExp(`hestia-connector requires ${capability.replace("/", "\\/")}`)
    );
  }
});

test("binds system IDs to their publisher, path, and exact capabilities", () => {
  const home = getAppManifest("greenways-home");
  assert.equal(validateAppManifest(home).launch.path, "src/studio.html#home");
  assert.throws(
    () => validateAppManifest({
      ...home,
      id: "fake-system",
      publisher: { id: "attacker", name: "Attacker" },
    }),
    /system app id, publisher, and packaged path are not bound together/,
  );
  assert.throws(
    () => validateAppManifest({ ...home, category: "installable" }),
    /reserved system app ids must use their packaged system binding/,
  );
  assert.throws(
    () => validateAppManifest({ ...home, capabilities: [...home.capabilities, "hestia/connect"] }),
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
