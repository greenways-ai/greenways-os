import { HtaContext } from "../vendor/hta.js";

function configError(message) {
  const error = new Error(message);
  error.name = "RemoteSandboxWasmError";
  error.code = "remote/wasm-config-invalid";
  return error;
}

function safeWorkerName(requestId) {
  return `hara-mcp-${String(requestId).replace(/[^A-Za-z0-9_.-]/gu, "-").slice(0, 80)}`;
}

/**
 * Builds the only production runtime factory accepted by the remote restricted
 * executor. Each invocation creates a dedicated raw Hara worker and HtaContext.
 * No broker, resources, filesystem host, or host-call service is installed.
 */
export function createRestrictedBrowserWasmRuntimeFactory(options = {}) {
  const WorkerImpl = options.WorkerImpl ?? globalThis.Worker;
  if (typeof WorkerImpl !== "function") throw configError("Worker is unavailable");
  if (!(options.moduleBytes instanceof Uint8Array) && !(options.moduleBytes instanceof ArrayBuffer)) {
    throw configError("moduleBytes must contain the staged Hara Wasm module");
  }
  if (typeof options.workerUrl !== "string" || options.workerUrl.length === 0) {
    throw configError("workerUrl is required");
  }

  const moduleBytes =
    options.moduleBytes instanceof Uint8Array ? options.moduleBytes : new Uint8Array(options.moduleBytes);
  const workerUrl = options.workerUrl;

  return async function createRuntime({ request }) {
    const worker = new WorkerImpl(workerUrl, {
      type: "module",
      name: safeWorkerName(request.requestId),
    });
    const context = new HtaContext({
      worker,
      moduleBytes,
      hostCalls: Object.freeze({}),
      filesystemHost: null,
      kernelId: `MCP.${request.requestId}`,
    });
    return { context, worker };
  };
}
