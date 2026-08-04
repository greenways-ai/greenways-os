import { test as base, chromium, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker");
    await use(new URL(worker.url()).host);
  },
});

test("launcher restores system apps and installs the local Hestia surface", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/launcher.html#app-hestia-connector`);

  const installed = page.getByRole("region", { name: "Installed apps" });
  await expect(installed.getByRole("heading", { name: "Greenways Home" })).toBeVisible();
  await expect(installed.getByRole("heading", { name: "Worlds" })).toBeVisible();
  await expect(page.getByText("Install Hestia Connector locally to continue")).toBeVisible();

  const hestiaCard = page.locator('[data-app-card="hestia-connector"]');
  await hestiaCard.getByRole("button", { name: "Install locally" }).click();
  await expect(hestiaCard.getByRole("button", { name: "Open" })).toBeVisible();
  await hestiaCard.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("region", { name: "Hestia connector" })).toBeVisible();
  await expect(page.getByText("Origin access is requested when you pair")).toBeVisible();
  await page.getByRole("button", { name: "Close Hestia connector" }).click();
  await expect(page.getByRole("region", { name: "Hestia connector" })).toBeHidden();
  await hestiaCard.getByRole("button", { name: "Remove Hestia Connector" }).click();
  await expect(hestiaCard.getByRole("button", { name: "Install locally" })).toBeVisible();
});
