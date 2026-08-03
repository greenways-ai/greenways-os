import { test as base, chromium, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium", headless: true,
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

test("featured worlds are available before identity setup", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/world.html`);
  const featured = page.getByRole("region", { name: "Featured worlds" });
  await expect(featured.getByRole("heading", { name: "Apartment" })).toBeVisible();
  await expect(featured.getByRole("heading", { name: "Playbot" })).toBeVisible();
  await expect(featured.getByRole("heading", { name: "Splat Garden" })).toBeVisible();
  await expect(page.getByLabel("GitHub repository")).toBeVisible();
});
