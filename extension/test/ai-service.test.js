import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SERVICE_PROTOCOL,
  GreenwaysAiService,
  normalizeModelRequest,
} from "../src/ai-service.js";

const request = (overrides = {}) => ({
  requestId: "request/0123456789abcdef",
  profileId: "openrouter.personal.abc123",
  model: "openai/gpt-5",
  messages: [{ role: "user", content: "Explain this form" }],
  maxOutputTokens: 512,
  timeoutMs: 5000,
  ...overrides,
});

function keyring(profile) {
  return {
    async status() {
      return {
        providerProfiles: [{
          protocol: "greenways-keyring/1",
          id: profile.id,
          provider: profile.provider,
          label: "Coding",
          createdAt: "2026-08-09T00:00:00.000Z",
          sessionOnly: true,
        }],
        providerCredentialStorage: "session",
      };
    },
    async readProfiles() {
      return [profile];
    },
  };
}

function permissions(allowed = true) {
  return {
    calls: [],
    async contains(value) {
      this.calls.push(value);
      return allowed;
    },
  };
}

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(data);
  return {
    ok,
    status,
    headers: { get: (name) => name === "content-length" ? String(text.length) : null },
    async text() { return text; },
  };
}

const context = {
  origin: "https://playground.hara-lang.org",
  appId: "hara-playground",
  grant: {
    capability: "model/generate",
    subject: { appId: "hara-playground" },
    constraints: {
      origins: ["https://playground.hara-lang.org"],
      maxOutputTokens: 4096,
      maxInputBytes: 262144,
      timeoutMs: 120000,
    },
  },
};

test("normalizes a closed, bounded model request", () => {
  const output = normalizeModelRequest(request());
  assert.equal(output.maxOutputTokens, 512);
  assert.ok(Object.isFrozen(output.messages));
  assert.throws(() => normalizeModelRequest(request({ url: "https://attacker.example" })), /unsupported field/);
  assert.throws(() => normalizeModelRequest(request({ model: "https://attacker.example/model" })), /Model id is invalid/);
  assert.throws(() => normalizeModelRequest(request({ messages: [{ role: "tool", content: "x" }] })), /role is not supported/);
});

test("routes OpenRouter through its fixed endpoint and returns only normalized output", async () => {
  const profile = {
    id: "openrouter.personal.abc123",
    provider: "openrouter",
    secret: "sk-or-secret-value",
  };
  const calls = [];
  const access = permissions(true);
  const service = new GreenwaysAiService({
    keyring: keyring(profile),
    permissions: access,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        id: "gen_123",
        model: "openai/gpt-5",
        choices: [{ message: { content: "A Hara form is data." } }],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, cost: 0.001 },
      });
    },
    now: () => "2026-08-09T00:00:01.000Z",
  });

  const result = await service.generate(request(), context);
  assert.equal(result.protocol, AI_SERVICE_PROTOCOL);
  assert.equal(result.output, "A Hara form is data.");
  assert.equal(result.usage.totalTokens, 19);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-or-secret-value");
  assert.equal(calls[0].init.headers["HTTP-Referer"], "https://playground.hara-lang.org/");
  assert.equal(JSON.parse(calls[0].init.body).max_tokens, 512);
  assert.doesNotMatch(JSON.stringify(result), /sk-or-secret-value/);
});

test("uses the OpenAI Responses shape and extracts output text", async () => {
  const profile = { id: "openai.primary.abc123", provider: "openai", secret: "sk-openai-secret" };
  let call;
  const service = new GreenwaysAiService({
    keyring: keyring(profile),
    permissions: permissions(true),
    fetchImpl: async (url, init) => {
      call = { url, init };
      return jsonResponse({
        id: "resp_123",
        model: "gpt-5",
        output: [{ type: "message", content: [{ type: "output_text", text: "Use a vector." }] }],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      });
    },
  });
  const result = await service.generate(request({
    profileId: profile.id,
    model: "gpt-5",
  }), context);
  assert.equal(call.url, "https://api.openai.com/v1/responses");
  assert.equal(JSON.parse(call.init.body).max_output_tokens, 512);
  assert.equal(result.output, "Use a vector.");
});

test("maps system messages into the Anthropic Messages request", async () => {
  const profile = { id: "anthropic.primary.abc123", provider: "anthropic", secret: "sk-ant-secret" };
  let body;
  const service = new GreenwaysAiService({
    keyring: keyring(profile),
    permissions: permissions(true),
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return jsonResponse({
        id: "msg_123",
        model: "claude-model",
        content: [{ type: "text", text: "Balanced forms are easier to transform." }],
        usage: { input_tokens: 9, output_tokens: 6 },
      });
    },
  });
  const result = await service.generate(request({
    profileId: profile.id,
    model: "claude-model",
    messages: [
      { role: "system", content: "You help with Hara." },
      { role: "user", content: "Explain paredit." },
    ],
  }), context);
  assert.equal(body.system, "You help with Hara.");
  assert.deepEqual(body.messages, [{ role: "user", content: "Explain paredit." }]);
  assert.equal(result.usage.totalTokens, 15);
});

test("fails closed for missing provider permission and grant violations", async () => {
  const profile = { id: "openai.primary.abc123", provider: "openai", secret: "sk-openai-secret" };
  const denied = new GreenwaysAiService({
    keyring: keyring(profile),
    permissions: permissions(false),
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  await assert.rejects(
    () => denied.generate(request({ profileId: profile.id, model: "gpt-5" }), context),
    (error) => error.code === "PROVIDER_PERMISSION_REQUIRED",
  );

  const constrained = new GreenwaysAiService({
    keyring: keyring(profile),
    permissions: permissions(true),
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  await assert.rejects(
    () => constrained.generate(request({ profileId: profile.id, model: "gpt-5" }), {
      ...context,
      grant: { constraints: { models: ["gpt-approved"] } },
    }),
    (error) => error.code === "CAPABILITY_DENIED",
  );
});

test("cancels an in-flight request without leaking the provider credential", async () => {
  const profile = { id: "openai.primary.abc123", provider: "openai", secret: "sk-openai-secret" };
  let started;
  const began = new Promise((resolve) => { started = resolve; });
  const service = new GreenwaysAiService({
    keyring: keyring(profile),
    permissions: permissions(true),
    fetchImpl: async (_url, init) => {
      started();
      await new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  });
  const pending = service.generate(request({ profileId: profile.id, model: "gpt-5" }), context);
  await began;
  assert.equal((await service.cancel("request/0123456789abcdef")).cancelled, true);
  await assert.rejects(pending, (error) => error.code === "REQUEST_CANCELLED");
});

test("routes webapp.chatgpt through a durable foreground provider without reading credentials", async () => {
  const calls = [];
  const webProvider = {
    handles: (id) => id === "webapp.chatgpt",
    async status() {
      return { profile: {
        id: "webapp.chatgpt",
        provider: "webapp.chatgpt",
        label: "ChatGPT Web — foreground",
        available: true,
      } };
    },
    async create(value, caller) {
      calls.push(["create", value, caller]);
      return {
        protocol: AI_SERVICE_PROTOCOL,
        requestId: value.requestId,
        provider: "webapp.chatgpt",
        profileId: "webapp.chatgpt",
        model: value.model,
        sessionId: "model/session/01234567",
        state: "created",
        pending: true,
      };
    },
    async result(requestId, caller) {
      calls.push(["result", requestId, caller]);
      return { protocol: AI_SERVICE_PROTOCOL, requestId, provider: "webapp.chatgpt", pending: true };
    },
    async cancel(requestId, caller) {
      calls.push(["cancel", requestId, caller]);
      return { requestId, cancelled: true };
    },
  };
  const noCredentialKeyring = {
    async status() { return { providerProfiles: [], providerCredentialStorage: "session" }; },
    async readProfiles() { throw new Error("foreground provider must not read credentials"); },
  };
  const service = new GreenwaysAiService({
    keyring: noCredentialKeyring,
    webProvider,
    permissions: permissions(false),
    fetchImpl: async () => { throw new Error("foreground provider must not call a provider API"); },
  });
  const foregroundContext = {
    ...context,
    grant: {
      ...context.grant,
      id: "grant/hara-playground/model-generate/0001",
      constraints: {
        ...context.grant.constraints,
        timeoutMs: 15 * 60_000,
      },
    },
  };
  const result = await service.generate(request({
    profileId: "webapp.chatgpt",
    model: "chatgpt-auto",
    timeoutMs: 15 * 60_000,
  }), foregroundContext);
  assert.equal(result.pending, true);
  assert.equal(result.sessionId, "model/session/01234567");
  assert.equal(calls[0][2].grant.id, "grant/hara-playground/model-generate/0001");
  assert.equal((await service.status()).providerAccess["webapp.chatgpt"], true);
  assert.equal((await service.result(result.requestId, foregroundContext)).pending, true);
  assert.equal((await service.cancel(result.requestId, foregroundContext)).cancelled, true);
  assert.throws(
    () => normalizeModelRequest(request({ timeoutMs: 15 * 60_000 })),
    /timeoutMs must be an integer/,
  );
});
