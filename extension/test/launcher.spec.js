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

function extensionWorker(context, extensionId) {
  return context.serviceWorkers().find((worker) => (
    worker.url().startsWith(`chrome-extension://${extensionId}/`)
  ));
}

async function terminateExtensionWorker(context, extensionId, page) {
  const worker = extensionWorker(context, extensionId);
  expect(worker, "running extension service worker").toBeTruthy();
  const session = await context.newCDPSession(page);
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    const targets = targetInfos.filter(({ type, url }) => (
      type === "service_worker"
      && url === worker.url()
    ));
    expect(targets, "one CDP target for the running extension worker").toHaveLength(1);
    const [, result] = await Promise.all([
      worker.waitForEvent("close"),
      session.send("Target.closeTarget", { targetId: targets[0].targetId }),
    ]);
    expect(result.success).toBe(true);
    return worker;
  } finally {
    await session.detach();
  }
}

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

test("packaged Worlds boots through the browser-wide kernel host", async ({ context, extensionId }) => {
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`chrome-extension://${extensionId}/src/world.html`);

  await expect(page.getByRole("heading", { name: /Enter a living world/i })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("two launchers converge globally, isolate surfaces, and survive a cold worker restart", async ({ context, extensionId }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([
    first.goto(`chrome-extension://${extensionId}/src/launcher.html`),
    second.goto(`chrome-extension://${extensionId}/src/launcher.html`),
  ]);
  await Promise.all([
    expect(first.getByRole("status")).toContainText("Local kernel ready"),
    expect(second.getByRole("status")).toContainText("Local kernel ready"),
  ]);

  const firstCard = first.locator('[data-app-card="hestia-connector"]');
  const secondCard = second.locator('[data-app-card="hestia-connector"]');
  await firstCard.getByRole("button", { name: "Install locally" }).click();
  await expect(first.getByRole("status")).toContainText("Hestia Connector was installed");
  await expect(secondCard.getByRole("button", { name: "Open" })).toBeVisible();

  await firstCard.getByRole("button", { name: "Open" }).click();
  await expect(first.getByRole("status")).toContainText("Hestia Connector opened");
  await expect(first.getByRole("region", { name: "Hestia connector" })).toBeVisible();
  await expect(second.getByRole("region", { name: "Hestia connector" })).toBeHidden();

  const restartedWorkerPromise = context.waitForEvent("serviceworker", {
    predicate: (worker) => worker.url().startsWith(`chrome-extension://${extensionId}/`),
  });
  const stoppedWorker = await terminateExtensionWorker(context, extensionId, second);
  const [restartedWorker] = await Promise.all([
    restartedWorkerPromise,
    secondCard.getByRole("button", { name: "Open" }).click(),
  ]);

  expect(restartedWorker).not.toBe(stoppedWorker);
  await expect(second.getByRole("status")).toContainText("Hestia Connector opened");
  await expect(second.getByRole("region", { name: "Hestia connector" })).toBeVisible();
  await expect(first.getByRole("region", { name: "Hestia connector" })).toBeVisible();
});
