import { test as base, chromium, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));

const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext("", {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
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

test("person creates a sleek spatial home with ideas and credentials", async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/studio.html`);

  await page.getByLabel("Creative handle").fill("river.studio");
  await page.getByRole("button", { name: "Create identity" }).click();
  await page.getByLabel("Space name").fill("Night Garden");
  await page.getByRole("button", { name: "Create private space" }).click();
  await expect(page.getByRole("region", { name: "Your home space" })).toBeVisible();

  await page.getByRole("button", { name: "Add an idea" }).click();
  await page.getByLabel("Idea title").fill("Visualize my Git repositories");
  await page.getByLabel("Notes").fill("See projects as rooms and folders as objects.");
  await page.getByRole("button", { name: "Place in room" }).click();
  await expect(page.getByText("Visualize my Git repositories")).toBeVisible();

  await page.getByRole("button", { name: "Home" }).click();
  await page.getByRole("button", { name: "Friends", exact: true }).click();
  await expect(page.getByRole("region", { name: "Friends" })).toBeVisible();
  await expect(page.getByText("Your circle is private and empty.")).toBeVisible();
  await page.getByRole("button", { name: "Credentials", exact: true }).click();
  await expect(page.getByRole("region", { name: "Credentials" })).toBeVisible();
  await expect(page.getByText("VERIFIED LOCALLY")).toBeVisible();
  await expect(page.getByText("private signing key never appears here")).toBeVisible();
});
