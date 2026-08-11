import { GreenwaysKeyring } from "./keyring.js";
import { MODEL_PROVIDER_POLICY } from "./model-provider-policy.js";
import { CHATGPT_PROVIDER_ID } from "./chatgpt-provider-protocol.js";

export const AI_SERVICE_PROTOCOL = "greenways-ai/1";
export const MODEL_GENERATE_CAPABILITY = "model/generate";

const REQUEST_ID = /^[a-z0-9][a-z0-9._:/-]{15,127}$/i;
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;
const MESSAGE_ROLES = new Set(["system", "user", "assistant"]);
const REQUEST_KEYS = new Set([
  "requestId",
  "profileId",
  "model",
  "messages",
  "maxOutputTokens",
  "timeoutMs",
]);
const MAX_MESSAGES = 64;
const MAX_MESSAGE_CHARS = 64 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 256 * 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const MAX_OUTPUT_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_FOREGROUND_TIMEOUT_MS = 15 * 60_000;

function errorWithCode(message, code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw errorWithCode(`${label} must be an object`, "INVALID_REQUEST");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw errorWithCode(`${label} must be a plain object`, "INVALID_REQUEST");
  }
  return value;
}

function closedKeys(value, allowed, label) {
  for (const key of Object.keys(plainObject(value, label))) {
    if (!allowed.has(key)) {
      throw errorWithCode(`${label} contains an unsupported field: ${key}`, "INVALID_REQUEST");
    }
  }
}

function requiredString(value, label, maximum) {
  if (typeof value !== "string") {
    throw errorWithCode(`${label} must be a string`, "INVALID_REQUEST");
  }
  const output = value.trim();
  if (!output) throw errorWithCode(`${label} cannot be empty`, "INVALID_REQUEST");
  if (output.length > maximum) {
    throw errorWithCode(`${label} cannot exceed ${maximum} characters`, "INVALID_REQUEST");
  }
  return output;
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const output = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(output) || output < minimum || output > maximum) {
    throw errorWithCode(`${label} must be an integer from ${minimum} to ${maximum}`, "INVALID_REQUEST");
  }
  return output;
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function normalizeMessage(value, index) {
  const input = plainObject(value, `Model message ${index}`);
  closedKeys(input, new Set(["role", "content"]), `Model message ${index}`);
  const role = requiredString(input.role, `Model message ${index} role`, 20).toLowerCase();
  if (!MESSAGE_ROLES.has(role)) {
    throw errorWithCode(`Model message ${index} role is not supported`, "INVALID_REQUEST");
  }
  const content = requiredString(input.content, `Model message ${index} content`, MAX_MESSAGE_CHARS);
  return Object.freeze({ role, content });
}

export function normalizeModelRequest(value) {
  const input = plainObject(value, "Model request");
  closedKeys(input, REQUEST_KEYS, "Model request");
  const requestId = requiredString(input.requestId, "Model request id", 128);
  if (!REQUEST_ID.test(requestId)) throw errorWithCode("Model request id is invalid", "INVALID_REQUEST");
  const profileId = requiredString(input.profileId, "Provider profile id", 64).toLowerCase();
  if (!PROFILE_ID.test(profileId)) throw errorWithCode("Provider profile id is invalid", "INVALID_REQUEST");
  const model = requiredString(input.model, "Model id", 160);
  if (!MODEL_ID.test(model) || model.includes("://")) {
    throw errorWithCode("Model id is invalid", "INVALID_REQUEST");
  }
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > MAX_MESSAGES) {
    throw errorWithCode(`Model request messages must contain 1 to ${MAX_MESSAGES} entries`, "INVALID_REQUEST");
  }
  const messages = Object.freeze(input.messages.map(normalizeMessage));
  const maxOutputTokens = boundedInteger(
    input.maxOutputTokens,
    DEFAULT_MAX_OUTPUT_TOKENS,
    1,
    MAX_OUTPUT_TOKENS,
    "Model request maxOutputTokens",
  );
  const timeoutMs = boundedInteger(
    input.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    1_000,
    profileId === CHATGPT_PROVIDER_ID ? MAX_FOREGROUND_TIMEOUT_MS : MAX_TIMEOUT_MS,
    "Model request timeoutMs",
  );
  const output = Object.freeze({ requestId, profileId, model, messages, maxOutputTokens, timeoutMs });
  if (byteLength(output) > MAX_INPUT_BYTES) {
    throw errorWithCode("Model request exceeds the Greenways AI input limit", "REQUEST_TOO_LARGE");
  }
  return output;
}

function normalizeStringList(value, label, maximum = 64) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > maximum) {
    throw errorWithCode(`${label} must be a bounded array`, "CAPABILITY_CONSTRAINT_INVALID");
  }
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`, 240));
}

function assertGrantConstraints(request, profile, context) {
  const constraints = context?.grant?.constraints ?? {};
  plainObject(constraints, "Model capability constraints");
  const origins = normalizeStringList(constraints.origins, "Model capability origins");
  if (origins && !origins.includes(context.origin)) {
    throw errorWithCode("The model capability does not allow this origin", "CAPABILITY_DENIED");
  }
  const profileIds = normalizeStringList(constraints.profileIds, "Model capability profileIds");
  if (profileIds && !profileIds.includes(request.profileId)) {
    throw errorWithCode("The selected provider profile is outside the capability grant", "CAPABILITY_DENIED");
  }
  const providers = normalizeStringList(constraints.providers, "Model capability providers");
  if (providers && !providers.includes(profile.provider)) {
    throw errorWithCode("The selected provider is outside the capability grant", "CAPABILITY_DENIED");
  }
  const models = normalizeStringList(constraints.models, "Model capability models");
  if (models && !models.includes(request.model)) {
    throw errorWithCode("The selected model is outside the capability grant", "CAPABILITY_DENIED");
  }
  if (constraints.maxOutputTokens !== undefined
      && (!Number.isSafeInteger(constraints.maxOutputTokens)
        || constraints.maxOutputTokens < 1
        || request.maxOutputTokens > constraints.maxOutputTokens)) {
    throw errorWithCode("The requested output limit exceeds the capability grant", "CAPABILITY_DENIED");
  }
  if (constraints.timeoutMs !== undefined
      && (!Number.isSafeInteger(constraints.timeoutMs)
        || constraints.timeoutMs < 1_000
        || request.timeoutMs > constraints.timeoutMs)) {
    throw errorWithCode("The requested timeout exceeds the capability grant", "CAPABILITY_DENIED");
  }
  if (constraints.maxInputBytes !== undefined
      && (!Number.isSafeInteger(constraints.maxInputBytes)
        || constraints.maxInputBytes < 1
        || byteLength(request) > constraints.maxInputBytes)) {
    throw errorWithCode("The model context exceeds the capability grant", "CAPABILITY_DENIED");
  }
}

function providerConfig(provider) {
  const config = MODEL_PROVIDER_POLICY[provider];
  if (!config) throw errorWithCode(`Unsupported model provider: ${provider}`, "PROVIDER_UNSUPPORTED");
  return config;
}

function requestForOpenRouter(request, secret, origin) {
  return {
    url: MODEL_PROVIDER_POLICY.openrouter.endpoint,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        "HTTP-Referer": `${origin}/`,
        "X-OpenRouter-Title": "Hara Playground",
      },
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        max_tokens: request.maxOutputTokens,
        stream: false,
      }),
    },
  };
}

function requestForOpenAi(request, secret) {
  return {
    url: MODEL_PROVIDER_POLICY.openai.endpoint,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        input: request.messages,
        max_output_tokens: request.maxOutputTokens,
      }),
    },
  };
}

function requestForAnthropic(request, secret) {
  const system = request.messages
    .filter(({ role }) => role === "system")
    .map(({ content }) => content)
    .join("\n\n");
  const messages = request.messages.filter(({ role }) => role !== "system");
  if (!messages.length) {
    throw errorWithCode("Anthropic requests require at least one user or assistant message", "INVALID_REQUEST");
  }
  return {
    url: MODEL_PROVIDER_POLICY.anthropic.endpoint,
    init: {
      method: "POST",
      headers: {
        "x-api-key": secret,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxOutputTokens,
        messages,
        ...(system ? { system } : {}),
      }),
    },
  };
}

function providerRequest(provider, request, secret, origin) {
  if (provider === "openrouter") return requestForOpenRouter(request, secret, origin);
  if (provider === "openai") return requestForOpenAi(request, secret);
  if (provider === "anthropic") return requestForAnthropic(request, secret);
  throw errorWithCode(`Unsupported model provider: ${provider}`, "PROVIDER_UNSUPPORTED");
}

function sanitizeProviderMessage(value, secret) {
  const text = typeof value === "string" ? value : "Provider request failed";
  return text.replaceAll(secret, "[redacted]").slice(0, 800);
}

async function readProviderJson(response, secret) {
  const declaredLength = Number(response.headers?.get?.("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw errorWithCode("Provider response exceeds the Greenways AI limit", "PROVIDER_RESPONSE_TOO_LARGE");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
    throw errorWithCode("Provider response exceeds the Greenways AI limit", "PROVIDER_RESPONSE_TOO_LARGE");
  }
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw errorWithCode("Provider returned an invalid JSON response", "PROVIDER_RESPONSE_INVALID");
  }
  if (!response.ok) {
    const message = data?.error?.message ?? data?.message ?? `Provider returned HTTP ${response.status}`;
    throw errorWithCode(sanitizeProviderMessage(message, secret), "PROVIDER_REQUEST_FAILED");
  }
  return data;
}

function openAiOutput(data) {
  if (typeof data?.output_text === "string" && data.output_text) return data.output_text;
  return (Array.isArray(data?.output) ? data.output : [])
    .filter((item) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part?.type === "output_text" && typeof part.text === "string")
    .map(({ text }) => text)
    .join("");
}

function anthropicOutput(data) {
  return (Array.isArray(data?.content) ? data.content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map(({ text }) => text)
    .join("");
}

function openRouterOutput(data) {
  return typeof data?.choices?.[0]?.message?.content === "string"
    ? data.choices[0].message.content
    : "";
}

function providerOutput(provider, data) {
  const output = provider === "openai"
    ? openAiOutput(data)
    : provider === "anthropic"
      ? anthropicOutput(data)
      : openRouterOutput(data);
  if (!output) throw errorWithCode("Provider response did not contain text output", "PROVIDER_RESPONSE_INVALID");
  if (output.length > MAX_OUTPUT_CHARS) {
    throw errorWithCode("Provider text output exceeds the Greenways AI limit", "PROVIDER_RESPONSE_TOO_LARGE");
  }
  return output;
}

function providerUsage(provider, data) {
  if (!data?.usage || typeof data.usage !== "object") return null;
  if (provider === "openai") {
    return Object.freeze({
      inputTokens: data.usage.input_tokens ?? null,
      outputTokens: data.usage.output_tokens ?? null,
      totalTokens: data.usage.total_tokens ?? null,
    });
  }
  if (provider === "anthropic") {
    const inputTokens = data.usage.input_tokens ?? null;
    const outputTokens = data.usage.output_tokens ?? null;
    return Object.freeze({
      inputTokens,
      outputTokens,
      totalTokens: Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
        ? inputTokens + outputTokens
        : null,
    });
  }
  return Object.freeze({
    inputTokens: data.usage.prompt_tokens ?? null,
    outputTokens: data.usage.completion_tokens ?? null,
    totalTokens: data.usage.total_tokens ?? null,
    cost: typeof data.usage.cost === "number" ? data.usage.cost : null,
  });
}

export class GreenwaysAiService {
  constructor({
    keyring = new GreenwaysKeyring(),
    webProvider = null,
    fetchImpl = globalThis.fetch,
    permissions = globalThis.chrome?.permissions,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    now = () => new Date().toISOString(),
  } = {}) {
    if (!keyring || typeof keyring.status !== "function" || typeof keyring.readProfiles !== "function") {
      throw new TypeError("Greenways AI requires the trusted Keyring provider-profile reader");
    }
    if (webProvider !== null
        && (typeof webProvider?.handles !== "function"
          || typeof webProvider?.status !== "function"
          || typeof webProvider?.create !== "function"
          || typeof webProvider?.result !== "function"
          || typeof webProvider?.cancel !== "function")) {
      throw new TypeError("Greenways AI foreground provider boundary is invalid");
    }
    if (typeof fetchImpl !== "function") throw new TypeError("Greenways AI requires fetch");
    if (typeof setTimeoutImpl !== "function" || typeof clearTimeoutImpl !== "function") {
      throw new TypeError("Greenways AI requires timeout functions");
    }
    if (typeof now !== "function") throw new TypeError("Greenways AI requires a clock");
    this.keyring = keyring;
    this.webProvider = webProvider;
    this.fetchImpl = fetchImpl;
    this.permissions = permissions;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.now = now;
    this.inflight = new Map();
  }

  async hasProviderAccess(provider) {
    const config = providerConfig(provider);
    if (!this.permissions || typeof this.permissions.contains !== "function") return false;
    return this.permissions.contains({ origins: [config.permissionOrigin] });
  }

  async status() {
    const keyring = await this.keyring.status();
    const providerAccess = {};
    for (const provider of Object.keys(MODEL_PROVIDER_POLICY)) {
      providerAccess[provider] = await this.hasProviderAccess(provider).catch(() => false);
    }
    const profiles = [...(keyring.providerProfiles ?? [])];
    if (this.webProvider) {
      const web = await this.webProvider.status();
      if (web?.profile) {
        const index = profiles.findIndex(({ id }) => id === web.profile.id);
        if (index >= 0) profiles.splice(index, 1);
        profiles.push(web.profile);
        providerAccess[web.profile.provider] = Boolean(web.profile.available);
      }
    }
    return Object.freeze({
      protocol: AI_SERVICE_PROTOCOL,
      providerProfiles: Object.freeze(profiles),
      providerCredentialStorage: keyring.providerCredentialStorage,
      providerAccess: Object.freeze(providerAccess),
    });
  }

  async cancel(requestId, context = {}) {
    const requested = requiredString(requestId, "Cancelled model request id", 128);
    const operation = this.inflight.get(requested);
    if (operation) {
      operation.cancelled = true;
      operation.controller.abort();
      return Object.freeze({ requestId: requested, cancelled: true });
    }
    if (this.webProvider) return this.webProvider.cancel(requested, context);
    return Object.freeze({ requestId: requested, cancelled: false });
  }

  async result(requestId, context = {}) {
    const requested = requiredString(requestId, "Model result request id", 128);
    if (!this.webProvider) {
      throw errorWithCode("Foreground model provider is unavailable", "PROVIDER_UNAVAILABLE");
    }
    return this.webProvider.result(requested, context);
  }

  async generate(value, context = {}) {
    const request = normalizeModelRequest(value);
    if (context.origin !== "https://playground.hara-lang.org"
        || context.appId !== "hara-playground") {
      throw errorWithCode("Greenways AI rejected an untrusted caller", "CALLER_DENIED");
    }
    if (context.grant?.capability !== MODEL_GENERATE_CAPABILITY
        || context.grant?.subject?.appId !== context.appId) {
      throw errorWithCode("Greenways AI requires a bound model/generate grant", "CAPABILITY_DENIED");
    }
    if (this.webProvider?.handles(request.profileId)) {
      const web = await this.webProvider.status();
      if (!web?.profile?.available) {
        throw errorWithCode("Greenways for ChatGPT is not available", "PROVIDER_UNAVAILABLE");
      }
      assertGrantConstraints(request, web.profile, context);
      return this.webProvider.create(request, context);
    }
    if (this.inflight.has(request.requestId)) {
      throw errorWithCode("Model request id is already in flight", "REQUEST_ID_REUSE");
    }

    const profiles = await this.keyring.readProfiles();
    const profile = profiles.find(({ id }) => id === request.profileId);
    if (!profile) throw errorWithCode("Provider profile does not exist", "PROVIDER_PROFILE_MISSING");
    providerConfig(profile.provider);
    assertGrantConstraints(request, profile, context);
    if (!await this.hasProviderAccess(profile.provider)) {
      throw errorWithCode(
        `Network access for ${profile.provider} has not been approved in Greenways OS`,
        "PROVIDER_PERMISSION_REQUIRED",
      );
    }

    const controller = new AbortController();
    const operation = { controller, cancelled: false, timedOut: false };
    this.inflight.set(request.requestId, operation);
    const timer = this.setTimeoutImpl(() => {
      operation.timedOut = true;
      controller.abort();
    }, request.timeoutMs);

    try {
      const provider = providerRequest(profile.provider, request, profile.secret, context.origin);
      const response = await this.fetchImpl(provider.url, {
        ...provider.init,
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
      });
      const data = await readProviderJson(response, profile.secret);
      return Object.freeze({
        protocol: AI_SERVICE_PROTOCOL,
        requestId: request.requestId,
        provider: profile.provider,
        profileId: profile.id,
        model: typeof data?.model === "string" ? data.model : request.model,
        providerResponseId: typeof data?.id === "string" ? data.id : null,
        output: providerOutput(profile.provider, data),
        usage: providerUsage(profile.provider, data),
        completedAt: this.now(),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (operation.timedOut) {
          throw errorWithCode("Model provider request timed out", "PROVIDER_TIMEOUT", { cause: error });
        }
        throw errorWithCode("Model provider request was cancelled", "REQUEST_CANCELLED", { cause: error });
      }
      throw error;
    } finally {
      this.clearTimeoutImpl(timer);
      this.inflight.delete(request.requestId);
    }
  }
}
