import { expect, test } from "@playwright/test";

import { activeTabId, launchWithExtension } from "./extension.js";

async function executorPage(context, extensionId, serviceWorker) {
  const target = await context.newPage();
  await target.goto("about:blank");
  const tabId = await activeTabId(serviceWorker);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/panel.html?tabId=${tabId}`);
  return page;
}

async function run(page, source, requestId) {
  return page.evaluate(async ({ source, requestId }) => {
    const [{ createRemoteSandboxExecutor }, { createRestrictedBrowserWasmRuntimeFactory }] =
      await Promise.all([
        import(chrome.runtime.getURL("src/remote-sandbox-executor.js")),
        import(chrome.runtime.getURL("src/remote-sandbox-wasm.js")),
      ]);
    const moduleBytes = new Uint8Array(
      await (await fetch(chrome.runtime.getURL("vendor/hara.wasm"))).arrayBuffer(),
    );
    const createRuntime = createRestrictedBrowserWasmRuntimeFactory({
      moduleBytes,
      workerUrl: chrome.runtime.getURL("vendor/hta-worker.js"),
    });
    const executor = createRemoteSandboxExecutor({ createRuntime });
    const descriptor = {
      protocol: "hara.execution-host/0-alpha",
      hostId: "hara.chrome.browser-proof",
      generation: 1,
      kind: "browser-wasm",
      state: "ready",
      backend: "rust-wasm",
      runtimeBuild: `sha256:${"1".repeat(64)}`,
      haraVersion: "browser-proof",
      profiles: ["hara.mcp-pure/0-alpha"],
      operations: ["runtime.get", "sandbox.eval", "sandbox.call"],
      limits: {
        maxSourceBytes: 65_536,
        maxOutputBytes: 1_048_576,
        maxWallMs: 30_000,
      },
      observedAt: new Date().toISOString(),
    };
    const request = {
      protocol: "hara.execution-host/0-alpha",
      requestId,
      operation: "sandbox.eval",
      profile: "hara.mcp-pure/0-alpha",
      source,
      sourceDigest: `sha256:${"2".repeat(64)}`,
      limits: { wallMs: 5_000, outputBytes: 262_144 },
    };
    try {
      return await executor.execute(request, { descriptor });
    } finally {
      await executor.close();
    }
  }, { source, requestId });
}

test("fresh restricted browser-Wasm worker evaluates Hara without the trusted broker", async () => {
  const { context, extensionId, serviceWorker } = await launchWithExtension();
  try {
    const page = await executorPage(context, extensionId, serviceWorker);
    const result = await run(page, "(+ 40 2)", "00000000-0000-4000-8000-000000000181");
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ text: "42", json: 42 });
    expect(result.runtime.backend).toBe("rust-wasm");
    expect(result.evidence.profile).toBe("hara.mcp-pure/0-alpha");
    expect(result.evidence.cleanup).toBe("completed");
  } finally {
    await context.close();
  }
});

test("fresh restricted browser-Wasm worker cannot require trusted browser namespaces", async () => {
  const { context, extensionId, serviceWorker } = await launchWithExtension();
  try {
    const page = await executorPage(context, extensionId, serviceWorker);
    for (const [index, namespace] of ["chrome.api", "browser.dom", "browser.site.chatgpt", "browser.site.tripo"].entries()) {
      const requestId = `00000000-0000-4000-8000-00000000018${index + 2}`;
      const result = await run(page, `(require [${namespace}])`, requestId);
      expect(result.status).toBe("failed");
      expect(result.value).toBeNull();
      expect(JSON.stringify(result)).not.toContain("HOST_CALL_PORT");
    }
  } finally {
    await context.close();
  }
});
