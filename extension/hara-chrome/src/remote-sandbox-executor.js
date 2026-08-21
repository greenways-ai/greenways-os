import {
  EXECUTION_RESULT_PROTOCOL,
  PURE_PROFILE,
  assertResultBound,
  cloneJson,
  parseExecutionRequest,
  parseHostDescriptor,
} from "./remote-host-protocol.js";

const MAX_DEPTH = 32;
const MAX_COLLECTION = 1_024;

function executorError(code, message, data = null) {
  const error = new Error(message);
  error.name = "RemoteSandboxExecutorError";
  error.code = code;
  error.data = data;
  return error;
}

function checkedFunction(value, label) {
  if (typeof value !== "function") throw executorError("remote/executor-config-invalid", `${label} must be a function`);
  return value;
}

function textBytes(value) {
  return new TextEncoder().encode(value).byteLength;
}

function nowIso(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw executorError("remote/clock-invalid", "executor clock returned an invalid date");
  return date.toISOString();
}

function errorMessage(error) {
  return String(error?.message ?? error ?? "remote Hara execution failed").slice(0, 8_192);
}

function errorCode(error, fallback = "remote/execution-failed") {
  const value = typeof error?.code === "string" ? error.code : fallback;
  return value.slice(0, 128);
}

function statusFor(error, cancellation) {
  if (cancellation === "deadline-exceeded" || error?.code === "remote/timed-out") return "timed-out";
  if (cancellation || error?.name === "AbortError" || error?.code === "remote/cancelled") return "cancelled";
  return "failed";
}

function displayScalar(value) {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") return String(value);
  if (value?.constructor?.name === "HtaKeyword" && typeof value.name === "string") return `:${value.name}`;
  if (value?.constructor?.name === "HtaSymbol" && typeof value.name === "string") return value.name;
  return null;
}

function displayValue(value, depth = 0) {
  const scalar = displayScalar(value);
  if (scalar !== null) return scalar;
  if (depth > MAX_DEPTH) throw executorError("remote/result-not-transferable", "result exceeds display nesting limit");
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION) throw executorError("remote/result-not-transferable", "result collection is too large");
    return `[${value.map((entry) => displayValue(entry, depth + 1)).join(" ")}]`;
  }
  if (value instanceof Map) {
    if (value.size > MAX_COLLECTION) throw executorError("remote/result-not-transferable", "result map is too large");
    return `{${[...value.entries()].map(([key, entry]) => `${displayValue(key, depth + 1)} ${displayValue(entry, depth + 1)}`).join(" ")}}`;
  }
  throw executorError(
    "remote/result-not-transferable",
    `result type ${value?.constructor?.name ?? typeof value} cannot cross the remote execution boundary`,
  );
}

function jsonProjection(value, depth = 0) {
  if (depth > MAX_DEPTH) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COLLECTION) return undefined;
    const projected = [];
    for (const entry of value) {
      const item = jsonProjection(entry, depth + 1);
      if (item === undefined && entry !== undefined) return undefined;
      projected.push(item ?? null);
    }
    return projected;
  }
  if (value instanceof Map) {
    if (value.size > MAX_COLLECTION) return undefined;
    const projected = {};
    for (const [key, entry] of value) {
      if (typeof key !== "string" || Object.hasOwn(projected, key)) return undefined;
      const item = jsonProjection(entry, depth + 1);
      if (item === undefined && entry !== undefined) return undefined;
      projected[key] = item ?? null;
    }
    return projected;
  }
  return undefined;
}

export function projectRemoteValue(value, outputBytes) {
  const text = displayValue(value);
  const json = jsonProjection(value);
  const projection = json === undefined ? { text } : { text, json };
  if (textBytes(JSON.stringify(projection)) > outputBytes) {
    throw executorError("remote/limit-exceeded", `result projection exceeds ${outputBytes} bytes`);
  }
  return projection;
}

export function buildBoundCall(request) {
  if (request.operation !== "sandbox.call") throw executorError("remote/operation-invalid", "bound call requires sandbox.call");
  const callable = `${request.namespace}/${request.symbol}`;
  const placeholders = request.arguments.map((_, index) => `__hta_arg_${index}`);
  return {
    source: `(${callable}${placeholders.length ? ` ${placeholders.join(" ")}` : ""})`,
    bindings: cloneJson(request.arguments),
  };
}

function makeResult({ request, descriptor, status, value = null, diagnostic = null, startedAt, completedAt, cleanup }) {
  const elapsedMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  const result = {
    protocol: EXECUTION_RESULT_PROTOCOL,
    requestId: request.requestId,
    runId: `wasm:${request.requestId}`,
    status,
    value,
    stdout: "",
    stderr: status === "failed" && diagnostic ? diagnostic.message : "",
    diagnostics: diagnostic ? [diagnostic] : [],
    runtime: {
      hostId: descriptor.hostId,
      hostGeneration: descriptor.generation,
      backend: descriptor.backend,
      runtimeBuild: descriptor.runtimeBuild,
      haraVersion: descriptor.haraVersion,
    },
    evidence: {
      profile: PURE_PROFILE,
      sourceDigest: request.sourceDigest,
      startedAt,
      completedAt,
      elapsedMs,
      cleanup,
    },
  };
  return assertResultBound(result, request, descriptor);
}

function assertDescriptorFor(request, descriptor) {
  parseHostDescriptor(descriptor);
  if (descriptor.kind !== "browser-wasm") {
    throw executorError("remote/host-incompatible", "restricted browser executor requires a browser-wasm host");
  }
  if (!descriptor.profiles.includes(PURE_PROFILE)) {
    throw executorError("remote/host-incompatible", `host does not advertise ${PURE_PROFILE}`);
  }
  if (!descriptor.operations.includes(request.operation)) {
    throw executorError("remote/operation-unsupported", `host does not advertise ${request.operation}`);
  }
}

function raceCancellation(pending, signal, timeoutMs, timers) {
  let cancellation = null;
  let timeout = null;
  let abortListener = null;
  const cancelPending = (reason) => {
    if (cancellation) return;
    cancellation = reason;
    try { pending?.cancel?.(); } catch { /* best effort */ }
  };
  const cancelled = new Promise((_, reject) => {
    if (signal?.aborted) {
      cancelPending("client-cancelled");
      reject(executorError("remote/cancelled", "remote Hara execution was cancelled"));
      return;
    }
    abortListener = () => {
      cancelPending("client-cancelled");
      reject(executorError("remote/cancelled", "remote Hara execution was cancelled"));
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    timeout = timers.setTimeout(() => {
      cancelPending("deadline-exceeded");
      reject(executorError("remote/timed-out", "remote Hara execution exceeded its wall-clock limit"));
    }, timeoutMs);
  });
  return {
    promise: Promise.race([Promise.resolve(pending), cancelled]),
    cancellation: () => cancellation,
    dispose() {
      if (timeout !== null) timers.clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    },
  };
}

async function closeRuntime(runtime) {
  let certain = true;
  try {
    await runtime.context?.close?.();
  } catch {
    certain = false;
  }
  try {
    runtime.worker?.terminate?.();
  } catch {
    certain = false;
  }
  return certain ? "completed" : "uncertain";
}

export function createRemoteSandboxExecutor(options = {}) {
  const createRuntime = checkedFunction(options.createRuntime, "createRuntime");
  const now = checkedFunction(options.now ?? (() => new Date()), "now");
  const timers = {
    setTimeout: checkedFunction(options.setTimeoutImpl ?? setTimeout, "setTimeoutImpl"),
    clearTimeout: checkedFunction(options.clearTimeoutImpl ?? clearTimeout, "clearTimeoutImpl"),
  };
  const active = new Map();
  let closed = false;

  async function execute(input, { signal = null, descriptor } = {}) {
    if (closed) throw executorError("remote/executor-closed", "restricted remote executor is closed");
    const request = cloneJson(parseExecutionRequest(input));
    const host = cloneJson(parseHostDescriptor(descriptor));
    assertDescriptorFor(request, host);
    if (active.has(request.requestId)) throw executorError("remote/request-busy", `request ${request.requestId} is already active`);

    const startedAt = nowIso(now);
    let runtime = null;
    let cancellation = null;
    let projected = null;
    let failure = null;
    let cleanup = "uncertain";

    try {
      runtime = await createRuntime({ request: cloneJson(request), descriptor: cloneJson(host) });
      if (!runtime?.context?.call) throw executorError("remote/runtime-invalid", "runtime factory must return a HtaContext-like call surface");
      active.set(request.requestId, runtime);

      let pending;
      if (request.operation === "sandbox.eval") {
        pending = runtime.context.call("eval", [request.source]);
      } else if (request.operation === "sandbox.call") {
        const bound = buildBoundCall(request);
        pending = runtime.context.call("eval-bound", [bound.source, bound.bindings]);
      } else {
        throw executorError("remote/operation-unsupported", `${request.operation} is not implemented by the browser-Wasm executor`);
      }
      runtime.pending = pending;

      const raced = raceCancellation(pending, signal, request.limits.wallMs, timers);
      try {
        projected = projectRemoteValue(await raced.promise, request.limits.outputBytes);
      } catch (error) {
        cancellation = raced.cancellation();
        failure = error;
      } finally {
        raced.dispose();
      }
    } catch (error) {
      failure = error;
    } finally {
      active.delete(request.requestId);
      if (runtime) cleanup = await closeRuntime(runtime);
    }

    const completedAt = nowIso(now);
    if (!failure) {
      return makeResult({ request, descriptor: host, status: "completed", value: projected, startedAt, completedAt, cleanup });
    }

    const status = statusFor(failure, cancellation);
    const diagnostic = {
      code: errorCode(failure, status === "cancelled" ? "remote/cancelled" : status === "timed-out" ? "remote/timed-out" : "remote/execution-failed"),
      severity: status === "failed" ? "error" : "warning",
      message: errorMessage(failure),
    };
    return makeResult({ request, descriptor: host, status, diagnostic, startedAt, completedAt, cleanup });
  }

  async function cancel(requestId) {
    const runtime = active.get(requestId);
    if (!runtime) return false;
    try { runtime.pending?.cancel?.(); } catch { /* best effort */ }
    try { runtime.worker?.terminate?.(); } catch { /* best effort */ }
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    const runtimes = [...active.values()];
    active.clear();
    for (const runtime of runtimes) {
      try { runtime.pending?.cancel?.(); } catch { /* best effort */ }
    }
    await Promise.allSettled(runtimes.map(closeRuntime));
  }

  return Object.freeze({ execute, cancel, close, active: () => active.size });
}

export { executorError as remoteSandboxExecutorError };
