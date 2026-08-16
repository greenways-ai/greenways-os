import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const extensionPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extensionWorker(worker) {
  return worker.url().startsWith("chrome-extension://");
}

async function discoverServiceWorker(context, timeout) {
  const existing = context.serviceWorkers().find(extensionWorker);
  if (existing) return existing;
  return context.waitForEvent("serviceworker", { predicate: extensionWorker, timeout });
}

export async function launchExtensionRuntime({
  root = extensionPath,
  profileDir = null,
  timeout = 60000,
} = {}) {
  const preservedProfile = Boolean(profileDir);
  const userDataDir = profileDir
    ? path.resolve(profileDir)
    : await mkdtemp(path.join(os.tmpdir(), "hara-chrome-"));
  await mkdir(userDataDir, { recursive: true });

  let context;
  let cleanupPromise = null;
  const cleanupProfile = () => {
    if (preservedProfile) return Promise.resolve();
    cleanupPromise ??= rm(userDataDir, { recursive: true, force: true });
    return cleanupPromise;
  };

  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${root}`,
        `--load-extension=${root}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    const serviceWorker = await discoverServiceWorker(context, timeout);
    const extensionId = new URL(serviceWorker.url()).host;

    let resolveClosed;
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    let closePromise = null;
    let observedClosed = false;
    const observeClosed = () => {
      if (observedClosed) return;
      observedClosed = true;
      resolveClosed();
      void cleanupProfile();
    };
    context.once("close", observeClosed);
    context.browser()?.once("disconnected", observeClosed);

    const close = () => {
      closePromise ??= (async () => {
        try {
          await context.close();
        } catch (error) {
          if (!observedClosed) throw error;
        } finally {
          observeClosed();
          await cleanupProfile();
        }
      })();
      return closePromise;
    };

    const openPanel = async ({ tabId = 0, respUrl = null } = {}) => {
      const query = new URLSearchParams({ tabId: String(tabId) });
      if (respUrl) query.set("resp", respUrl);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/src/panel.html?${query}`, { timeout });
      await page.waitForFunction(
        (requireResp) => {
          const ready = globalThis.hara?.ready;
          return Boolean(ready?.error)
            || (ready?.kernel === true && (!requireResp || ready.resp === "connected"));
        },
        Boolean(respUrl),
        { timeout },
      );
      const ready = await page.evaluate(() => globalThis.hara?.ready);
      if (ready?.error) throw new Error(`hara-chrome panel failed: ${ready.error}`);
      return page;
    };

    return {
      context,
      serviceWorker,
      extensionId,
      profileDir: userDataDir,
      preservedProfile,
      closed,
      close,
      openPanel,
    };
  } catch (error) {
    try { await context?.close(); } catch { /* retain the startup error */ }
    await cleanupProfile();
    throw error;
  }
}
