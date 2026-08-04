import { test as base, chromium, expect } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { GreenwaysHomeNode } from "../../services/home-node/src/home-node.js";
import { createHomeNodeServer } from "../../services/home-node/src/server.js";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));
const omittedTestDirectories = new Set([
  "node_modules",
  "playwright-report",
  "test",
  "test-results",
]);

async function createTestExtension() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "greenways-home-link-"));
  const testExtensionPath = join(temporaryRoot, "extension");

  await cp(extensionPath, testExtensionPath, {
    recursive: true,
    filter(source) {
      const localPath = relative(extensionPath, source);
      if (!localPath) return true;
      return !omittedTestDirectories.has(localPath.split(sep)[0]);
    },
  });

  // Chrome's optional-host confirmation is browser chrome, not extension DOM,
  // and therefore cannot be accepted by a headless Playwright page. The test
  // copy grants loopback up front so the browser still performs the real HTTP
  // exchange. The repository manifest remains optional-only and is covered by
  // manifest.test.js.
  const manifestPath = join(testExtensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [
    "http://127.0.0.1/*",
    "http://localhost/*",
  ];
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    path: testExtensionPath,
    async dispose() {
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

const test = base.extend({
  context: async ({}, use) => {
    const testExtension = await createTestExtension();
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${testExtension.path}`,
        `--load-extension=${testExtension.path}`,
      ],
    });
    try {
      await use(context);
    } finally {
      await context.close();
      await testExtension.dispose();
    }
  },
  extensionId: async ({ context }, use) => {
    let worker = context.serviceWorkers().find((candidate) => (
      candidate.url().endsWith("/dist/background.js")
    ));
    if (!worker) {
      worker = await context.waitForEvent("serviceworker", {
        predicate: (candidate) => candidate.url().endsWith("/dist/background.js"),
      });
    }
    await use(new URL(worker.url()).host);
  },
});

const homeServices = [
  {
    id: "hestia",
    name: "Hestia",
    kind: "evidence",
    version: "1",
    capabilities: ["evidence.sync"],
    status: "available",
  },
  {
    id: "historia",
    name: "Historia",
    kind: "memory",
    version: "1",
    capabilities: ["history.import"],
    status: "available",
  },
];

test("Home Node action opens the signed browser-pairing surface", async ({ context, extensionId }) => {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/src/launcher.html`);

  await expect(page.getByRole("status")).toContainText("Local kernel ready");
  const homeNode = page.locator("[data-home-node]");
  await expect(homeNode.getByRole("heading", { name: "Give your browsers a home you control." })).toBeVisible();
  await homeNode.getByRole("button", { name: "Connect home" }).click();

  const dialog = page.getByRole("dialog", { name: "Home Link" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Give this browser a home address." })).toBeVisible();
  await expect(dialog.getByLabel("Home server origin")).toHaveValue("http://127.0.0.1:58100");
  await expect(dialog.getByLabel("One-time pairing code")).toBeVisible();
  await expect(dialog).toContainText("no Greenways account or reusable bearer token");
  await expect(dialog).toContainText("never evaluates remote JavaScript, Wasm, HAL");

  await dialog.getByRole("button", { name: "Close Home Link" }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});

test("pairs and restores a signed Home Link in the browser", async ({ context, extensionId }) => {
  const node = new GreenwaysHomeNode({
    id: "home.browser-test",
    name: "Browser Test Home",
    services: homeServices,
  });
  const app = createHomeNodeServer({ node, host: "127.0.0.1", port: 0 });
  await app.listen();
  try {
    const pairingCode = node.issuePairingCode().code;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/launcher.html`);
    await expect(page.getByRole("status")).toContainText("Local kernel ready");

    const homeNode = page.locator("[data-home-node]");
    await homeNode.getByRole("button", { name: "Connect home" }).click();
    const dialog = page.getByRole("dialog", { name: "Home Link" });
    await dialog.getByLabel("Home server origin").fill(app.origin);
    await dialog.getByLabel("Browser name").fill("Playwright browser");
    await dialog.getByLabel("One-time pairing code").fill(pairingCode);
    await dialog.getByRole("button", { name: "Pair this browser" }).click();

    await expect(dialog.getByRole("heading", { name: "Your browsers know their home." })).toBeVisible();
    await expect(dialog).toContainText("Browser Test Home");
    await expect(dialog).toContainText("Playwright browser · this browser");
    await expect(dialog).toContainText("Hestia");
    await expect(dialog).toContainText("Historia");
    await dialog.getByRole("button", { name: "Close Home Link" }).click();
    await expect(homeNode.getByRole("heading", { name: "This browser has a signed route home." })).toBeVisible();
    await expect(homeNode).toContainText("Browser Test Home");

    await page.reload();
    await expect(page.getByRole("status")).toContainText("Local kernel ready");
    const restored = page.locator("[data-home-node]");
    await expect(restored.getByRole("button", { name: "Manage home link" })).toBeVisible();
    await restored.getByRole("button", { name: "Manage home link" }).click();
    const restoredDialog = page.getByRole("dialog", { name: "Home Link" });
    await expect(restoredDialog.getByRole("heading", { name: "Your browsers know their home." })).toBeVisible();
    await expect(restoredDialog).toContainText("Playwright browser · this browser");
  } finally {
    await app.close();
  }
});
