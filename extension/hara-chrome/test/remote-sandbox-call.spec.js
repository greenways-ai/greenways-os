import { expect, test } from "@playwright/test";

const pageUrl = new URL("../src/runtime.html", import.meta.url).href;

test("remote qualified calls use eval-bound values in fresh real Wasm workers", async ({ page }) => {
  await page.goto(pageUrl);
  const proof = await page.evaluate(async () => {
    const { createRemoteSandboxExecutor } = await import("./remote-sandbox-executor.js");
    const { createRestrictedBrowserWasmRuntimeFactory } = await import("./remote-sandbox-wasm.js");
    const sha256 = async (value) => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    };

    const moduleBytes = new Uint8Array(await (await fetch("../vendor/hara.wasm")).arrayBuffer());
    const runtimeBuild = await sha256(moduleBytes);
    const workers = [];
    class TrackingWorker extends Worker {
      constructor(url, options) {
        super(url, options);
        workers.push({ name: options?.name ?? null });
      }
    }
    const factory = createRestrictedBrowserWasmRuntimeFactory({
      workerUrl: new URL("../vendor/hta-worker.js", location.href),
      moduleBytes,
      WorkerCtor: TrackingWorker,
    });
    const executor = createRemoteSandboxExecutor({ createRuntime: factory });
    const descriptor = {
      protocol: "hara.execution-host/0-alpha",
      hostId: "hara.chrome.call-proof",
      generation: 3,
      kind: "browser-wasm",
      state: "ready",
      backend: "raw-wasm-gate1",
      runtimeBuild,
      haraVersion: "raw-wasm-gate1",
      profiles: ["hara.mcp-pure/0-alpha"],
      operations: ["runtime.get", "sandbox.eval", "sandbox.call"],
      limits: { maxSourceBytes: 65536, maxOutputBytes: 1048576, maxWallMs: 30000 },
      observedAt: new Date().toISOString(),
    };
    const emptyDigest = await sha256("");
    const request = {
      protocol: "hara.execution-host/0-alpha",
      requestId: "00000000-0000-4000-8000-000000000191",
      operation: "sandbox.call",
      profile: "hara.mcp-pure/0-alpha",
      namespace: "std.foundation",
      symbol: "+",
      arguments: [40, 2],
      sourceDigest: emptyDigest,
      limits: { wallMs: 10000, outputBytes: 262144 },
    };
    const first = await executor.execute(request, { descriptor });
    const nestedPayload = { marker: "__hta_arg_0 ) (browser.dom/read)" };
    const second = await executor.execute({
      ...request,
      requestId: "00000000-0000-4000-8000-000000000192",
      arguments: [nestedPayload],
    }, { descriptor });
    const active = executor.active();
    await executor.close();
    return { first, second, nestedPayload, workers, active, runtimeBuild };
  });

  expect(proof.first.status).toBe("completed");
  expect(proof.first.value).toEqual({ text: "42", json: 42 });
  expect(proof.first.runtime.runtimeBuild).toBe(proof.runtimeBuild);
  expect(proof.second.status).toBe("failed");
  expect(JSON.stringify(proof.second)).not.toContain("browser.dom/read) enabled");
  expect(proof.nestedPayload.marker).toContain("browser.dom/read");
  expect(proof.workers).toHaveLength(2);
  expect(new Set(proof.workers.map(({ name }) => name)).size).toBe(2);
  expect(proof.active).toBe(0);
});
