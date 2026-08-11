import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, oldValue, newValue) {
  const text = readFileSync(path, "utf8");
  const index = text.indexOf(oldValue);
  if (index < 0) {
    throw new Error(`Missing exact projection anchor in ${path}: ${JSON.stringify(oldValue.slice(0, 120))}`);
  }
  if (text.indexOf(oldValue, index + oldValue.length) >= 0) {
    throw new Error(`Projection anchor is not unique in ${path}: ${JSON.stringify(oldValue.slice(0, 120))}`);
  }
  writeFileSync(path, `${text.slice(0, index)}${newValue}${text.slice(index + oldValue.length)}`);
}

replaceOnce(
  "src/gw/os/services.hal",
  `   {"protocol" CAPABILITY-DEFINITION-PROTOCOL "id" "model/provide" "service" "surfaces" "risk" "critical" "grantable" true "trustedPublishers" ["greenways-ai"]}
   {"protocol" CAPABILITY-DEFINITION-PROTOCOL "id" "tahto/connect" "service" "connectors" "risk" "high" "grantable" true "trustedPublishers" []}
`,
  `   {"protocol" CAPABILITY-DEFINITION-PROTOCOL "id" "model/provide" "service" "surfaces" "risk" "critical" "grantable" true "trustedPublishers" ["greenways-ai"]}
   {"protocol" CAPABILITY-DEFINITION-PROTOCOL "id" "mcp/pair" "service" "keyring" "risk" "critical" "grantable" true "trustedPublishers" ["greenways-ai"]}
   {"protocol" CAPABILITY-DEFINITION-PROTOCOL "id" "tahto/connect" "service" "connectors" "risk" "high" "grantable" true "trustedPublishers" []}
`,
);

replaceOnce(
  "test/gw/os/services_test.hal",
  `  (test/check
   "foreground model provision remains a reviewed surface capability"
   (let [definition (services/capability-definition "model/provide")]
     [(get definition "service")
      (get definition "risk")
      (get definition "grantable")
      (get definition "trustedPublishers")])
   ["surfaces" "critical" true ["greenways-ai"]])])
`,
  `  (test/check
   "foreground model provision remains a reviewed surface capability"
   (let [definition (services/capability-definition "model/provide")]
     [(get definition "service")
      (get definition "risk")
      (get definition "grantable")
      (get definition "trustedPublishers")])
   ["surfaces" "critical" true ["greenways-ai"]])

  (test/check
   "MCP pairing remains a trusted Keyring capability"
   (let [definition (services/capability-definition "mcp/pair")]
     [(get definition "service")
      (get definition "risk")
      (get definition "grantable")
      (get definition "trustedPublishers")])
   ["keyring" "critical" true ["greenways-ai"]])])
`,
);

replaceOnce(
  "extension/test/app-catalog.test.js",
  `    "chatgpt-provider",
    "userscripts",
`,
  `    "chatgpt-provider",
    "mcp-access",
    "userscripts",
`,
);
replaceOnce(
  "extension/test/app-catalog.test.js",
  `  assert.deepEqual(PACKAGED_SURFACE_IDS, ["chats", "chatgpt-provider", "userscripts"]);
`,
  `  assert.deepEqual(PACKAGED_SURFACE_IDS, ["chats", "chatgpt-provider", "mcp-access", "userscripts"]);
`,
);
replaceOnce(
  "extension/test/app-catalog.test.js",
  `test("Greenways for ChatGPT is a bound foreground provider surface", () => {
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
`,
  `test("Greenways for ChatGPT is a bound foreground provider surface", () => {
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
`,
);

replaceOnce(
  "extension/test/core-services.test.js",
  `test("adds opaque key and model operations to the closed app capability vocabulary", () => {
`,
  `test("adds opaque key, model, and MCP operations to the closed app capability vocabulary", () => {
`,
);
replaceOnce(
  "extension/test/core-services.test.js",
  `    "model/generate",
    "model/provide",
`,
  `    "model/generate",
    "model/provide",
    "mcp/pair",
`,
);
replaceOnce(
  "extension/test/core-services.test.js",
  `  assert.deepEqual(getCapabilityDefinition("model/provide").trustedPublishers, ["greenways-ai"]);
  assert.equal(getCapabilityDefinition("hara/module").grantable, false);
`,
  `  assert.deepEqual(getCapabilityDefinition("model/provide").trustedPublishers, ["greenways-ai"]);
  assert.equal(getCapabilityDefinition("mcp/pair").service, "keyring");
  assert.deepEqual(getCapabilityDefinition("mcp/pair").trustedPublishers, ["greenways-ai"]);
  assert.equal(getCapabilityDefinition("hara/module").grantable, false);
`,
);

replaceOnce(
  "extension/test/package-manager.test.js",
  `  assert.equal(packages.length, 5);
`,
  `  assert.equal(packages.length, 6);
`,
);
replaceOnce(
  "extension/test/package-manager.test.js",
  `    "bundled-module",
    "bundled-module",
    "bundled-module",
    "web-application",
`,
  `    "bundled-module",
    "bundled-module",
    "bundled-module",
    "bundled-module",
    "web-application",
`,
);
replaceOnce(
  "extension/test/package-manager.test.js",
  `  assert.equal(inventory.available, 3);
  assert.equal(inventory.entries.find(({ id }) => id === "chats").status, "update-available");
`,
  `  assert.equal(inventory.available, 4);
  assert.equal(inventory.entries.find(({ id }) => id === "chats").status, "update-available");
  assert.equal(inventory.entries.find(({ id }) => id === "mcp-access").status, "available");
`,
);

replaceOnce(
  "extension/test/release-package.test.js",
  `    assert.ok(entries.includes("dist/chatgpt-provider-bridge.js"));
    assert.ok(entries.includes("src/launcher.html"));
`,
  `    assert.ok(entries.includes("dist/chatgpt-provider-bridge.js"));
    assert.ok(entries.includes("dist/mcp-authorization-bridge.js"));
    assert.ok(entries.includes("src/launcher.html"));
`,
);
replaceOnce(
  "extension/test/release-package.test.js",
  `      "greenways-playground-ai/1",
      "greenways-chatgpt-provider/1",
`,
  `      "greenways-playground-ai/1",
      "greenways-chatgpt-provider/1",
      "greenways-mcp-access/1",
`,
);

console.log("Aligned MCP authorization adapter projections");
