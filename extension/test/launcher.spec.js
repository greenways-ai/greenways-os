import { test as base, chromium, expect } from "@playwright/test";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));
const WORKER_LIFECYCLE_TIMEOUT = 5_000;

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
    let worker = context.serviceWorkers().find(isPackagedKernelWorker);
    if (!worker) {
      worker = await context.waitForEvent("serviceworker", {
        predicate: isPackagedKernelWorker,
      });
    }
    await use(new URL(worker.url()).host);
  },
});

function isPackagedKernelWorker(worker) {
  const url = new URL(worker.url());
  return url.protocol === "chrome-extension:" && url.pathname === "/dist/background.js";
}

function extensionWorkerUrl(extensionId) {
  return `chrome-extension://${extensionId}/dist/background.js`;
}

function extensionWorker(context, extensionId) {
  return context.serviceWorkers().find((worker) => (
    worker.url() === extensionWorkerUrl(extensionId)
  ));
}

function runningWorkerVersion(versions, scriptURL, targetId) {
  return versions.find((candidate) => (
    candidate.scriptURL === scriptURL
    && candidate.targetId === targetId
    && candidate.status === "activated"
    && candidate.runningStatus === "running"
  ));
}

function stoppedWorkerVersion(versions, versionId) {
  return versions.find((candidate) => (
    candidate.versionId === versionId
    && candidate.runningStatus === "stopped"
  ));
}

function restartedWorkerVersion(versions, stopped) {
  if (!stopped) return undefined;
  return versions.find((candidate) => (
    candidate.versionId === stopped.versionId
    && candidate.scriptURL === stopped.scriptURL
    && candidate.registrationId === stopped.registrationId
    && candidate.status === "activated"
    && candidate.runningStatus === "running"
  ));
}

test("cold-restart helper follows one exact service-worker version", () => {
  const scriptURL = "chrome-extension://greenways-test/dist/background.js";
  const targetId = "target/exact";
  const running = {
    versionId: "version/exact",
    registrationId: "registration/exact",
    scriptURL,
    targetId,
    status: "activated",
    runningStatus: "running",
  };
  const stopped = { ...running, targetId: undefined, runningStatus: "stopped" };
  const restarted = { ...running };
  const candidates = [
    { ...running, versionId: "version/wrong-script", scriptURL: `${scriptURL}.map` },
    { ...running, versionId: "version/wrong-target", targetId: "target/other" },
    { ...running, versionId: "version/not-running", runningStatus: "stopping" },
    running,
  ];

  expect(runningWorkerVersion(candidates, scriptURL, targetId)).toBe(running);
  expect(stoppedWorkerVersion([running, { ...stopped, versionId: "version/other" }, stopped], running.versionId)).toBe(stopped);
  expect(restartedWorkerVersion([restarted], stopped)).toBe(restarted);
});

async function settleBestEffort(operation) {
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      Promise.resolve(operation()).then(finish, finish);
    } catch {
      finish();
    }
  });
}

async function restartExtensionWorker(context, extensionId, page, wake) {
  const worker = extensionWorker(context, extensionId);
  expect(worker, "running extension service worker").toBeTruthy();
  const scriptURL = worker.url();
  const session = await context.newCDPSession(page);
  let domainEnabled = false;
  let target;
  let version;
  let stoppedVersion;
  let restartedVersion;
  const captureVersion = ({ versions }) => {
    version = runningWorkerVersion(versions, scriptURL, target.targetId) ?? version;
    if (!version) return;
    const stopped = stoppedWorkerVersion(versions, version.versionId);
    if (!stoppedVersion && stopped) {
      stoppedVersion = stopped;
      return;
    }
    restartedVersion = restartedWorkerVersion(versions, stoppedVersion) ?? restartedVersion;
  };
  try {
    const { targetInfos } = await session.send("Target.getTargets");
    const targets = targetInfos.filter(({ type, url }) => (
      type === "service_worker"
      && url === scriptURL
    ));
    expect(targets, "one CDP target for the running extension worker").toHaveLength(1);
    [target] = targets;

    session.on("ServiceWorker.workerVersionUpdated", captureVersion);
    await session.send("ServiceWorker.enable");
    domainEnabled = true;
    await expect.poll(() => version, {
      message: "running CDP version for the extension background worker",
      timeout: WORKER_LIFECYCLE_TIMEOUT,
    }).toBeTruthy();

    await Promise.all([
      expect.poll(() => stoppedVersion, {
        message: `CDP version ${version.versionId} to stop`,
        timeout: WORKER_LIFECYCLE_TIMEOUT,
      }).toBeTruthy(),
      session.send("ServiceWorker.stopWorker", { versionId: version.versionId }),
    ]);

    await wake();
    await expect.poll(() => restartedVersion, {
      message: `CDP version ${version.versionId} to restart after stopping`,
      timeout: WORKER_LIFECYCLE_TIMEOUT,
    }).toBeTruthy();

    return { stoppedVersion, restartedVersion };
  } finally {
    session.off("ServiceWorker.workerVersionUpdated", captureVersion);
    if (domainEnabled) await settleBestEffort(() => session.send("ServiceWorker.disable"));
    await settleBestEffort(() => session.detach());
  }
}

test("launcher restores Worlds and manages the current Chats surface", async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/launcher.html#app-chats`);

  const installed = page.getByRole("region", { name: "Installed apps" });
  const available = page.getByRole("region", { name: "Available apps" });
  await expect(installed.getByRole("heading", { name: "Worlds" })).toBeVisible();
  for (const name of ["Chats", "Greenways for ChatGPT", "Userscripts", "Hara Playground"]) {
    await expect(available.getByRole("heading", { name })).toBeVisible();
  }
  await expect(page.getByText("Install Chats locally to continue")).toBeVisible();

  const chatsCard = page.locator('[data-app-card="chats"]');
  const install = chatsCard.getByRole("button", { name: "Install locally" });
  await expect(install).toBeEnabled();
  await install.click();
  await expect(page.getByRole("status").last()).toContainText("Chats was installed");
  await expect(chatsCard.getByRole("button", { name: "Open" })).toBeVisible();
  await chatsCard.getByRole("button", { name: "Open" }).click();

  const surface = page.getByRole("region", { name: "Chats" });
  await expect(surface).toBeVisible();
  await expect(surface).toContainText("Conversation content stays in this browser");
  await surface.getByRole("button", { name: "Close Chats" }).click();
  await expect(surface).toBeHidden();

  await chatsCard.getByRole("button", { name: "Remove Chats" }).click();
  await expect(chatsCard.getByRole("button", { name: "Install locally" })).toBeVisible();
});

test("packaged Worlds boots through the browser-wide kernel host", async ({ context, extensionId }) => {
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(`chrome-extension://${extensionId}/src/world.html`);

  await expect(page.getByRole("heading", { name: /Enter a living world/i })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("two launchers converge globally, isolate provider surfaces, and survive a cold worker restart", async ({
  context,
  extensionId,
}) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([
    first.goto(`chrome-extension://${extensionId}/src/launcher.html#apps`),
    second.goto(`chrome-extension://${extensionId}/src/launcher.html#apps`),
  ]);
  await Promise.all([
    expect(first.getByRole("status").last()).toContainText("Local kernel ready"),
    expect(second.getByRole("status").last()).toContainText("Local kernel ready"),
  ]);

  const firstCard = first.locator('[data-app-card="chatgpt-provider"]');
  const secondCard = second.locator('[data-app-card="chatgpt-provider"]');
  await firstCard.getByRole("button", { name: "Install locally" }).click();
  await expect(first.getByRole("status").last()).toContainText(
    "Greenways for ChatGPT was installed",
  );
  await expect(secondCard.getByRole("button", { name: "Open" })).toBeVisible();

  await firstCard.getByRole("button", { name: "Open" }).click();
  await expect(first.getByRole("status").last()).toContainText(
    "Greenways for ChatGPT opened",
  );
  await expect(first.getByRole("region", { name: "Greenways for ChatGPT" })).toBeVisible();
  await expect(second.getByRole("region", { name: "Greenways for ChatGPT" })).toBeHidden();

  const { stoppedVersion, restartedVersion } = await restartExtensionWorker(
    context,
    extensionId,
    second,
    () => secondCard.getByRole("button", { name: "Open" }).click(),
  );

  expect(restartedVersion.versionId).toBe(stoppedVersion.versionId);
  await expect(second.getByRole("status").last()).toContainText(
    "Greenways for ChatGPT opened",
  );
  await expect(second.getByRole("region", { name: "Greenways for ChatGPT" })).toBeVisible();
  await expect(first.getByRole("region", { name: "Greenways for ChatGPT" })).toBeVisible();
});
