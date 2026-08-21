import { expect, test } from "@playwright/test";

const pageUrl = new URL("../src/runtime.html", import.meta.url).href;

test("remote executor uses fresh real Wasm sandboxes and denies browser authority", async ({ page }) => {
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
      hostId: "hara.chrome.browser-proof",
      generation: 1,
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
    const source = "(+ 19 23)";
    const request = {
      protocol: "hara.execution-host/0-alpha",
      requestId: "00000000-0000-4000-8000-000000000181",
      operation: "sandbox.eval",
      profile: "hara.mcp-pure/0-alpha",
      source,
      sourceDigest: await sha256(source),
      limits: { wallMs: 10000, outputBytes: 262144 },
    };
    const result = await executor.execute(request, { descriptor });
    const mismatchedBuild = await executor.execute(
      { ...request, requestId: "00000000-0000-4000-8000-000000000185" },
      { descriptor: { ...descriptor, runtimeBuild: `sha256:${"0".repeat(64)}` } },
    );
    const negativeSources = [
      "(require [chrome.api])",
      "(require [browser.dom])",
      "(require [browser.site.chatgpt])",
    ];
    const negatives = [];
    for (let index = 0; index < negativeSources.length; index += 1) {
      const deniedSource = negativeSources[index];
      negatives.push(await executor.execute({
        ...request,
        requestId: `00000000-0000-4000-8000-00000000018${index + 2}`,
        source: deniedSource,
        sourceDigest: await sha256(deniedSource),
      }, { descriptor }));
    }
    const active = executor.active();
    await executor.close();
    return { result, mismatchedBuild, negatives, workers, active, runtimeBuild };
  });

  expect(proof.result.status).toBe("completed");
  expect(proof.result.value).toEqual({ text: "42", json: 42 });
  expect(proof.result.evidence.cleanup).toBe("completed");
  expect(proof.result.runtime.runtimeBuild).toBe(proof.runtimeBuild);
  expect(proof.mismatchedBuild.status).toBe("failed");
  expect(proof.mismatchedBuild.diagnostics[0].code).toBe("remote/runtime-build-mismatch");
  expect(proof.negatives).toHaveLength(3);
  for (const denied of proof.negatives) {
    if (denied.status === "completed") {
      expect(denied.value?.text).toBe("nil");
    } else {
      expect(denied.status).toBe("failed");
      expect(denied.diagnostics[0].message).toMatch(/not found|could not locate|unresolved|namespace/i);
    }
    expect(JSON.stringify(denied)).not.toMatch(/chrome\.api|browser\.dom|browser\.site\.chatgpt.*enabled/i);
  }
  expect(proof.workers).toHaveLength(4);
  expect(new Set(proof.workers.map(({ name }) => name)).size).toBe(4);
  expect(proof.active).toBe(0);
});
