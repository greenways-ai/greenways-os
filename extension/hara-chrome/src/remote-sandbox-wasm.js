import { HtaContext } from "../vendor/hta.js";

const MAX_WASM_BYTES = 268_435_456;

function runtimeFactoryError(code, message) {
  const error = new Error(message);
  error.name = "RemoteSandboxRuntimeFactoryError";
  error.code = code;
  return error;
}

function checkedFunction(value, label) {
  if (typeof value !== "function") throw runtimeFactoryError("remote/runtime-config-invalid", `${label} must be a function`);
  return value;
}

function checkedModuleBytes(value) {
  const bytes = value instanceof Uint8Array
    ? value.slice()
    : value instanceof ArrayBuffer
      ? new Uint8Array(value.slice(0))
      : null;
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_WASM_BYTES) {
    throw runtimeFactoryError(
      "remote/runtime-config-invalid",
      `moduleBytes must contain between 1 and ${MAX_WASM_BYTES} bytes`,
    );
  }
  return bytes;
}

function checkedWorkerUrl(value) {
  if ((typeof value !== "string" && !(value instanceof URL)) || String(value).length === 0) {
    throw runtimeFactoryError("remote/runtime-config-invalid", "workerUrl must be a non-empty URL or string");
  }
  return value;
}

async function defaultDigestBytes(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) {
    throw runtimeFactoryError("remote/runtime-config-invalid", "Web Crypto SHA-256 is required for runtime binding");
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function cancellationError() {
  return runtimeFactoryError("remote/cancelled", "remote sandbox creation was cancelled");
}

export function createRestrictedBrowserWasmRuntimeFactory(options = {}) {
  const moduleBytes = checkedModuleBytes(options.moduleBytes);
  const workerUrl = checkedWorkerUrl(options.workerUrl);
  const WorkerCtor = checkedFunction(options.WorkerCtor ?? globalThis.Worker, "WorkerCtor");
  const HtaContextCtor = checkedFunction(options.HtaContextCtor ?? HtaContext, "HtaContextCtor");
  const digestBytes = checkedFunction(options.digestBytes ?? defaultDigestBytes, "digestBytes");
  const runtimeBuild = Promise.resolve(digestBytes(moduleBytes.slice()));

  return async function createRuntime({ request, descriptor, signal = null }) {
    if (signal?.aborted) throw cancellationError();
    const actualRuntimeBuild = await runtimeBuild;
    if (actualRuntimeBuild !== descriptor?.runtimeBuild) {
      throw runtimeFactoryError(
        "remote/runtime-build-mismatch",
        "host descriptor runtimeBuild does not match the staged Wasm artifact",
      );
    }
    if (signal?.aborted) throw cancellationError();

    let worker = null;
    let context = null;
    try {
      worker = new WorkerCtor(workerUrl, {
        type: "module",
        name: `hara-mcp-${request.requestId}`,
      });
      context = new HtaContextCtor({
        worker,
        moduleBytes: moduleBytes.slice(),
        hostCalls: Object.freeze({}),
        filesystemHost: null,
        handleTags: Object.freeze({}),
        kernelId: `MCP.${request.requestId}`,
      });
      context.remoteSandboxBoundary = Object.freeze({
        requestId: request.requestId,
        profile: request.profile,
        persistent: false,
        browser: false,
        network: false,
        filesystem: false,
      });
      if (signal?.aborted) {
        try { await context.close?.(); } catch { /* best effort */ }
        try { worker.terminate?.(); } catch { /* best effort */ }
        throw cancellationError();
      }
      return { worker, context, runtimeBuild: actualRuntimeBuild };
    } catch (error) {
      if (context) {
        try { await context.close?.(); } catch { /* best effort */ }
      }
      if (worker) {
        try { worker.terminate?.(); } catch { /* best effort */ }
      }
      throw error;
    }
  };
}
