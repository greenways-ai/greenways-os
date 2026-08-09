import {
  GREENWAYS_OS_SOURCE,
  PLAYGROUND_AI_MESSAGE_TYPE,
  PLAYGROUND_AI_ORIGIN,
  PLAYGROUND_AI_PROTOCOL,
  PLAYGROUND_PAGE_SOURCE,
  PLAYGROUND_REQUEST_DIRECTION,
  PLAYGROUND_RESPONSE_DIRECTION,
} from "./playground-ai-protocol.js";

function pageResponse(response, fallback) {
  const value = response && typeof response === "object"
    ? response
    : { ok: false, code: "BRIDGE_FAILURE", error: "Greenways OS returned no response" };
  return {
    ...value,
    source: GREENWAYS_OS_SOURCE,
    direction: PLAYGROUND_RESPONSE_DIRECTION,
    protocol: PLAYGROUND_AI_PROTOCOL,
    requestId: value.requestId ?? fallback.requestId ?? null,
    operation: value.operation ?? fallback.operation ?? null,
  };
}

function sendToBackground(request) {
  const runtimeMessage = {
    type: PLAYGROUND_AI_MESSAGE_TYPE,
    protocol: PLAYGROUND_AI_PROTOCOL,
    requestId: request.requestId,
    operation: request.operation,
    payload: request.payload ?? {},
  };
  globalThis.chrome.runtime.sendMessage(runtimeMessage, (response) => {
    const lastError = globalThis.chrome.runtime.lastError;
    const value = lastError
      ? {
          ok: false,
          protocol: PLAYGROUND_AI_PROTOCOL,
          requestId: request.requestId,
          operation: request.operation,
          code: "BRIDGE_UNAVAILABLE",
          error: lastError.message || "Greenways OS is unavailable",
        }
      : response;
    globalThis.postMessage(pageResponse(value, request), PLAYGROUND_AI_ORIGIN);
  });
}

if (globalThis.location?.origin === PLAYGROUND_AI_ORIGIN) {
  globalThis.addEventListener("message", (event) => {
    if (event.source !== globalThis || event.origin !== PLAYGROUND_AI_ORIGIN) return;
    const request = event.data;
    if (!request
        || typeof request !== "object"
        || Array.isArray(request)
        || request.source !== PLAYGROUND_PAGE_SOURCE
        || request.direction !== PLAYGROUND_REQUEST_DIRECTION
        || request.protocol !== PLAYGROUND_AI_PROTOCOL) {
      return;
    }
    sendToBackground(request);
  });
}
