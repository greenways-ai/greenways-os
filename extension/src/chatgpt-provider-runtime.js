import { modelSessionStore } from "./storage.js";
import {
  CHATGPT_PROVIDER_APP_ID,
  CHATGPT_PROVIDER_CAPABILITY,
  CHATGPT_PROVIDER_ID,
  CHATGPT_PROVIDER_MESSAGE_TYPE,
  CHATGPT_PROVIDER_ORIGINS,
  CHATGPT_PROVIDER_PROTOCOL,
  CHATGPT_PROVIDER_SCRIPT,
  CHATGPT_PROVIDER_SCRIPT_ID,
  CHATGPT_PROVIDER_SESSION_PROTOCOL,
  isApprovedChatgptOrigin,
} from "./chatgpt-provider-protocol.js";

export {
  CHATGPT_PROVIDER_APP_ID,
  CHATGPT_PROVIDER_CAPABILITY,
  CHATGPT_PROVIDER_ID,
  CHATGPT_PROVIDER_MESSAGE_TYPE,
  CHATGPT_PROVIDER_ORIGINS,
  CHATGPT_PROVIDER_PROTOCOL,
} from "./chatgpt-provider-protocol.js";

export const CHATGPT_PROVIDER_METHODS = Object.freeze([
  "chatgpt-provider/status",
  "chatgpt-provider/list",
  "chatgpt-provider/get",
  "chatgpt-provider/get-request",
  "chatgpt-provider/create",
  "chatgpt-provider/cancel",
  "chatgpt-provider/cancel-request",
  "chatgpt-provider/set-enabled",
]);

const SESSION_ID = /^model\/session\/[A-Za-z0-9._:-]{8,160}$/;
const APP_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const REQUEST_ID = /^[a-z0-9][a-z0-9._:/-]{15,127}$/i;
const GRANT_ID = /^grant\/[a-z0-9][a-z0-9._/-]{7,126}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,159}$/i;
const SESSION_STATES = new Set([
  "created", "attached", "staged", "ready", "returned", "cancelled", "expired",
]);
const ACTIVE_STATES = new Set(["created", "attached", "staged", "ready"]);
const PAGE_OPERATIONS = new Set(["hello", "staged", "ready", "returned", "dismissed"]);
const REQUEST_KEYS = new Set([
  "prompt", "title", "callerAppId", "callerOrigin", "callerGrantId",
  "requestId", "model", "expiresAt",
]);
const SESSION_KEYS = new Set([
  "protocol", "id", "provider", "mode", "state", "request",
  "tabId", "documentId", "origin", "conversationId", "assistantMessageId",
  "candidate", "output", "outputDigest", "createdAt", "updatedAt", "returnedAt",
]);
const CANDIDATE_KEYS = new Set(["output", "assistantMessageId"]);
const PAGE_MESSAGE_KEYS = new Set(["type", "protocol", "operation", "sessionId", "payload"]);
const MAX_PROMPT_CHARS = 64 * 1024;
const MAX_OUTPUT_CHARS = 256 * 1024;

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

function string(value, label, maximum, { empty = false } = {}) {
  if (typeof value !== "string") throw errorWithCode(`${label} must be a string`, "INVALID_REQUEST");
  const output = value.trim();
  if (!empty && !output) throw errorWithCode(`${label} cannot be empty`, "INVALID_REQUEST");
  if (output.length > maximum) {
    throw errorWithCode(`${label} cannot exceed ${maximum} characters`, "REQUEST_TOO_LARGE");
  }
  return output;
}

function optionalString(value, label, maximum) {
  return value === undefined || value === null || value === "" ? null : string(value, label, maximum);
}

function optionalMatchingString(value, pattern, label, maximum) {
  const output = optionalString(value, label, maximum);
  if (output !== null && !pattern.test(output)) {
    throw errorWithCode(`${label} is invalid`, "INVALID_REQUEST");
  }
  return output;
}

function optionalOrigin(value) {
  const output = optionalString(value, "Caller origin", 240);
  if (output === null) return null;
  let parsed;
  try {
    parsed = new URL(output);
  } catch {
    throw errorWithCode("Caller origin is invalid", "INVALID_REQUEST");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw errorWithCode("Caller origin must be a credential-free HTTPS origin", "INVALID_REQUEST");
  }
  return parsed.origin;
}

function normalizeRequest(value) {
  const input = plainObject(value, "ChatGPT provider request");
  closedKeys(input, REQUEST_KEYS, "ChatGPT provider request");
  const callerAppId = optionalString(input.callerAppId, "Caller app id", 80) ?? CHATGPT_PROVIDER_APP_ID;
  if (!APP_ID.test(callerAppId)) throw errorWithCode("Caller app id is invalid", "INVALID_REQUEST");
  const model = optionalMatchingString(input.model, MODEL_ID, "Requested model id", 160);
  if (model?.includes("://")) throw errorWithCode("Requested model id is invalid", "INVALID_REQUEST");
  return Object.freeze({
    prompt: string(input.prompt, "ChatGPT provider prompt", MAX_PROMPT_CHARS),
    title: optionalString(input.title, "ChatGPT provider title", 160) ?? "Greenways request",
    callerAppId,
    callerOrigin: optionalOrigin(input.callerOrigin),
    callerGrantId: optionalMatchingString(input.callerGrantId, GRANT_ID, "Caller grant id", 128),
    requestId: optionalMatchingString(input.requestId, REQUEST_ID, "Caller request id", 128),
    model,
    expiresAt: canonicalTime(input.expiresAt, "ChatGPT provider request expiresAt", { optional: true }),
  });
}

function normalizeSessionId(value) {
  const output = string(value, "Model session id", 180);
  if (!SESSION_ID.test(output)) throw errorWithCode("Model session id is invalid", "INVALID_REQUEST");
  return output;
}

function randomSessionId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === "function") {
    return `model/session/${cryptoImpl.randomUUID()}`;
  }
  const bytes = cryptoImpl?.getRandomValues?.(new Uint8Array(16));
  if (!bytes) throw errorWithCode("Secure randomness is unavailable", "RUNTIME_UNAVAILABLE");
  return `model/session/${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function sha256(value, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw errorWithCode("WebCrypto is unavailable", "RUNTIME_UNAVAILABLE");
  const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function canonicalTime(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined)) return null;
  const output = string(value, label, 80);
  if (!Number.isFinite(Date.parse(output)) || new Date(output).toISOString() !== output) {
    throw errorWithCode(`${label} must be a canonical UTC timestamp`, "SESSION_INVALID");
  }
  return output;
}

function optionalSessionString(value, label, maximum) {
  return value === null || value === undefined ? null : string(value, label, maximum);
}

function validateCandidate(value) {
  if (value === null) return null;
  const input = plainObject(value, "ChatGPT provider response candidate");
  closedKeys(input, CANDIDATE_KEYS, "ChatGPT provider response candidate");
  return Object.freeze({
    output: string(input.output, "ChatGPT provider response candidate output", MAX_OUTPUT_CHARS),
    assistantMessageId: optionalSessionString(
      input.assistantMessageId,
      "ChatGPT provider response candidate message id",
      180,
    ),
  });
}

function validateSession(value) {
  const input = plainObject(value, "ChatGPT provider session");
  closedKeys(input, SESSION_KEYS, "ChatGPT provider session");
  if (input.protocol !== CHATGPT_PROVIDER_SESSION_PROTOCOL) {
    throw errorWithCode("ChatGPT provider session protocol is unsupported", "SESSION_INVALID");
  }
  normalizeSessionId(input.id);
  if (input.provider !== CHATGPT_PROVIDER_ID || input.mode !== "foreground") {
    throw errorWithCode("ChatGPT provider session identity is invalid", "SESSION_INVALID");
  }
  if (!SESSION_STATES.has(input.state)) throw errorWithCode("ChatGPT provider session state is invalid", "SESSION_INVALID");
  normalizeRequest(input.request);
  if (!Number.isInteger(input.tabId) || input.tabId < 0) {
    throw errorWithCode("ChatGPT provider session tab id is invalid", "SESSION_INVALID");
  }
  optionalSessionString(input.documentId, "ChatGPT provider session document id", 240);
  if (input.origin !== null && !isApprovedChatgptOrigin(input.origin)) {
    throw errorWithCode("ChatGPT provider session origin is invalid", "SESSION_INVALID");
  }
  optionalSessionString(input.conversationId, "ChatGPT provider session conversation id", 180);
  optionalSessionString(input.assistantMessageId, "ChatGPT provider session assistant message id", 180);
  const candidate = validateCandidate(input.candidate);
  const output = optionalSessionString(input.output, "ChatGPT provider session output", MAX_OUTPUT_CHARS);
  const outputDigest = optionalSessionString(input.outputDigest, "ChatGPT provider session output digest", 80);
  if (outputDigest !== null && !/^sha256:[a-f0-9]{64}$/.test(outputDigest)) {
    throw errorWithCode("ChatGPT provider session output digest is invalid", "SESSION_INVALID");
  }
  canonicalTime(input.createdAt, "ChatGPT provider session createdAt");
  canonicalTime(input.updatedAt, "ChatGPT provider session updatedAt");
  canonicalTime(input.returnedAt, "ChatGPT provider session returnedAt", { optional: true });
  if (input.state === "ready" && !candidate) {
    throw errorWithCode("Ready ChatGPT provider sessions require a response candidate", "SESSION_INVALID");
  }
  if (input.state === "returned" && (!output || !outputDigest || !input.returnedAt || candidate)) {
    throw errorWithCode("Returned ChatGPT provider sessions require one final digested output", "SESSION_INVALID");
  }
  return input;
}

function publicSession(session) {
  return Object.freeze({
    id: session.id,
    provider: session.provider,
    mode: session.mode,
    state: session.state,
    request: Object.freeze({
      title: session.request.title,
      callerAppId: session.request.callerAppId,
      callerOrigin: session.request.callerOrigin ?? null,
      callerGrantId: session.request.callerGrantId ?? null,
      requestId: session.request.requestId ?? null,
      model: session.request.model ?? null,
      expiresAt: session.request.expiresAt ?? null,
      prompt: session.request.prompt,
    }),
    tabId: Number.isInteger(session.tabId) ? session.tabId : null,
    documentId: typeof session.documentId === "string" ? session.documentId : null,
    origin: typeof session.origin === "string" ? session.origin : null,
    conversationId: session.conversationId ?? null,
    assistantMessageId: session.assistantMessageId ?? null,
    output: session.output ?? null,
    outputDigest: session.outputDigest ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    returnedAt: session.returnedAt ?? null,
  });
}

function pageSession(session) {
  return Object.freeze({
    id: session.id,
    title: session.request.title,
    prompt: session.request.prompt,
    callerAppId: session.request.callerAppId,
    createdAt: session.createdAt,
  });
}

function pagePayload(value) {
  return value === undefined ? {} : plainObject(value, "ChatGPT provider page payload");
}

function normalizePageMessage(value) {
  const input = plainObject(value, "ChatGPT provider page message");
  closedKeys(input, PAGE_MESSAGE_KEYS, "ChatGPT provider page message");
  if (input.type !== CHATGPT_PROVIDER_MESSAGE_TYPE || input.protocol !== CHATGPT_PROVIDER_PROTOCOL) {
    throw errorWithCode("ChatGPT provider page protocol is unsupported", "INVALID_REQUEST");
  }
  const operation = string(input.operation, "ChatGPT provider page operation", 40);
  if (!PAGE_OPERATIONS.has(operation)) throw errorWithCode("ChatGPT provider page operation is unsupported", "METHOD_DENIED");
  const sessionId = input.sessionId === null || input.sessionId === undefined
    ? null
    : normalizeSessionId(input.sessionId);
  return Object.freeze({ operation, sessionId, payload: pagePayload(input.payload) });
}

function senderPrincipal(sender, runtime) {
  if (!runtime?.id || sender?.id !== runtime.id) {
    throw errorWithCode("ChatGPT provider sender is not this extension", "CALLER_DENIED");
  }
  if (sender?.frameId !== 0 || sender?.tab?.incognito || !Number.isInteger(sender?.tab?.id)) {
    throw errorWithCode("ChatGPT provider requires a normal top-level tab", "CALLER_DENIED");
  }
  if (!isApprovedChatgptOrigin(sender.url)) {
    throw errorWithCode("ChatGPT provider rejected an unapproved origin", "CALLER_DENIED");
  }
  return Object.freeze({
    tabId: sender.tab.id,
    documentId: typeof sender.documentId === "string" ? sender.documentId : null,
    origin: new URL(sender.url).origin,
  });
}

function commandFor(session) {
  return session && ACTIVE_STATES.has(session.state)
    ? Object.freeze({ operation: "stage", session: pageSession(session) })
    : null;
}

export function createChatgptProviderRuntime({
  store = modelSessionStore,
  scripting = globalThis.chrome?.scripting,
  tabs = globalThis.chrome?.tabs,
  permissions = globalThis.chrome?.permissions,
  runtime = globalThis.chrome?.runtime,
  assertAuthority = async () => {},
  now = () => new Date(),
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (!store || typeof store.values !== "function" || typeof store.put !== "function") {
    throw new TypeError("ChatGPT provider requires durable model-session storage");
  }
  if (typeof assertAuthority !== "function") throw new TypeError("ChatGPT provider requires an authority gate");
  if (typeof now !== "function") throw new TypeError("ChatGPT provider requires a clock");

  async function expireIfNeeded(session) {
    if (!ACTIVE_STATES.has(session.state)
        || !session.request.expiresAt
        || session.request.expiresAt > now().toISOString()) return session;
    const expired = await save({ ...session, state: "expired", candidate: null });
    if (Number.isInteger(expired.tabId) && typeof tabs?.sendMessage === "function") {
      await tabs.sendMessage(expired.tabId, {
        type: CHATGPT_PROVIDER_MESSAGE_TYPE,
        protocol: CHATGPT_PROVIDER_PROTOCOL,
        operation: "clear",
        sessionId: expired.id,
      }).catch(() => {});
    }
    return expired;
  }

  async function records({ expire = false } = {}) {
    const output = [];
    for (const record of (await store.values())
      .filter((candidate) => candidate?.protocol === CHATGPT_PROVIDER_SESSION_PROTOCOL)) {
      const session = validateSession(record);
      output.push(expire ? await expireIfNeeded(session) : session);
    }
    return output.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function get(id, { expire = false } = {}) {
    const record = await store.get(normalizeSessionId(id));
    if (!record || record.protocol !== CHATGPT_PROVIDER_SESSION_PROTOCOL) {
      throw errorWithCode("ChatGPT provider session does not exist", "SESSION_NOT_FOUND");
    }
    const session = validateSession(record);
    return expire ? expireIfNeeded(session) : session;
  }

  async function requestSession(id, { expire = false } = {}) {
    const requested = string(id, "Caller model request id", 128);
    if (!REQUEST_ID.test(requested)) throw errorWithCode("Caller model request id is invalid", "INVALID_REQUEST");
    const session = (await records({ expire })).find(({ request }) => request.requestId === requested);
    if (!session) throw errorWithCode("ChatGPT provider session does not exist", "SESSION_NOT_FOUND");
    return session;
  }

  async function save(record) {
    const value = Object.freeze({ ...record, updatedAt: now().toISOString() });
    validateSession(value);
    await store.put(value);
    return value;
  }

  async function registrations() {
    if (!scripting?.getRegisteredContentScripts) return [];
    return scripting.getRegisteredContentScripts({ ids: [CHATGPT_PROVIDER_SCRIPT_ID] });
  }

  async function hasOriginAccess() {
    if (!permissions?.contains) return false;
    return permissions.contains({ origins: CHATGPT_PROVIDER_ORIGINS });
  }

  async function status() {
    const [registered, sessions, originAccess] = await Promise.all([
      registrations(),
      records({ expire: true }),
      hasOriginAccess().catch(() => false),
    ]);
    return Object.freeze({
      ok: true,
      protocol: CHATGPT_PROVIDER_PROTOCOL,
      provider: CHATGPT_PROVIDER_ID,
      mode: "foreground",
      enabled: registered.length === 1,
      originAccess,
      activeSessions: sessions.filter(({ state }) => ACTIVE_STATES.has(state)).length,
      returnedSessions: sessions.filter(({ state }) => state === "returned").length,
    });
  }

  async function setEnabled(args) {
    await assertAuthority();
    const enabled = args[0];
    if (typeof enabled !== "boolean") throw errorWithCode("ChatGPT provider enabled state must be boolean", "INVALID_REQUEST");
    if (!scripting?.registerContentScripts || !scripting?.unregisterContentScripts) {
      throw errorWithCode("Chrome scripting is unavailable", "PROVIDER_UNAVAILABLE");
    }
    await scripting.unregisterContentScripts({ ids: [CHATGPT_PROVIDER_SCRIPT_ID] }).catch(() => {});
    if (enabled) {
      if (!await hasOriginAccess()) {
        throw errorWithCode("ChatGPT origin access has not been approved", "PROVIDER_PERMISSION_REQUIRED");
      }
      await scripting.registerContentScripts([{
        id: CHATGPT_PROVIDER_SCRIPT_ID,
        js: [CHATGPT_PROVIDER_SCRIPT],
        matches: CHATGPT_PROVIDER_ORIGINS,
        runAt: "document_idle",
        persistAcrossSessions: true,
      }]);
    } else {
      for (const current of (await records()).filter(({ state }) => ACTIVE_STATES.has(state))) {
        const cancelled = await save({ ...current, state: "cancelled", candidate: null });
        if (typeof tabs?.sendMessage === "function") {
          await tabs.sendMessage(cancelled.tabId, {
            type: CHATGPT_PROVIDER_MESSAGE_TYPE,
            protocol: CHATGPT_PROVIDER_PROTOCOL,
            operation: "clear",
            sessionId: cancelled.id,
          }).catch(() => {});
        }
      }
    }
    return status();
  }

  async function chatgptTab() {
    if (!tabs?.query || !tabs?.create) throw errorWithCode("Chrome tabs are unavailable", "PROVIDER_UNAVAILABLE");
    const busyTabIds = new Set((await records({ expire: true }))
      .filter(({ state, tabId }) => ACTIVE_STATES.has(state) && Number.isInteger(tabId))
      .map(({ tabId }) => tabId));
    const candidates = await tabs.query({ url: CHATGPT_PROVIDER_ORIGINS });
    const existing = candidates.find((tab) => (
      Number.isInteger(tab.id) && !tab.incognito && !busyTabIds.has(tab.id)
    ));
    if (existing) {
      if (typeof tabs.update === "function") {
        await tabs.update(existing.id, { active: true }).catch(() => {});
      }
      return existing;
    }
    return tabs.create({ url: "https://chatgpt.com/", active: true });
  }

  async function create(args) {
    await assertAuthority();
    const request = normalizeRequest(args[0]);
    if (request.requestId) {
      const existing = (await records({ expire: true }))
        .find((session) => session.request.requestId === request.requestId);
      if (existing) {
        if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
          throw errorWithCode("Caller model request id was reused with different content", "REQUEST_ID_REUSE");
        }
        return Object.freeze({ ok: true, replayed: true, session: publicSession(existing) });
      }
    }
    const providerStatus = await status();
    if (!providerStatus.enabled) throw errorWithCode("Greenways for ChatGPT is not enabled", "PROVIDER_DISABLED");
    const tab = await chatgptTab();
    if (!Number.isInteger(tab?.id)) throw errorWithCode("ChatGPT tab could not be opened", "PROVIDER_UNAVAILABLE");
    const timestamp = now().toISOString();
    const session = await save({
      protocol: CHATGPT_PROVIDER_SESSION_PROTOCOL,
      id: randomSessionId(cryptoImpl),
      provider: CHATGPT_PROVIDER_ID,
      mode: "foreground",
      state: "created",
      request,
      tabId: tab.id,
      documentId: null,
      origin: null,
      conversationId: null,
      assistantMessageId: null,
      candidate: null,
      output: null,
      outputDigest: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      returnedAt: null,
    });
    if (typeof tabs.sendMessage === "function") {
      await tabs.sendMessage(tab.id, {
        type: CHATGPT_PROVIDER_MESSAGE_TYPE,
        protocol: CHATGPT_PROVIDER_PROTOCOL,
        operation: "stage",
        session: pageSession(session),
      }).catch(() => {});
    }
    return Object.freeze({ ok: true, session: publicSession(session) });
  }

  async function list() {
    await assertAuthority();
    return Object.freeze({ ok: true, sessions: Object.freeze((await records({ expire: true })).map(publicSession)) });
  }

  async function read(args) {
    await assertAuthority();
    return Object.freeze({ ok: true, session: publicSession(await get(args[0], { expire: true })) });
  }

  async function readRequest(args) {
    await assertAuthority();
    return Object.freeze({ ok: true, session: publicSession(await requestSession(args[0], { expire: true })) });
  }

  async function cancelCurrent(current) {
    if (!ACTIVE_STATES.has(current.state)) return Object.freeze({ ok: true, session: publicSession(current) });
    const session = await save({ ...current, state: "cancelled", candidate: null });
    if (Number.isInteger(session.tabId) && typeof tabs?.sendMessage === "function") {
      await tabs.sendMessage(session.tabId, {
        type: CHATGPT_PROVIDER_MESSAGE_TYPE,
        protocol: CHATGPT_PROVIDER_PROTOCOL,
        operation: "clear",
        sessionId: session.id,
      }).catch(() => {});
    }
    return Object.freeze({ ok: true, session: publicSession(session) });
  }

  async function cancel(args) {
    await assertAuthority();
    const current = await get(args[0], { expire: true });
    return cancelCurrent(current);
  }

  async function cancelRequest(args) {
    await assertAuthority();
    return cancelCurrent(await requestSession(args[0], { expire: true }));
  }

  async function pendingForTab(tabId) {
    return (await records({ expire: true }))
      .find((session) => session.tabId === tabId && ACTIVE_STATES.has(session.state)) ?? null;
  }

  async function handlePageMessage(value, sender) {
    await assertAuthority();
    const principal = senderPrincipal(sender, runtime);
    const message = normalizePageMessage(value);
    if (message.operation === "hello") {
      const pending = await pendingForTab(principal.tabId);
      if (!pending) return Object.freeze({ ok: true, protocol: CHATGPT_PROVIDER_PROTOCOL, command: null });
      const payload = message.payload;
      const session = await save({
        ...pending,
        state: pending.state === "created" ? "attached" : pending.state,
        documentId: principal.documentId,
        origin: principal.origin,
        conversationId: optionalString(payload.conversationId, "ChatGPT conversation id", 180),
      });
      return Object.freeze({ ok: true, protocol: CHATGPT_PROVIDER_PROTOCOL, command: commandFor(session) });
    }
    if (!message.sessionId) throw errorWithCode("ChatGPT provider page event requires a session id", "INVALID_REQUEST");
    const current = await get(message.sessionId);
    if (current.tabId !== principal.tabId) throw errorWithCode("ChatGPT provider session is bound to another tab", "CALLER_DENIED");
    if (current.origin && current.origin !== principal.origin) {
      throw errorWithCode("ChatGPT provider session origin changed", "CALLER_DENIED");
    }
    if (current.documentId && principal.documentId && current.documentId !== principal.documentId
        && !new Set(["created", "attached"]).has(current.state)) {
      throw errorWithCode("ChatGPT provider session is bound to another page document", "CALLER_DENIED");
    }
    const incomingConversationId = optionalString(
      message.payload.conversationId,
      "ChatGPT conversation id",
      180,
    );
    const common = {
      ...current,
      documentId: principal.documentId,
      origin: principal.origin,
      conversationId: incomingConversationId ?? current.conversationId,
    };
    if (message.operation === "staged") {
      if (!new Set(["created", "attached", "staged"]).has(current.state)) {
        throw errorWithCode("ChatGPT provider session cannot be staged from its current state", "SESSION_STATE_INVALID");
      }
      const session = await save({ ...common, state: "staged" });
      return Object.freeze({ ok: true, protocol: CHATGPT_PROVIDER_PROTOCOL, session: publicSession(session) });
    }
    if (message.operation === "ready") {
      if (!new Set(["staged", "ready"]).has(current.state)) {
        throw errorWithCode("ChatGPT provider session cannot accept a response from its current state", "SESSION_STATE_INVALID");
      }
      const output = string(message.payload.output, "ChatGPT response", MAX_OUTPUT_CHARS);
      const assistantMessageId = optionalString(message.payload.assistantMessageId, "ChatGPT assistant message id", 180);
      const session = await save({
        ...common,
        state: "ready",
        assistantMessageId,
        candidate: Object.freeze({ output, assistantMessageId }),
      });
      return Object.freeze({ ok: true, protocol: CHATGPT_PROVIDER_PROTOCOL, session: publicSession(session) });
    }
    if (message.operation === "returned") {
      if (current.state !== "ready" || !current.candidate) {
        throw errorWithCode("ChatGPT response is not ready to return", "SESSION_STATE_INVALID");
      }
      const output = string(message.payload.output, "Returned ChatGPT response", MAX_OUTPUT_CHARS);
      const assistantMessageId = optionalString(
        message.payload.assistantMessageId,
        "Returned ChatGPT assistant message id",
        180,
      );
      if (output !== current.candidate.output
          || assistantMessageId !== current.candidate.assistantMessageId
          || (current.conversationId && incomingConversationId !== current.conversationId)) {
        throw errorWithCode("Returned ChatGPT response does not match the reviewed candidate", "SESSION_RESULT_MISMATCH");
      }
      const returnedAt = now().toISOString();
      const session = await save({
        ...common,
        state: "returned",
        assistantMessageId: current.candidate.assistantMessageId,
        output,
        outputDigest: await sha256(output, cryptoImpl),
        candidate: null,
        returnedAt,
      });
      return Object.freeze({ ok: true, protocol: CHATGPT_PROVIDER_PROTOCOL, session: publicSession(session) });
    }
    const session = await save({ ...common, state: "cancelled", candidate: null });
    return Object.freeze({ ok: true, protocol: CHATGPT_PROVIDER_PROTOCOL, session: publicSession(session) });
  }

  return Object.freeze({
    async call(method, args = []) {
      if (!CHATGPT_PROVIDER_METHODS.includes(method)) {
        throw errorWithCode(`Unsupported ChatGPT provider method: ${method}`, "METHOD_DENIED");
      }
      if (method === "chatgpt-provider/status") return status();
      if (method === "chatgpt-provider/list") return list();
      if (method === "chatgpt-provider/get") return read(args);
      if (method === "chatgpt-provider/get-request") return readRequest(args);
      if (method === "chatgpt-provider/create") return create(args);
      if (method === "chatgpt-provider/cancel") return cancel(args);
      if (method === "chatgpt-provider/cancel-request") return cancelRequest(args);
      return setEnabled(args);
    },
    handlePageMessage,
    status,
  });
}
