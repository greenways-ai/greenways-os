import {
  EXECUTION_RESULT_PROTOCOL,
  LOOPBACK_RELAY_PROTOCOL,
  RELAY_MAX_BODY_BYTES,
  RELAY_MAX_POLL_MS,
  RemoteHostProtocolError,
  assertResultBound,
  canonicalJson,
  cloneJson,
  parseAcceptedResponse,
  parseExecutionResult,
  parseHostDescriptor,
  parseRegisterResponse,
  parseRelayCommand,
  parseRelayError,
  validatePairingToken,
  validateRelayBaseUrl,
} from "./remote-host-protocol.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_MIN_BACKOFF_MS = 100;
const DEFAULT_MAX_BACKOFF_MS = 5_000;
const DEFAULT_STOP_GRACE_MS = 1_000;
const DEFAULT_HISTORY_LIMIT = 64;

class RelayHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "RelayHttpError";
    this.status = status;
    this.code = code;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject, settled: false };
}

function settleResolve(entry, value) {
  if (entry.settled) return;
  entry.settled = true;
  entry.resolve(value);
}

function settleReject(entry, error) {
  if (entry.settled) return;
  entry.settled = true;
  entry.reject(error);
}

function clientError(code, message, data = null) {
  const error = new Error(message);
  error.name = "HaraRelayHostClientError";
  error.code = code;
  error.data = data;
  return error;
}

function checkedInteger(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw clientError("remote/config-invalid", `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function checkedFunction(value, label) {
  if (typeof value !== "function") throw clientError("remote/config-invalid", `${label} must be a function`);
  return value;
}

function redactMessage(error, token) {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = token && raw.includes(token) ? raw.split(token).join("[redacted]") : raw;
  return redacted.slice(0, 1_024) || "remote host operation failed";
}

function errorProjection(error, token) {
  return {
    code: typeof error?.code === "string" ? error.code.slice(0, 128) : "remote/unavailable",
    message: redactMessage(error, token),
  };
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === "remote/stopped";
}

function retryable(error) {
  if (error instanceof RemoteHostProtocolError) return false;
  if (error instanceof RelayHttpError) {
    return error.status >= 500 || error.status === 408 || error.status === 425 || error.status === 429;
  }
  return !isAbort(error);
}

function wait(ms, signal, setTimeoutImpl, clearTimeoutImpl) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(clientError("remote/stopped", "remote host client stopped"));
  return new Promise((resolve, reject) => {
    const timer = setTimeoutImpl(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeoutImpl(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(clientError("remote/stopped", "remote host client stopped"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBoundedJson(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw clientError("remote/body-too-large", `relay response exceeds ${maxBytes} bytes`);
  }

  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // best effort
        }
        throw clientError("remote/body-too-large", `relay response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const text = await response.text();
    bytes = new TextEncoder().encode(text);
    if (bytes.byteLength > maxBytes) throw clientError("remote/body-too-large", `relay response exceeds ${maxBytes} bytes`);
  }

  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  try {
    return JSON.parse(text);
  } catch {
    throw clientError("remote/response-invalid", "relay returned invalid JSON");
  }
}

function boundedMapSet(map, key, value, limit) {
  if (map.has(key)) map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function terminalStatus(cancelReason) {
  if (cancelReason === "deadline-exceeded") return "timed-out";
  if (cancelReason === "client-cancelled" || cancelReason === "relay-closing") return "cancelled";
  return "failed";
}

function failureResult({ request, descriptor, startedAt, completedAt, cancelReason, error, token }) {
  const status = terminalStatus(cancelReason);
  const message = redactMessage(error, token);
  return {
    protocol: EXECUTION_RESULT_PROTOCOL,
    requestId: request.requestId,
    runId: `remote:${request.requestId}`,
    status,
    value: null,
    stdout: "",
    stderr: status === "failed" ? message : "",
    diagnostics: [
      {
        code: status === "failed" ? "remote-host/executor-failed" : `remote-host/${status}`,
        severity: status === "failed" ? "error" : "warning",
        message,
      },
    ],
    runtime: {
      hostId: descriptor.hostId,
      hostGeneration: descriptor.generation,
      backend: descriptor.backend,
      runtimeBuild: descriptor.runtimeBuild,
      haraVersion: descriptor.haraVersion,
    },
    evidence: {
      profile: request.profile,
      sourceDigest: request.sourceDigest,
      startedAt,
      completedAt,
      elapsedMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      cleanup: "uncertain",
    },
  };
}

export function createHaraRelayHostClient(options = {}) {
  const relayOrigin = validateRelayBaseUrl(options.relayUrl);
  const pairingToken = validatePairingToken(options.pairingToken);
  const descriptorTemplate = cloneJson(parseHostDescriptor(options.descriptor));
  if (descriptorTemplate.kind !== "browser-wasm" && descriptorTemplate.kind !== "test-fixture") {
    throw clientError("remote/host-incompatible", "Hara Chrome relay client requires a browser-wasm or explicit test-fixture host");
  }
  if (descriptorTemplate.state !== "ready" && descriptorTemplate.state !== "degraded") {
    throw clientError("remote/host-incompatible", "relay host must start as ready or degraded");
  }

  const executor = options.executor;
  if (!executor || typeof executor !== "object") throw clientError("remote/config-invalid", "executor is required");
  checkedFunction(executor.execute, "executor.execute");

  const fetchImpl = checkedFunction(options.fetchImpl ?? globalThis.fetch, "fetchImpl");
  const now = checkedFunction(options.now ?? (() => new Date()), "now");
  const random = checkedFunction(options.random ?? Math.random, "random");
  const setTimeoutImpl = checkedFunction(options.setTimeoutImpl ?? setTimeout, "setTimeoutImpl");
  const clearTimeoutImpl = checkedFunction(options.clearTimeoutImpl ?? clearTimeout, "clearTimeoutImpl");
  const onStatus = checkedFunction(options.onStatus ?? (() => {}), "onStatus");

  const requestTimeoutMs = checkedInteger(
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    "requestTimeoutMs",
    50,
    60_000,
  );
  const minBackoffMs = checkedInteger(options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS, "minBackoffMs", 1, 10_000);
  const maxBackoffMs = checkedInteger(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, "maxBackoffMs", minBackoffMs, 60_000);
  const maxPollWaitMs = checkedInteger(options.maxPollWaitMs ?? RELAY_MAX_POLL_MS, "maxPollWaitMs", 0, RELAY_MAX_POLL_MS);
  const stopGraceMs = checkedInteger(options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS, "stopGraceMs", 1, 30_000);
  const historyLimit = checkedInteger(options.historyLimit ?? DEFAULT_HISTORY_LIMIT, "historyLimit", 1, 256);

  let desired = false;
  let closed = false;
  let lifecycleController = null;
  let loopPromise = null;
  let ready = deferred();
  let acknowledgedCommandId = null;
  let active = null;
  let pendingTerminal = null;
  let reconnectAttempt = 0;
  const commandFingerprints = new Map();
  const requestFingerprints = new Map();
  const requestCommandIds = new Map();
  const terminals = new Map();

  let status = {
    desiredState: "stopped",
    connectionState: "stopped",
    hostId: descriptorTemplate.hostId,
    generation: descriptorTemplate.generation,
    relayOrigin,
    heartbeatTtlMs: null,
    pollAfterMs: null,
    activeRequestId: null,
    activeCommandId: null,
    pendingTerminal: false,
    reconnectAttempt: 0,
    lastRegisteredAt: null,
    lastPollAt: null,
    lastResultAt: null,
    lastError: null,
  };

  function snapshot() {
    return cloneJson(status);
  }

  function publish(patch) {
    status = { ...status, ...patch };
    try {
      onStatus(snapshot());
    } catch {
      // Observer failure cannot affect transport lifecycle.
    }
    return snapshot();
  }

  function currentDescriptor() {
    return parseHostDescriptor({
      ...cloneJson(descriptorTemplate),
      observedAt: now().toISOString(),
    });
  }

  function endpoint(path) {
    return `${relayOrigin}${path}`;
  }

  async function post(path, payload, signal, parser) {
    const body = JSON.stringify(payload);
    const bodyBytes = new TextEncoder().encode(body).byteLength;
    if (bodyBytes > RELAY_MAX_BODY_BYTES) {
      throw clientError("remote/body-too-large", `relay request exceeds ${RELAY_MAX_BODY_BYTES} bytes`);
    }

    const requestController = new AbortController();
    const onAbort = () => requestController.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeoutImpl(() => requestController.abort("request-timeout"), requestTimeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint(path), {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${pairingToken}`,
          "content-type": "application/json",
        },
        body,
        signal: requestController.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      if (signal?.aborted) throw clientError("remote/stopped", "remote host client stopped");
      if (requestController.signal.aborted) throw clientError("remote/request-timeout", "relay request timed out");
      throw clientError("remote/unavailable", "loopback relay is unavailable", {
        cause: redactMessage(error, pairingToken),
      });
    } finally {
      clearTimeoutImpl(timeout);
      signal?.removeEventListener("abort", onAbort);
    }

    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      throw new RemoteHostProtocolError("remote/response-invalid", "relay response must use application/json");
    }
    const value = await readBoundedJson(response, RELAY_MAX_BODY_BYTES);
    if (!response.ok) {
      let relayError;
      try {
        relayError = parseRelayError(value);
      } catch {
        throw new RelayHttpError(response.status, "remote/http-error", `relay returned HTTP ${response.status}`);
      }
      throw new RelayHttpError(response.status, relayError.error.code, relayError.error.message);
    }
    return parser(value);
  }

  async function register(signal) {
    const descriptor = currentDescriptor();
    const response = await post(
      "/v0/host/register",
      { protocol: LOOPBACK_RELAY_PROTOCOL, descriptor },
      signal,
      parseRegisterResponse,
    );
    if (response.hostId !== descriptor.hostId || response.generation !== descriptor.generation) {
      throw new RemoteHostProtocolError("remote/registration-unbound", "relay registration changed host identity or generation");
    }
    publish({
      connectionState: descriptor.state === "ready" ? "ready" : "degraded",
      heartbeatTtlMs: response.heartbeatTtlMs,
      pollAfterMs: response.pollAfterMs,
      reconnectAttempt: 0,
      lastRegisteredAt: now().toISOString(),
      lastError: null,
    });
    settleResolve(ready, snapshot());
    return { descriptor, response };
  }

  async function poll(registration, signal) {
    const ack = acknowledgedCommandId;
    const value = {
      protocol: LOOPBACK_RELAY_PROTOCOL,
      hostId: registration.descriptor.hostId,
      generation: registration.descriptor.generation,
      waitMs: Math.min(maxPollWaitMs, registration.response.pollAfterMs),
      ...(ack ? { acknowledgedCommandId: ack } : {}),
    };
    const command = await post("/v0/host/poll", value, signal, parseRelayCommand);
    if (ack === acknowledgedCommandId) acknowledgedCommandId = null;
    publish({ lastPollAt: now().toISOString(), lastError: null });
    return command;
  }

  function rememberCommand(command) {
    const fingerprint = canonicalJson(command);
    const existing = commandFingerprints.get(command.commandId);
    if (existing !== undefined && existing !== fingerprint) {
      throw new RemoteHostProtocolError(
        "remote/command-collision",
        `relay changed command ${command.commandId} after first delivery`,
      );
    }
    if (existing === undefined) boundedMapSet(commandFingerprints, command.commandId, fingerprint, historyLimit);
    return existing !== undefined;
  }

  function rememberRequest(request, commandId) {
    const fingerprint = canonicalJson(request);
    const existingCommandId = requestCommandIds.get(request.requestId);
    if (existingCommandId !== undefined && existingCommandId !== commandId) {
      throw new RemoteHostProtocolError(
        "remote/request-command-collision",
        `relay changed the execute command ID for request ${request.requestId}`,
      );
    }
    if (existingCommandId === undefined) {
      boundedMapSet(requestCommandIds, request.requestId, commandId, historyLimit);
    }
    const existing = requestFingerprints.get(request.requestId);
    if (existing !== undefined && existing !== fingerprint) {
      throw new RemoteHostProtocolError(
        "remote/request-collision",
        `relay changed request ${request.requestId} after first delivery`,
      );
    }
    if (existing === undefined) boundedMapSet(requestFingerprints, request.requestId, fingerprint, historyLimit);
    return { duplicate: existing !== undefined, fingerprint };
  }

  function settleExecution(entry, result) {
    if (active !== entry) return;
    const parsed = assertResultBound(parseExecutionResult(result), entry.request, entry.descriptor);
    if (
      (entry.cancelReason === "client-cancelled" || entry.cancelReason === "relay-closing") &&
      parsed.status !== "cancelled"
    ) {
      throw new RemoteHostProtocolError(
        "remote/cancellation-result-invalid",
        `cancelled request ${parsed.requestId} cannot settle as ${parsed.status}`,
      );
    }
    if (entry.cancelReason === "deadline-exceeded" && parsed.status !== "timed-out") {
      throw new RemoteHostProtocolError(
        "remote/cancellation-result-invalid",
        `timed-out request ${parsed.requestId} cannot settle as ${parsed.status}`,
      );
    }
    const fingerprint = canonicalJson(parsed);
    const previous = terminals.get(parsed.requestId);
    if (previous && previous.fingerprint !== fingerprint) {
      throw new RemoteHostProtocolError(
        "remote/terminal-collision",
        `executor changed terminal result ${parsed.requestId}`,
      );
    }
    const terminal = { result: cloneJson(parsed), fingerprint, requestFingerprint: entry.requestFingerprint };
    boundedMapSet(terminals, parsed.requestId, terminal, historyLimit);
    pendingTerminal = terminal;
    entry.state = "terminal";
    publish({ pendingTerminal: true });
  }

  async function executeCommand(command, registration) {
    const duplicateCommand = rememberCommand(command);
    const { duplicate: duplicateRequest, fingerprint: requestFingerprint } = rememberRequest(
      command.request,
      command.commandId,
    );
    const retained = terminals.get(command.request.requestId);

    if (duplicateCommand || duplicateRequest) {
      if (active?.request.requestId === command.request.requestId) {
        acknowledgedCommandId = command.commandId;
        return;
      }
      if (retained?.requestFingerprint === requestFingerprint) {
        pendingTerminal = retained;
        acknowledgedCommandId = command.commandId;
        publish({ pendingTerminal: true });
        return;
      }
      throw new RemoteHostProtocolError(
        "remote/duplicate-unresolved",
        `duplicate request ${command.request.requestId} has no active or retained terminal state`,
      );
    }

    if (active !== null) {
      throw new RemoteHostProtocolError(
        "remote/request-busy",
        `request ${active.request.requestId} is already active`,
      );
    }

    const controller = new AbortController();
    const descriptor = registration.descriptor;
    const entry = {
      commandId: command.commandId,
      request: cloneJson(command.request),
      requestFingerprint,
      descriptor: cloneJson(descriptor),
      controller,
      cancelReason: null,
      cancelDelivered: false,
      cancelCommandId: null,
      state: "running",
      startedAt: now().toISOString(),
      task: null,
    };
    active = entry;
    acknowledgedCommandId = command.commandId;
    publish({
      activeRequestId: entry.request.requestId,
      activeCommandId: entry.commandId,
      pendingTerminal: false,
    });

    entry.task = Promise.resolve()
      .then(() => executor.execute(cloneJson(entry.request), {
        signal: controller.signal,
        descriptor: cloneJson(entry.descriptor),
      }))
      .then((result) => settleExecution(entry, result))
      .catch((error) => {
        if (active !== entry) return;
        const completedAt = now().toISOString();
        const result = failureResult({
          request: entry.request,
          descriptor: entry.descriptor,
          startedAt: entry.startedAt,
          completedAt,
          cancelReason: entry.cancelReason,
          error,
          token: pairingToken,
        });
        settleExecution(entry, result);
      })
      .catch((error) => {
        if (active !== entry) return;
        entry.state = "faulted";
        desired = false;
        publish({
          desiredState: "stopped",
          connectionState: "faulted",
          lastError: errorProjection(error, pairingToken),
        });
        lifecycleController?.abort(error);
      });
  }

  async function cancelCommand(command) {
    const duplicate = rememberCommand(command);
    const entry = active;
    if (!entry || entry.request.requestId !== command.requestId) {
      throw new RemoteHostProtocolError(
        "remote/cancel-unbound",
        `cancel command ${command.commandId} does not match the active request`,
      );
    }
    if (pendingTerminal && !["cancelled", "timed-out"].includes(pendingTerminal.result.status)) {
      throw new RemoteHostProtocolError(
        "remote/cancel-after-terminal",
        `cancel command arrived after incompatible terminal status ${pendingTerminal.result.status}`,
      );
    }
    acknowledgedCommandId = command.commandId;
    if (entry.cancelCommandId && entry.cancelCommandId !== command.commandId) {
      throw new RemoteHostProtocolError(
        "remote/cancel-command-collision",
        `relay changed the cancel command ID for request ${command.requestId}`,
      );
    }
    entry.cancelCommandId ??= command.commandId;
    if (duplicate || entry.cancelDelivered) return;

    entry.cancelDelivered = true;
    entry.cancelReason = command.reason;
    entry.state = "cancelling";
    entry.controller.abort(command.reason);
    publish({ activeCommandId: command.commandId });
    if (typeof executor.cancel === "function") {
      Promise.resolve(executor.cancel(command.requestId, command.reason)).catch((error) => {
        publish({ lastError: errorProjection(error, pairingToken) });
      });
    }
  }

  async function handleCommand(command, registration) {
    switch (command.kind) {
      case "idle":
        await wait(command.retryAfterMs, lifecycleController.signal, setTimeoutImpl, clearTimeoutImpl);
        return;
      case "execute":
        await executeCommand(command, registration);
        return;
      case "cancel":
        await cancelCommand(command);
        return;
      default:
        throw new RemoteHostProtocolError("remote/command-unsupported", `unsupported command ${String(command.kind)}`);
    }
  }

  async function submitPending(registration, signal) {
    if (!pendingTerminal) return;
    const terminal = pendingTerminal;
    const response = await post(
      "/v0/host/result",
      {
        protocol: LOOPBACK_RELAY_PROTOCOL,
        hostId: registration.descriptor.hostId,
        generation: registration.descriptor.generation,
        result: cloneJson(terminal.result),
      },
      signal,
      parseAcceptedResponse,
    );
    if (pendingTerminal !== terminal) {
      throw new RemoteHostProtocolError("remote/terminal-collision", "pending terminal result changed during submission");
    }
    pendingTerminal = null;
    acknowledgedCommandId = null;
    active = null;
    publish({
      activeRequestId: null,
      activeCommandId: null,
      pendingTerminal: false,
      lastResultAt: now().toISOString(),
      lastError: null,
    });
    return response;
  }

  function backoffDelay(attempt) {
    const exponential = Math.min(maxBackoffMs, minBackoffMs * 2 ** Math.min(attempt, 16));
    const jitter = 0.75 + Math.max(0, Math.min(1, Number(random()))) * 0.5;
    return Math.max(minBackoffMs, Math.min(maxBackoffMs, Math.round(exponential * jitter)));
  }

  async function run(signal) {
    while (desired && !signal.aborted) {
      try {
        publish({ connectionState: "connecting", lastError: null });
        const registration = await register(signal);
        reconnectAttempt = 0;

        while (desired && !signal.aborted) {
          if (pendingTerminal) await submitPending(registration, signal);
          const command = await poll(registration, signal);
          await handleCommand(command, registration);
        }
      } catch (error) {
        if (!desired || signal.aborted || isAbort(error)) break;
        if (!retryable(error)) {
          desired = false;
          publish({
            desiredState: "stopped",
            connectionState: "faulted",
            lastError: errorProjection(error, pairingToken),
          });
          settleReject(ready, error);
          break;
        }
        reconnectAttempt += 1;
        publish({
          connectionState: "offline",
          reconnectAttempt,
          lastError: errorProjection(error, pairingToken),
        });
        await wait(backoffDelay(reconnectAttempt - 1), signal, setTimeoutImpl, clearTimeoutImpl);
      }
    }
  }

  function start() {
    if (closed) return Promise.reject(clientError("remote/closed", "remote host client has been closed"));
    if (desired) return ready.promise;
    if (loopPromise) {
      return Promise.reject(
        clientError("remote/restart-requires-stop", "call stop after a fault before restarting the remote host client"),
      );
    }
    desired = true;
    ready = deferred();
    lifecycleController = new AbortController();
    publish({
      desiredState: "running",
      connectionState: "connecting",
      reconnectAttempt: 0,
      lastError: null,
    });
    loopPromise = run(lifecycleController.signal)
      .catch((error) => {
        if (!desired || isAbort(error)) return;
        desired = false;
        publish({
          desiredState: "stopped",
          connectionState: "faulted",
          lastError: errorProjection(error, pairingToken),
        });
        settleReject(ready, error);
      })
      .finally(() => {
        if (status.connectionState !== "faulted" && !desired) {
          publish({ connectionState: "stopped" });
        }
      });
    return ready.promise;
  }

  async function stop(reason = "relay-closing") {
    if (!desired && !loopPromise) return snapshot();
    desired = false;
    publish({ desiredState: "stopped", connectionState: "stopping" });
    settleReject(ready, clientError("remote/stopped", "remote host client stopped before registration"));

    const entry = active;
    if (entry && !entry.cancelDelivered) {
      entry.cancelDelivered = true;
      entry.cancelReason = reason;
      entry.controller.abort(reason);
      if (typeof executor.cancel === "function") {
        Promise.resolve(executor.cancel(entry.request.requestId, reason)).catch(() => {});
      }
    }
    lifecycleController?.abort(reason);
    await Promise.resolve(loopPromise).catch(() => {});

    if (entry?.task) {
      await Promise.race([
        Promise.resolve(entry.task).catch(() => {}),
        wait(stopGraceMs, null, setTimeoutImpl, clearTimeoutImpl),
      ]);
    }
    acknowledgedCommandId = null;
    active = null;
    pendingTerminal = null;
    commandFingerprints.clear();
    requestFingerprints.clear();
    requestCommandIds.clear();
    terminals.clear();
    lifecycleController = null;
    loopPromise = null;
    reconnectAttempt = 0;
    return publish({
      connectionState: "stopped",
      heartbeatTtlMs: null,
      pollAfterMs: null,
      activeRequestId: null,
      activeCommandId: null,
      pendingTerminal: false,
      reconnectAttempt: 0,
    });
  }

  async function close() {
    if (closed) return snapshot();
    await stop();
    closed = true;
    if (typeof executor.close === "function") await Promise.resolve(executor.close()).catch(() => {});
    return publish({ desiredState: "closed", connectionState: "closed" });
  }

  return Object.freeze({
    start,
    stop,
    close,
    status: snapshot,
  });
}
