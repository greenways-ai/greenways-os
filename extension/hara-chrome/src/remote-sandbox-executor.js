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
const SAFE_NAMESPACE = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/u;
const SAFE_SYMBOL = /^[A-Za-z_+*?!<>=-][A-Za-z0-9_+*?!<>=.-]*$/u;

export const REMOTE_SANDBOX_EXECUTION_OPERATIONS = Object.freeze(["sandbox.eval", "sandbox.call"]);

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

function cancellationError(reason) {
  return reason === "deadline-exceeded"
    ? executorError("remote/timed-out", "remote Hara execution exceeded its wall-clock limit")
    : executorError("remote/cancelled", "remote Hara execution was cancelled");
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
    const keys = new Set();
    const entries = [];
    for (const [key, entry] of value) {
      if (typeof key !== "string" || keys.has(key)) return undefined;
      const item = jsonProjection(entry, depth + 1);
      if (item === undefined && entry !== undefined) return undefined;
      keys.add(key);
      entries.push([key, item ?? null]);
    }
    return Object.fromEntries(entries);
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

function assertSafeCallTarget(namespace, symbol) {
  if (!SAFE_NAMESPACE.test(namespace) || !SAFE_SYMBOL.test(symbol)) {
    throw executorError("remote/call-target-invalid", "qualified Hara call target contains unsupported syntax");
  }
}

export function buildBoundCall(request) {
  if (request.operation !== "sandbox.call") throw executorError("remote/operation-invalid", "bound call requires sandbox.call");
  assertSafeCallTarget(request.namespace, request.symbol);
  const callable = `${request.namespace}/${request.symbol}`;
  const placeholders = request.arguments.map((_, index) => `__hta_arg_${index}`);
  const invocation = `(${callable}${placeholders.length ? ` ${placeholders.join(" ")}` : ""})`;
  return {
    source: request.source ? `${request.source}\n${invocation}` : invocation,
    bindings: cloneJson(request.arguments),
  };
}

async function defaultSourceDigest(source) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) {
    throw executorError("remote/executor-config-invalid", "Web Crypto SHA-256 is required for source binding");
  }
  const bytes = new TextEncoder().encode(source);
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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

function requestSource(request) {
  return typeof request.source === "string" ? request.source : "";
}

function assertDescriptorFor(request, descriptor) {
  parseHostDescriptor(descriptor);
  if (descriptor.kind !== "browser-wasm") {
    throw executorError("remote/host-incompatible", "restricted browser executor requires a browser-wasm host");
  }
  if (descriptor.state !== "ready") {
    throw executorError("remote/host-incompatible", "restricted browser executor requires a ready host descriptor");
  }
  if (!descriptor.profiles.includes(PURE_PROFILE)) {
    throw executorError("remote/host-incompatible", `host does not advertise ${PURE_PROFILE}`);
  }
  const unsupported = descriptor.operations.filter(
    (operation) => operation !== "runtime.get" && !REMOTE_SANDBOX_EXECUTION_OPERATIONS.includes(operation),
  );
  if (unsupported.length) {
    throw executorError(
      "remote/host-incompatible",
      `restricted browser executor cannot advertise unsupported operations: ${unsupported.join(", ")}`,
    );
  }
  if (!descriptor.operations.includes(request.operation)) {
    throw executorError("remote/operation-unsupported", `host does not advertise ${request.operation}`);
  }
  if (request.limits.wallMs > descriptor.limits.maxWallMs) {
    throw executorError("remote/limit-exceeded", "request wall-clock limit exceeds the host descriptor");
  }
  if (request.limits.outputBytes > descriptor.limits.maxOutputBytes) {
    throw executorError("remote/limit-exceeded", "request output limit exceeds the host descriptor");
  }
  if (textBytes(requestSource(request)) > descriptor.limits.maxSourceBytes) {
    throw executorError("remote/limit-exceeded", "request source exceeds the host descriptor");
  }
}

function createCancellation(entry, signal, timeoutMs, timers) {
  let rejectCancellation;
  let timeout = null;
  let abortListener = null;
  const promise = new Promise((_, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (reason = "client-cancelled") => {
    if (entry.cancelReason) return false;
    entry.cancelReason = reason;
    try { entry.controller.abort(reason); } catch { /* best effort */ }
    try { entry.pending?.cancel?.(); } catch { /* best effort */ }
    try { entry.runtime?.worker?.terminate?.(); } catch { /* best effort */ }
    rejectCancellation(cancellationError(reason));
    return true;
  };
  abortListener = () => cancel(signal?.reason === "deadline-exceeded" ? "deadline-exceeded" : "client-cancelled");
  if (signal?.aborted) abortListener();
  else signal?.addEventListener("abort", abortListener, { once: true });
  timeout = timers.setTimeout(() => cancel("deadline-exceeded"), timeoutMs);
  return {
    promise,
    cancel,
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

async function closeEntryRuntime(entry) {
  if (!entry.runtime) return "uncertain";
  entry.cleanupPromise ??= closeRuntime(entry.runtime);
  return await entry.cleanupPromise;
}

export function createRemoteSandboxExecutor(options = {}) {
  const createRuntime = checkedFunction(options.createRuntime, "createRuntime");
  const digestSource = checkedFunction(options.digestSource ?? defaultSourceDigest, "digestSource");
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
    const entry = {
      requestId: request.requestId,
      controller: new AbortController(),
      runtime: null,
      pending: null,
      cancelReason: null,
      cleanupPromise: null,
      cancellation: null,
    };
    entry.cancellation = createCancellation(entry, signal, request.limits.wallMs, timers);
    active.set(request.requestId, entry);

    let cancellation = null;
    let projected = null;
    let failure = null;
    let cleanup = "uncertain";

    try {
      const actualDigest = await Promise.race([
        Promise.resolve(digestSource(requestSource(request))),
        entry.cancellation.promise,
      ]);
      if (actualDigest !== request.sourceDigest) {
        throw executorError("remote/source-digest-mismatch", "request source does not match its SHA-256 digest");
      }

      const runtimePromise = Promise.resolve().then(() => createRuntime({
        request: cloneJson(request),
        descriptor: cloneJson(host),
        signal: entry.controller.signal,
      }));
      runtimePromise
        .then(async (runtime) => {
          entry.runtime = runtime;
          if (entry.cancelReason || closed) await closeEntryRuntime(entry);
        })
        .catch(() => {});
      entry.runtime = await Promise.race([runtimePromise, entry.cancellation.promise]);
      if (!entry.runtime?.context?.call) {
        throw executorError("remote/runtime-invalid", "runtime factory must return a HtaContext-like call surface");
      }
      if (entry.cancelReason) throw cancellationError(entry.cancelReason);

      if (request.operation === "sandbox.eval") {
        entry.pending = entry.runtime.context.call("eval", [request.source]);
      } else if (request.operation === "sandbox.call") {
        const bound = buildBoundCall(request);
        entry.pending = entry.runtime.context.call("eval-bound", [bound.source, bound.bindings]);
      } else {
        throw executorError("remote/operation-unsupported", `${request.operation} is not implemented by the browser-Wasm executor`);
      }
      if (entry.cancelReason) {
        try { entry.pending?.cancel?.(); } catch { /* best effort */ }
        throw cancellationError(entry.cancelReason);
      }
      projected = projectRemoteValue(
        await Promise.race([Promise.resolve(entry.pending), entry.cancellation.promise]),
        request.limits.outputBytes,
      );
    } catch (error) {
      cancellation = entry.cancelReason;
      failure = error;
    } finally {
      entry.cancellation.dispose();
      active.delete(request.requestId);
      cleanup = await closeEntryRuntime(entry);
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

  async function cancel(requestId, reason = "client-cancelled") {
    const entry = active.get(requestId);
    if (!entry) return false;
    return entry.cancellation.cancel(reason === "deadline-exceeded" ? reason : "client-cancelled");
  }

  async function close() {
    if (closed) return;
    closed = true;
    const entries = [...active.values()];
    for (const entry of entries) entry.cancellation.cancel("relay-closing");
    await Promise.allSettled(entries.map(closeEntryRuntime));
  }

  return Object.freeze({ execute, cancel, close, active: () => active.size });
}

export { executorError as remoteSandboxExecutorError };
