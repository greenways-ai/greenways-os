import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applicationDescriptorFromEdn,
  applicationDescriptorFromProject,
  parseApplicationProject,
} from "../src/project-app.js";

const fixture = (name) => readFile(new URL(`../apps/${name}/project.edn`, import.meta.url), "utf8");

test("Chats and Userscripts derive their runtime identity from project.edn", async () => {
  const chats = applicationDescriptorFromEdn(await fixture("chats"));
  const userscripts = applicationDescriptorFromEdn(await fixture("userscripts"));

  assert.equal(chats.id, "chats");
  assert.equal(chats.project.coordinate, "greenways-ai/chats");
  assert.equal(chats.project.main, "chats.app/main");
  assert.deepEqual(chats.launch, { handler: "packaged-surface", surfaceId: "chats" });
  assert.ok(chats.capabilities.includes("tahto/write"));
  assert.ok(chats.capabilities.includes("hestia/execute"));

  assert.equal(userscripts.id, "userscripts");
  assert.equal(userscripts.project.main, "userscripts.app/main");
  assert.ok(userscripts.capabilities.includes("hestia/approve"));
  assert.ok(userscripts.capabilities.includes("userscripts/manage"));
});

test("project.edn rejects a second application metadata vocabulary", () => {
  const project = parseApplicationProject(`
    {:hara/type :project
     :hara/version "1.0.0"
     :project/id greenways-ai/example
     :project/version "0.1.0"
     :project/source-paths ["src"]
     :project/test-paths ["test"]
     :project/extension-paths []
     :project/capabilities #{}
     :project/main example.app/main
     :project/application
     {:application/publisher-name "Greenways AI"
      :application/name "Example"
      :application/description "Example."
      :application/category :installable
      :application/launch {:launch/handler :hal-module}}
     :app/manifest {}}`);

  assert.throws(
    () => applicationDescriptorFromProject(project),
    /unsupported key :app\/manifest/,
  );
});
