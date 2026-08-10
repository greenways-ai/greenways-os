import assert from "node:assert/strict";
import test from "node:test";
import { getAppManifest, getBuiltinAppCatalog } from "../src/app-catalog.js";
import { createApplicationServiceRouter } from "../src/application-services.js";
import { createCapabilityGrant } from "../src/core-services.js";

await getBuiltinAppCatalog();

function grant(manifest, capability, index) {
  return createCapabilityGrant({
    id: `grant/application-service-${index}`,
    appId: manifest.id,
    capability,
    constraints: {},
  }, manifest, { now: () => new Date("2026-08-09T00:00:00.000Z") });
}

function fixture() {
  const authorityCalls = [];
  const semanticCalls = [];
  const controlCalls = [];
  const router = createApplicationServiceRouter({
    capabilityAuthority: {
      async assert(request) {
        authorityCalls.push(request);
      },
    },
    semantic: {
      async call(...args) {
        semanticCalls.push(args);
        return { source: "tahto" };
      },
    },
    control: {
      async call(...args) {
        controlCalls.push(args);
        return { source: "hestia" };
      },
    },
  });
  return { router, authorityCalls, semanticCalls, controlCalls };
}

test("Chats routes capture state to Tahto and sharing to Hestia", async () => {
  const { router, authorityCalls, semanticCalls, controlCalls } = fixture();
  const installed = [getAppManifest("chats")];
  const grants = [
    grant(installed[0], "tahto/write", 1),
    grant(installed[0], "hestia/propose", 2),
  ];

  assert.deepEqual(
    await router.call("chats", {
      service: "tahto.semantic",
      operation: "transact",
      arguments: [{ collection: "chats", put: {} }],
    }, { installed, grants }),
    { source: "tahto" },
  );
  assert.deepEqual(
    await router.call("chats", {
      service: "hestia.control",
      operation: "propose",
      arguments: [{ "intent/id": "share-1" }],
    }, { installed, grants }),
    { source: "hestia" },
  );

  assert.deepEqual(authorityCalls, [
    { appId: "chats", capability: "tahto/write" },
    { appId: "chats", capability: "hestia/propose" },
  ]);
  assert.equal(semanticCalls.length, 1);
  assert.equal(controlCalls.length, 1);
  assert.equal(controlCalls[0][2].project.coordinate, "greenways-ai/chats");
});

test("Userscripts cannot bypass Hestia to reach an effect service", async () => {
  const { router } = fixture();
  const installed = [getAppManifest("userscripts")];

  await assert.rejects(
    router.call("userscripts", {
      service: "greenways.connector",
      operation: "userscripts/enable",
      arguments: [],
    }, { installed }),
    /route is not available/,
  );
  await assert.rejects(
    router.call("userscripts", {
      service: "hestia.control",
      operation: "unknown",
      arguments: [],
    }, { installed }),
    /route is not available/,
  );
});

test("a declared service capability is inert until its exact project has an active grant", async () => {
  const { router } = fixture();
  const installed = [getAppManifest("chats")];
  await assert.rejects(
    router.call("chats", {
      service: "tahto.semantic",
      operation: "get",
      arguments: [{ collection: "chats", id: "chat-1" }],
    }, { installed, grants: [] }),
    /no active tahto\/read grant/,
  );
});
