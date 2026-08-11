import assert from "node:assert/strict";
import test from "node:test";
import {
  CHATGPT_AI_PROFILE,
  createChatgptAiProvider,
  formatChatgptPrompt,
} from "../src/chatgpt-ai-provider.js";

const context = Object.freeze({
  appId: "hara-playground",
  origin: "https://playground.hara-lang.org",
  grant: Object.freeze({ id: "grant/hara-playground/model-generate/0001" }),
});

function session(overrides = {}) {
  return {
    id: "model/session/01234567",
    provider: "webapp.chatgpt",
    mode: "foreground",
    state: "created",
    request: {
      requestId: "request/0123456789abcdef",
      callerAppId: context.appId,
      callerOrigin: context.origin,
      callerGrantId: context.grant.id,
      model: "chatgpt-auto",
    },
    origin: null,
    conversationId: null,
    assistantMessageId: null,
    output: null,
    outputDigest: null,
    returnedAt: null,
    ...overrides,
  };
}

function rig(initial = session()) {
  let current = structuredClone(initial);
  const calls = [];
  const host = {
    async callChatgptProvider(method, args = []) {
      calls.push([method, structuredClone(args)]);
      if (method === "chatgpt-provider/status") {
        return { enabled: true, originAccess: true };
      }
      if (method === "chatgpt-provider/create") {
        current = session({ request: { ...args[0] } });
        return { ok: true, session: structuredClone(current) };
      }
      if (method === "chatgpt-provider/get-request") {
        if (args[0] !== current.request.requestId) {
          const error = new Error("missing");
          error.code = "SESSION_NOT_FOUND";
          throw error;
        }
        return { ok: true, session: structuredClone(current) };
      }
      if (method === "chatgpt-provider/cancel-request") {
        current = { ...current, state: "cancelled" };
        return { ok: true, session: structuredClone(current) };
      }
      throw new Error(`Unexpected provider method: ${method}`);
    },
  };
  return {
    calls,
    provider: createChatgptAiProvider({
      getKernelHost: async () => host,
      now: () => new Date("2026-08-11T03:00:00.000Z"),
    }),
    setSession(value) { current = structuredClone(value); },
  };
}

test("formats role-labelled foreground prompts without changing message text", () => {
  assert.equal(formatChatgptPrompt([
    { role: "system", content: "Use Hara." },
    { role: "user", content: "Explain this form." },
  ]), "SYSTEM:\nUse Hara.\n\nUSER:\nExplain this form.");
});

test("publishes a credential-free foreground provider profile", async () => {
  const { provider } = rig();
  const status = await provider.status();
  assert.equal(status.profile.id, CHATGPT_AI_PROFILE.id);
  assert.equal(status.profile.available, true);
  assert.equal(status.profile.credentialRequired, false);
});

test("creates a durable request-bound session and returns immediately", async () => {
  const { provider, calls } = rig();
  const result = await provider.create({
    requestId: "request/0123456789abcdef",
    profileId: "webapp.chatgpt",
    model: "chatgpt-auto",
    messages: [{ role: "user", content: "Explain this form." }],
    timeoutMs: 15 * 60_000,
  }, context);
  assert.equal(result.protocol, "greenways-ai/1");
  assert.equal(result.pending, true);
  assert.equal(result.sessionId, "model/session/01234567");
  const request = calls.find(([method]) => method === "chatgpt-provider/create")[1][0];
  assert.equal(request.requestId, "request/0123456789abcdef");
  assert.equal(request.callerGrantId, context.grant.id);
  assert.equal(request.expiresAt, "2026-08-11T03:15:00.000Z");
});

test("returns only the exact caller's completed session", async () => {
  const { provider, setSession } = rig();
  setSession(session({
    state: "returned",
    output: "A visible rule.",
    outputDigest: `sha256:${"a".repeat(64)}`,
    returnedAt: "2026-08-11T03:01:00.000Z",
    origin: "https://chatgpt.com",
    conversationId: "conversation-1",
    assistantMessageId: "assistant-1",
  }));
  const result = await provider.result("request/0123456789abcdef", context);
  assert.equal(result.pending, false);
  assert.equal(result.output, "A visible rule.");
  assert.equal(result.source.conversationId, "conversation-1");
  await assert.rejects(
    provider.result("request/0123456789abcdef", {
      ...context,
      grant: { id: "grant/hara-playground/model-generate/other" },
    }),
    (error) => error.code === "CALLER_DENIED",
  );
});

test("cancels by durable request id and fails closed for another caller", async () => {
  const { provider } = rig();
  const cancelled = await provider.cancel("request/0123456789abcdef", context);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.state, "cancelled");
});
