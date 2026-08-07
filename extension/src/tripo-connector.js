import {
  MODEL_GENERATION_PROVIDER,
  createPendingModelGenerationTask,
  createTripoTaskPayload,
  modelGenerationTaskReference,
  normalizeModelGenerationRequest,
  normalizeModelGenerationTask,
} from "./model-generation.js";

export const TRIPO_API_ORIGIN = "https://api.tripo3d.ai";
export const TRIPO_ORIGINS = Object.freeze([`${TRIPO_API_ORIGIN}/*`]);
const TASK_ENDPOINT = `${TRIPO_API_ORIGIN}/v2/openapi/task`;
const FINAL_STATUSES = new Set(["success", "failed", "banned", "expired", "cancelled", "unknown"]);

function timeoutSignal(milliseconds) {
  return globalThis.AbortSignal?.timeout ? AbortSignal.timeout(milliseconds) : undefined;
}

function privateRequestOptions(options = {}, timeoutMs = 30_000) {
  const request = {
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    ...options,
  };
  if (!request.signal) request.signal = timeoutSignal(timeoutMs);
  return request;
}

function tripoSecret(value) {
  if (typeof value !== "string" || !value.startsWith("tsk_") || value.length < 12) {
    throw new Error("Tripo requires an API key beginning with tsk_");
  }
  if (/\s/.test(value)) throw new Error("Tripo API key cannot contain whitespace");
  return value;
}

async function responseBody(response) {
  try {
    return await response.json();
  } catch {
    throw new TripoConnectorError(
      `Tripo returned an unreadable response (${response.status})`,
      { httpStatus: response.status },
    );
  }
}

export class TripoConnectorError extends Error {
  constructor(message, {
    code = null,
    suggestion = null,
    httpStatus = null,
  } = {}) {
    super(message);
    this.name = "TripoConnectorError";
    this.code = code;
    this.suggestion = suggestion;
    this.httpStatus = httpStatus;
  }
}

async function tripoData(response) {
  const body = await responseBody(response);
  const code = Number.isSafeInteger(body?.code) ? body.code : null;
  if (!response.ok || code !== 0 || !body?.data) {
    const message = typeof body?.message === "string" && body.message.trim()
      ? body.message.trim()
      : `Tripo request failed (${response.status})`;
    throw new TripoConnectorError(message, {
      code,
      suggestion: typeof body?.suggestion === "string" ? body.suggestion.trim() || null : null,
      httpStatus: response.status,
    });
  }
  return body.data;
}

export async function requestTripoAccess(permissions = globalThis.chrome?.permissions) {
  if (!permissions) return true;
  if (typeof permissions.request !== "function") {
    throw new Error("Chrome origin permissions are unavailable");
  }
  const granted = await permissions.request({ origins: [...TRIPO_ORIGINS] });
  if (!granted) throw new Error("Tripo API access was not granted");
  return true;
}

export async function hasTripoAccess(permissions = globalThis.chrome?.permissions) {
  if (!permissions) return true;
  if (typeof permissions.contains !== "function") return false;
  return permissions.contains({ origins: [...TRIPO_ORIGINS] });
}

export class TripoConnector {
  constructor({
    keyring,
    request = globalThis.fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    timeoutMs = 30_000,
    pollIntervalMs = 2_000,
    maxWaitMs = 10 * 60_000,
  } = {}) {
    if (!keyring || typeof keyring.withProviderCredential !== "function") {
      throw new TypeError("Tripo connector requires a Greenways Keyring credential broker");
    }
    if (typeof request !== "function") throw new TypeError("Tripo connector requires fetch");
    if (typeof sleep !== "function") throw new TypeError("Tripo connector sleep must be a function");
    for (const [value, label] of [
      [timeoutMs, "request timeout"],
      [pollIntervalMs, "poll interval"],
      [maxWaitMs, "maximum wait"],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Tripo ${label} must be a positive integer`);
    }
    this.keyring = keyring;
    this.request = request;
    this.sleep = sleep;
    this.timeoutMs = timeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.maxWaitMs = maxWaitMs;
  }

  async withCredential(profileId, operation) {
    return this.keyring.withProviderCredential(profileId, MODEL_GENERATION_PROVIDER, (secret) => (
      operation(tripoSecret(secret))
    ));
  }

  async createTask(requestValue) {
    const request = normalizeModelGenerationRequest(requestValue);
    const payload = createTripoTaskPayload(request);
    return this.withCredential(request.profileId, async (secret) => {
      const response = await this.request(TASK_ENDPOINT, privateRequestOptions({
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }, this.timeoutMs));
      const data = await tripoData(response);
      if (typeof data.task_id !== "string" || !data.task_id) {
        throw new TripoConnectorError("Tripo did not return a task id", { httpStatus: response.status });
      }
      return createPendingModelGenerationTask({
        profileId: request.profileId,
        requestId: request.id,
        providerTaskId: data.task_id,
        operation: request.operation,
      });
    });
  }

  async getTask(taskValue) {
    const reference = modelGenerationTaskReference(taskValue);
    return this.withCredential(reference.profileId, async (secret) => {
      const response = await this.request(
        `${TASK_ENDPOINT}/${encodeURIComponent(reference.providerTaskId)}`,
        privateRequestOptions({
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${secret}`,
          },
        }, this.timeoutMs),
      );
      return normalizeModelGenerationTask(await tripoData(response), reference);
    });
  }

  async waitForTask(taskValue, {
    pollIntervalMs = this.pollIntervalMs,
    maxWaitMs = this.maxWaitMs,
  } = {}) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new TypeError("Tripo poll interval must be a positive integer");
    }
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1) {
      throw new TypeError("Tripo maximum wait must be a positive integer");
    }
    const startedAt = Date.now();
    let task = taskValue;
    while (!FINAL_STATUSES.has(task.status)) {
      if (Date.now() - startedAt >= maxWaitMs) {
        throw new TripoConnectorError("Tripo task polling timed out");
      }
      await this.sleep(pollIntervalMs);
      task = await this.getTask(task);
    }
    return task;
  }
}
