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

test("launcher presents Beacon as the Hoplite gateway to Greenways Space", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/src/launcher.html`);

  await expect(page.getByRole("status")).toContainText("Local kernel ready");
  await expect(page.getByRole("heading", {
    name: "A local way into Greenways Space.",
  })).toBeVisible();
  await expect(page.locator("[data-beacon]")).toContainText("Hoplite · Hara · Nginx");
  await expect(page.locator("[data-beacon]")).toContainText("Hestia · Ignatius · Historia");

  await page.getByRole("button", { name: "Connect Beacon" }).click();
  const dialog = page.getByRole("dialog", { name: "Greenways Beacon" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", {
    name: "Connect this browser to its local Beacon.",
  })).toBeVisible();
  await expect(dialog.getByLabel("Beacon origin")).toHaveValue(
    "http://127.0.0.1:58100",
  );
  await expect(dialog).toContainText("local Beacon");
  await expect(dialog).toContainText("greenways.space");
  await expect(dialog).toContainText("Beacon is a gateway, not an account.");
  await expect(dialog).toContainText("Descriptors from Beacon and Space are validated as inert data.");

  await dialog.getByRole("button", { name: "Close Greenways Beacon" }).click();
  await expect(dialog).toBeHidden();
  expect(errors).toEqual([]);
});
