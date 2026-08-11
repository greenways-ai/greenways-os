import {
  AI_SERVICE_PROTOCOL,
  GreenwaysAiService,
} from "./ai-service.js";
import { PlaygroundAiAuthority } from "./playground-ai-authority.js";
import {
  PLAYGROUND_AI_MESSAGE_TYPE,
  PLAYGROUND_AI_ORIGIN,
  PLAYGROUND_AI_PROTOCOL,
  PLAYGROUND_APP_ID,
} from "./playground-ai-protocol.js";

export {
  PLAYGROUND_AI_MESSAGE_TYPE,
  PLAYGROUND_AI_ORIGIN,
  PLAYGROUND_AI_PROTOCOL,
  PLAYGROUND_APP_ID,
} from "./playground-ai-protocol.js";

const REQUEST_ID = /^[a-z0-9][a-z0-9._:/-]{15,127}$/i;
const OPERATIONS = new Set(["status", "open", "generate", "result", "cancel"]);
const MESSAGE_KEYS = new Set(["type", "protocol", "requestId", "operation", "payload"]);
const MAX_MESSAGE_BYTES = 320 * 1024;

let residentAiService;
let residentAuthority;

function defaultAiService() {
  residentAiService ??= new GreenwaysAiService();
  return residentAiService;
}

function defaultAuthority() {
  residentAuthority ??= new PlaygroundAiAuthority();
  return residentAuthority;
}

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

function boundedJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw errorWithCode(`${label} must be JSON serializable`, "INVALID_REQUEST");
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_MESSAGE_BYTES) {
    throw errorWithCode(`${label} exceeds the bridge message limit`, "REQUEST_TOO_LARGE");
  }
  return value;
}

function requestId(value, label = "Playground AI request id") {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw errorWithCode(`${label} is invalid`, "INVALID_REQUEST");
  }
  return value;
}

function normalizeMessage(value) {
  const input = plainObject(value, "Playground AI message");
  closedKeys(input, MESSAGE_KEYS, "Playground AI message");
  if (input.type !== PLAYGROUND_AI_MESSAGE_TYPE || input.protocol !== PLAYGROUND_AI_PROTOCOL) {
    throw errorWithCode("Playground AI message uses an unsupported protocol", "INVALID_REQUEST");
  }
  const operation = String(input.operation ?? "");
  if (!OPERATIONS.has(operation)) {
    throw errorWithCode(`Unsupported Playground AI operation: ${operation}`, "METHOD_DENIED");
  }
  const payload = input.payload === undefined ? {} : plainObject(input.payload, "Playground AI payload");
  boundedJson(payload, "Playground AI payload");
  return Object.freeze({
    requestId: requestId(input.requestId),
    operation,
    payload,
  });
}

export function principalFromPlaygroundSender(sender, runtime = globalThis.chrome?.runtime) {
  if (!runtime?.id || sender?.id !== runtime.id) {
    throw errorWithCode("Playground bridge sender is not this extension", "CALLER_DENIED");
  }
  if (sender?.frameId !== 0) {
    throw errorWithCode("Playground bridge requests must come from the top frame", "CALLER_DENIED");
  }
  if (sender?.tab?.incognito) {
    throw errorWithCode("Playground bridge is unavailable in incognito mode", "CALLER_DENIED");
  }
  if (!Number.isInteger(sender?.tab?.id)) {
    throw errorWithCode("Playground bridge sender has no active browser tab", "CALLER_DENIED");
  }
  let url;
  try {
    url = new URL(sender.url);
  } catch {
    throw errorWithCode("Playground bridge sender URL is invalid", "CALLER_DENIED");
  }
  if (url.origin !== PLAYGROUND_AI_ORIGIN) {
    throw errorWithCode("Playground bridge rejected an untrusted origin", "CALLER_DENIED");
  }
  return Object.freeze({
    appId: PLAYGROUND_APP_ID,
    origin: url.origin,
    tabId: sender.tab.id,
    documentId: typeof sender.documentId === "string" ? sender.documentId : null,
  });
}

function publicCapability(value) {
  return Object.freeze({
    appId: PLAYGROUND_APP_ID,
    capability: "model/generate",
    installed: Boolean(value?.installed),
    eligible: Boolean(value?.eligible),
    granted: Boolean(value?.granted),
    allowed: Boolean(value?.allowed),
    reason: typeof value?.reason === "string" ? value.reason : "unavailable",
    grantId: typeof value?.grant?.id === "string" ? value.grant.id : null,
    constraints: value?.grant?.constraints && typeof value.grant.constraints === "object"
      ? value.grant.constraints
      : null,
  });
}

function errorResponse(error, request) {
  return {
    ok: false,
    protocol: PLAYGROUND_AI_PROTOCOL,
    requestId: request?.requestId ?? null,
    operation: request?.operation ?? null,
    code: error?.code || "GREENWAYS_AI_FAILURE",
    error: error?.message || String(error),
  };
}

function ensureEmptyPayload(payload, operation) {
  if (Object.keys(payload).length) {
    throw errorWithCode(`${operation} does not accept payload fields`, "INVALID_REQUEST");
  }
}

function cancelTarget(payload) {
  closedKeys(payload, new Set(["requestId"]), "Playground AI cancel payload");
  return requestId(payload.requestId, "Cancelled model request id");
}

export function createPlaygroundAiMessageHandler({
  runtime = globalThis.chrome?.runtime,
  tabs = globalThis.chrome?.tabs,
  getAuthority = defaultAuthority,
  getAiService = defaultAiService,
} = {}) {
  if (!runtime?.id || typeof runtime.getURL !== "function") {
    throw new TypeError("Playground AI bridge requires the extension runtime");
  }
  if (!tabs || typeof tabs.create !== "function") {
    throw new TypeError("Playground AI bridge requires browser tab access");
  }
  if (typeof getAuthority !== "function") {
    throw new TypeError("Playground AI bridge requires a capability authority");
  }
  if (typeof getAiService !== "function") {
    throw new TypeError("Playground AI bridge requires an AI service factory");
  }

  return (message, sender, sendResponse) => {
    if (message?.type !== PLAYGROUND_AI_MESSAGE_TYPE) return false;
    let normalized;
    try {
      normalized = normalizeMessage(message);
    } catch (error) {
      sendResponse(errorResponse(error, message));
      return false;
    }

    Promise.resolve().then(async () => {
      const principal = principalFromPlaygroundSender(sender, runtime);
      if (normalized.operation === "open") {
        ensureEmptyPayload(normalized.payload, "open");
        const tab = await tabs.create({
          url: runtime.getURL("src/launcher.html#manage-hara-playground"),
          active: true,
        });
        return {
          ok: true,
          protocol: PLAYGROUND_AI_PROTOCOL,
          requestId: normalized.requestId,
          operation: normalized.operation,
          opened: "greenways-os",
          tabId: Number.isInteger(tab?.id) ? tab.id : null,
        };
      }

      const [authority, aiService] = await Promise.all([getAuthority(), getAiService()]);
      if (!authority || typeof authority.status !== "function" || typeof authority.assert !== "function") {
        throw errorWithCode("Playground capability authority is unavailable", "CAPABILITY_UNAVAILABLE");
      }
      if (!aiService
          || typeof aiService.status !== "function"
          || typeof aiService.generate !== "function"
          || typeof aiService.result !== "function"
          || typeof aiService.cancel !== "function") {
        throw errorWithCode("Resident AI service is unavailable", "AI_SERVICE_UNAVAILABLE");
      }

      if (normalized.operation === "status") {
        ensureEmptyPayload(normalized.payload, "status");
        const [capability, ai] = await Promise.all([
          authority.status(),
          aiService.status(),
        ]);
        return {
          ok: true,
          protocol: PLAYGROUND_AI_PROTOCOL,
          requestId: normalized.requestId,
          operation: normalized.operation,
          origin: principal.origin,
          capability: publicCapability(capability),
          ai,
        };
      }

      if (normalized.operation === "cancel" || normalized.operation === "result") {
        const capability = await authority.assert();
        const context = {
          origin: principal.origin,
          appId: principal.appId,
          grant: capability.grant,
        };
        const target = cancelTarget(normalized.payload);
        return {
          ok: true,
          protocol: PLAYGROUND_AI_PROTOCOL,
          requestId: normalized.requestId,
          operation: normalized.operation,
          result: normalized.operation === "cancel"
            ? await aiService.cancel(target, context)
            : await aiService.result(target, context),
        };
      }

      const capability = await authority.assert();
      const result = await aiService.generate({
        ...normalized.payload,
        requestId: normalized.requestId,
      }, {
        origin: principal.origin,
        appId: principal.appId,
        grant: capability.grant,
      });
      if (result?.protocol !== AI_SERVICE_PROTOCOL) {
        throw errorWithCode("AI service returned an unsupported response", "AI_SERVICE_CONTRACT");
      }
      return {
        ok: true,
        protocol: PLAYGROUND_AI_PROTOCOL,
        requestId: normalized.requestId,
        operation: normalized.operation,
        result,
      };
    }).then(sendResponse, (error) => sendResponse(errorResponse(error, normalized)));
    return true;
  };
}
