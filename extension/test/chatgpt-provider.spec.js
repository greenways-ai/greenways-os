import { test as base, chromium, expect } from "@playwright/test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));
const omittedTestDirectories = new Set([
  "node_modules",
  "playwright-report",
  "test",
  "test-results",
]);

async function createTestExtension() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "greenways-chatgpt-provider-"));
  const testExtensionPath = join(temporaryRoot, "extension");

  await cp(extensionPath, testExtensionPath, {
    recursive: true,
    filter(source) {
      const localPath = relative(extensionPath, source);
      if (!localPath) return true;
      return !omittedTestDirectories.has(localPath.split(sep)[0]);
    },
  });

  // Chrome's optional-host confirmation is browser chrome rather than
  // extension DOM, so a headless test cannot click it. Grant only the reviewed
  // ChatGPT origins in this disposable extension copy. The shipped manifest
  // remains optional-only and is covered by manifest.test.js.
  const manifestPath = join(testExtensionPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.host_permissions = [
    "https://chatgpt.com/*",
    "https://www.chatgpt.com/*",
    "https://chat.openai.com/*",
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

async function installAndOpenProvider(page, extensionId) {
  await page.goto(`chrome-extension://${extensionId}/src/launcher.html#app-chatgpt-provider`);

  const card = page.locator('[data-app-card="chatgpt-provider"]');
  await expect(card.getByRole("heading", { name: "Greenways for ChatGPT" })).toBeVisible();
  const install = card.getByRole("button", { name: "Install locally" });
  if (await install.isVisible()) {
    await expect(install).toBeEnabled();
    await install.click();
    await expect(page.getByRole("status").last()).toContainText(
      "Greenways for ChatGPT was installed",
    );
  }
  const open = card.getByRole("button", { name: "Open" });
  await expect(open).toBeEnabled();
  await open.click();
  const surface = page.getByRole("region", { name: "Greenways for ChatGPT" });
  await expect(surface).toBeVisible();
  return { card, surface };
}

async function grantAndEnable(surface) {
  const grant = surface.getByRole("button", { name: "Grant foreground provider access" });
  if (await grant.isVisible()) await grant.click();
  const enable = surface.getByRole("button", { name: "Enable ChatGPT adapter" });
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(surface.getByRole("button", { name: "Disable ChatGPT adapter" })).toBeVisible();
  await expect(surface).toContainText("ChatGPT page access approved");
}

test("installs the reviewed foreground provider and keeps authority explicit", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const { surface } = await installAndOpenProvider(page, extensionId);
  await expect(surface).toContainText("never presses Send");
  await expect(surface).toContainText("model/provide");
  await expect(surface.getByRole("button", { name: "Enable ChatGPT adapter" })).toBeDisabled();

  await grantAndEnable(surface);
  await page.reload();
  const restored = page.getByRole("region", { name: "Greenways for ChatGPT" });
  await expect(restored).toBeVisible();
  await expect(page.getByRole("status").last()).toContainText("Greenways for ChatGPT opened");
  await expect(restored.getByRole("button", { name: "Disable ChatGPT adapter" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("creates, persists, and cancels a foreground session without an automatic send", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const { surface } = await installAndOpenProvider(page, extensionId);
  await grantAndEnable(surface);

  await surface.getByLabel("Request title").fill("Explain a Hara form");
  await surface.getByLabel("Prompt").fill("Explain (map inc [1 2 3]) without executing anything else.");
  await surface.getByRole("button", { name: "Open in ChatGPT" }).click();

  await expect(surface).toContainText("Explain a Hara form");
  await expect(surface).toContainText("Opening ChatGPT");
  await expect(surface).toContainText("1 active");
  await expect.poll(() => context.pages().some((candidate) => (
    candidate.url().startsWith("https://chatgpt.com/")
  ))).toBe(true);

  await surface.getByRole("button", { name: "Cancel" }).click();
  await expect(surface).toContainText("Cancelled");
  await expect(surface).toContainText("0 active");

  await page.reload();
  const restored = page.getByRole("region", { name: "Greenways for ChatGPT" });
  await expect(restored).toBeVisible();
  await expect(page.getByRole("status").last()).toContainText("Greenways for ChatGPT opened");
  await expect(restored).toContainText("Explain a Hara form");
  await expect(restored).toContainText("Cancelled");
  await expect(restored).toContainText("never presses Send");
});
