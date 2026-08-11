import { chromium, expect, test } from "@playwright/test";
import { build } from "esbuild";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("..", import.meta.url));
const fixtureEntry = fileURLToPath(new URL("fixtures/playground-ai-background-entry.js", import.meta.url));
const fixtureSecret = "fixture-secret-must-never-leave-the-worker";

async function testExtension() {
  const root = await mkdtemp(join(tmpdir(), "greenways-ai-e2e-"));
  const path = join(root, "extension");
  await cp(extensionPath, path, {
    recursive: true,
    filter(source) {
      const local = relative(extensionPath, source);
      return !local || !new Set(["node_modules", "release", "test", "test-results", "playwright-report"])
        .has(local.split(sep)[0]);
    },
  });
  await build({
    entryPoints: [fixtureEntry],
    outfile: join(path, "dist", "background.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    loader: { ".hal": "text", ".edn": "text" },
    external: ["node:worker_threads"],
  });
  return { path, dispose: () => rm(root, { recursive: true, force: true }) };
}

const fixtureHtml = `<!doctype html><meta charset="utf-8"><script>
  window.callGreenways = (operation, payload = {}, requestId = "browser/0123456789abcdef") =>
    new Promise((resolve) => {
      const listener = (event) => {
        if (event.data?.source !== "greenways-os" || event.data?.requestId !== requestId) return;
        removeEventListener("message", listener);
        resolve(event.data);
      };
      addEventListener("message", listener);
      postMessage({
        source: "hara-playground",
        direction: "request",
        protocol: "greenways-playground-ai/0-alpha",
        requestId,
        operation,
        payload,
      }, location.origin);
    });
</script>`;

test("exact production origin crosses the real extension bridge with closed projections", async () => {
  const extension = await testExtension();
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension.path}`, `--load-extension=${extension.path}`],
  });
  try {
    await context.route("https://playground.hara-lang.org/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: fixtureHtml,
    }));
    const page = await context.newPage();
    await page.goto("https://playground.hara-lang.org/fixture");
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");

    const status = await page.evaluate(() => window.callGreenways("status"));
    expect(status.ok).toBe(true);
    expect(status.capability.allowed).toBe(true);

    const request = {
      profileId: "openai.fixture",
      model: "gpt-fixture",
      messages: [{ role: "user", content: "hello" }],
      maxOutputTokens: 32,
      timeoutMs: 5000,
    };
    const generated = await page.evaluate((payload) => window.callGreenways("generate", payload), request);
    expect(generated.result.output).toBe("Deterministic fixture completion");
    expect(JSON.stringify(generated)).not.toContain(fixtureSecret);
    expect(await page.evaluate((secret) => JSON.stringify({
      localStorage: { ...localStorage },
      sessionStorage: { ...sessionStorage },
      body: document.body.innerHTML,
    }).includes(secret), fixtureSecret)).toBe(false);

    await worker.evaluate(() => { globalThis.__greenwaysAiFixture.mode = "denied"; });
    const denied = await page.evaluate((payload) => window.callGreenways(
      "generate", payload, "browser/denied-0123456789",
    ), request);
    expect(denied.code).toBe("CAPABILITY_DENIED");

    await worker.evaluate(() => { globalThis.__greenwaysAiFixture.mode = "permission-denied"; });
    const permission = await page.evaluate((payload) => window.callGreenways(
      "generate", payload, "browser/permission-123456",
    ), request);
    expect(permission.code).toBe("PROVIDER_PERMISSION_REQUIRED");

    await worker.evaluate(() => { globalThis.__greenwaysAiFixture.mode = "allowed"; });
    const unsupported = await page.evaluate((payload) => window.callGreenways(
      "generate", { ...payload, profileId: "missing.fixture" }, "browser/profile-0123456789",
    ), request);
    expect(unsupported.code).toBe("PROVIDER_PROFILE_NOT_FOUND");

    const cancellableId = "browser/cancellable-1234567";
    const cancellable = page.evaluate(({ payload, requestId }) => window.callGreenways(
      "generate", { ...payload, model: "fixture/cancel" }, requestId,
    ), { payload: request, requestId: cancellableId });
    await page.waitForTimeout(25);
    const cancelled = await page.evaluate((requestId) => window.callGreenways(
      "cancel", { requestId }, "browser/cancel-0123456789",
    ), cancellableId);
    expect(cancelled.result.cancelled).toBe(true);
    expect((await cancellable).code).toBe("REQUEST_CANCELLED");

    await context.route("https://playground.hara-lang.io/**", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: fixtureHtml,
    }));
    const lookalike = await context.newPage();
    await lookalike.goto("https://playground.hara-lang.io/fixture");
    const lookalikeResponse = await lookalike.evaluate(() => Promise.race([
      window.callGreenways("status", {}, "browser/lookalike-12345678"),
      new Promise((resolve) => setTimeout(() => resolve(null), 100)),
    ]));
    expect(lookalikeResponse).toBeNull();

    const productionBundle = await readFile(join(extensionPath, "dist", "background.js"), "utf8");
    expect(productionBundle).not.toContain(fixtureSecret);
  } finally {
    await context.close();
    await extension.dispose();
  }
});
