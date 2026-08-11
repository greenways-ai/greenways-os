import {
  CHATGPT_PROVIDER_ID,
} from "./chatgpt-provider-protocol.js";

export const CHATGPT_AI_PROFILE = Object.freeze({
  protocol: "greenways-provider-profile/1",
  id: CHATGPT_PROVIDER_ID,
  provider: CHATGPT_PROVIDER_ID,
  label: "ChatGPT Web — foreground",
  interaction: "foreground",
  credentialRequired: false,
  sessionOnly: false,
});

const TERMINAL_STATES = new Set(["returned", "cancelled", "expired"]);
const REQUEST_ID = /^[a-z0-9][a-z0-9._:/-]{15,127}$/i;

function errorWithCode(message, code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function requestId(value) {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) {
    throw errorWithCode("Foreground model request id is invalid", "INVALID_REQUEST");
  }
  return value;
}

function callerIdentity(context) {
  const grantId = context?.grant?.id;
  if (typeof context?.appId !== "string"
      || typeof context?.origin !== "string"
      || typeof grantId !== "string") {
    throw errorWithCode("Foreground model requests require an exact caller grant", "CAPABILITY_DENIED");
  }
  return Object.freeze({
    appId: context.appId,
    origin: context.origin,
    grantId,
  });
}

function assertCaller(session, context) {
  const caller = callerIdentity(context);
  const request = session?.request ?? {};
  if (request.callerAppId !== caller.appId
      || request.callerOrigin !== caller.origin
      || request.callerGrantId !== caller.grantId) {
    throw errorWithCode("Foreground model session belongs to another caller approval", "CALLER_DENIED");
  }
  return caller;
}

export function formatChatgptPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw errorWithCode("Foreground model request requires messages", "INVALID_REQUEST");
  }
  return messages
    .map(({ role, content }) => `${String(role).toUpperCase()}:\n${content}`)
    .join("\n\n");
}

function aiResult(session) {
  const request = session.request ?? {};
  return Object.freeze({
    protocol: "greenways-ai/1",
    requestId: request.requestId,
    provider: CHATGPT_PROVIDER_ID,
    profileId: CHATGPT_PROVIDER_ID,
    model: request.model ?? "chatgpt-web",
    providerResponseId: session.assistantMessageId ?? null,
    sessionId: session.id,
    state: session.state,
    pending: !TERMINAL_STATES.has(session.state),
    output: session.output ?? null,
    outputDigest: session.outputDigest ?? null,
    source: Object.freeze({
      origin: session.origin ?? null,
      conversationId: session.conversationId ?? null,
      assistantMessageId: session.assistantMessageId ?? null,
    }),
    usage: null,
    completedAt: session.returnedAt ?? null,
  });
}

export function createChatgptAiProvider({
  getKernelHost,
  now = () => new Date(),
} = {}) {
  if (typeof getKernelHost !== "function") {
    throw new TypeError("ChatGPT AI provider requires the resident kernel host");
  }
  if (typeof now !== "function") throw new TypeError("ChatGPT AI provider requires a clock");

  async function providerCall(method, args = []) {
    const host = await getKernelHost();
    if (!host || typeof host.callChatgptProvider !== "function") {
      throw errorWithCode("Resident ChatGPT provider is unavailable", "PROVIDER_UNAVAILABLE");
    }
    return host.callChatgptProvider(method, args);
  }

  async function status() {
    try {
      const value = await providerCall("chatgpt-provider/status");
      return Object.freeze({
        profile: Object.freeze({
          ...CHATGPT_AI_PROFILE,
          available: Boolean(value?.enabled && value?.originAccess),
          reason: value?.enabled
            ? value?.originAccess ? "available" : "origin-permission-required"
            : "provider-disabled",
        }),
        provider: value,
      });
    } catch (error) {
      return Object.freeze({
        profile: Object.freeze({
          ...CHATGPT_AI_PROFILE,
          available: false,
          reason: error?.code ?? "provider-unavailable",
        }),
        provider: null,
      });
    }
  }

  async function create(request, context) {
    const caller = callerIdentity(context);
    const expiresAt = new Date(now().getTime() + request.timeoutMs).toISOString();
    const response = await providerCall("chatgpt-provider/create", [{
      prompt: formatChatgptPrompt(request.messages),
      title: "Hara Playground request",
      callerAppId: caller.appId,
      callerOrigin: caller.origin,
      callerGrantId: caller.grantId,
      requestId: request.requestId,
      model: request.model,
      expiresAt,
    }]);
    assertCaller(response.session, context);
    return aiResult(response.session);
  }

  async function result(value, context) {
    const response = await providerCall("chatgpt-provider/get-request", [requestId(value)]);
    assertCaller(response.session, context);
    return aiResult(response.session);
  }

  async function cancel(value, context) {
    const id = requestId(value);
    let current;
    try {
      current = await providerCall("chatgpt-provider/get-request", [id]);
    } catch (error) {
      if (error?.code === "SESSION_NOT_FOUND") {
        return Object.freeze({ requestId: id, cancelled: false });
      }
      throw error;
    }
    assertCaller(current.session, context);
    const response = await providerCall("chatgpt-provider/cancel-request", [id]);
    return Object.freeze({
      requestId: id,
      sessionId: response.session.id,
      cancelled: response.session.state === "cancelled",
      state: response.session.state,
    });
  }

  return Object.freeze({
    handles: (profileId) => profileId === CHATGPT_PROVIDER_ID,
    status,
    create,
    result,
    cancel,
  });
}
