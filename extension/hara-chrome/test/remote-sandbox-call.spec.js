import { expect, test } from "@playwright/test";

import { activeTabId, launchWithExtension } from "./extension.js";

test("restricted browser-Wasm call sends argument values as HTA bindings", async () => {
  const { context, extensionId, serviceWorker } = await launchWithExtension();
  try {
    const target = await context.newPage();
    await target.goto("about:blank");
    const tabId = await activeTabId(serviceWorker);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/panel.html?tabId=${tabId}`);

    const result = await page.evaluate(async () => {
      const [{ createRemoteSandboxExecutor }, { createRestrictedBrowserWasmRuntimeFactory }] =
        await Promise.all([
          import(chrome.runtime.getURL("src/remote-sandbox-executor.js")),
          import(chrome.runtime.getURL("src/remote-sandbox-wasm.js")),
        ]);
      const moduleBytes = new Uint8Array(
        await (await fetch(chrome.runtime.getURL("vendor/hara.wasm"))).arrayBuffer(),
      );
      const executor = createRemoteSandboxExecutor({
        createRuntime: createRestrictedBrowserWasmRuntimeFactory({
          moduleBytes,
          workerUrl: chrome.runtime.getURL("vendor/hta-worker.js"),
        }),
      });
      const descriptor = {
        protocol: "hara.execution-host/0-alpha",
        hostId: "hara.chrome.call-proof",
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
        requestId: "00000000-0000-4000-8000-000000000187",
        operation: "sandbox.call",
        profile: "hara.mcp-pure/0-alpha",
        namespace: "std.foundation",
        symbol: "+",
        arguments: [40, 2],
        sourceDigest: `sha256:${"2".repeat(64)}`,
        limits: { wallMs: 5_000, outputBytes: 262_144 },
      };
      try {
        return await executor.execute(request, { descriptor });
      } finally {
        await executor.close();
      }
    });

    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ text: "42", json: 42 });
    expect(result.runtime.backend).toBe("rust-wasm");
    expect(result.evidence.cleanup).toBe("completed");
  } finally {
    await context.close();
  }
});
