import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAYGROUND_AI_MESSAGE_TYPE,
  PLAYGROUND_AI_PROTOCOL,
  createPlaygroundAiMessageHandler,
  principalFromPlaygroundSender,
} from "../src/playground-ai-host.js";

const runtime = {
  id: "greenways-extension",
  getURL: (path) => `chrome-extension://greenways-extension/${path}`,
};
const sender = {
  id: runtime.id,
  url: "https://playground.hara-lang.org/project?repo=hara-lang/hara",
  frameId: 0,
  documentId: "document-playground-0001",
  tab: { id: 42, incognito: false },
};
const message = (operation, payload = {}, requestId = "bridge/0123456789abcdef") => ({
  type: PLAYGROUND_AI_MESSAGE_TYPE,
  protocol: PLAYGROUND_AI_PROTOCOL,
  requestId,
  operation,
  payload,
});

function invoke(handler, request, source = sender) {
  return new Promise((resolve) => {
    assert.equal(handler(request, source, resolve), true);
  });
}

function services() {
  const calls = [];
  const grant = {
    id: "grant/hara-playground/model-generate/12345678",
    constraints: { origins: ["https://playground.hara-lang.org"], maxOutputTokens: 4096 },
  };
  const authority = {
    async status() {
      calls.push(["status"]);
      return { installed: true, eligible: true, granted: true, allowed: true, reason: "allowed", grant };
    },
    async assert() {
      calls.push(["assert"]);
      return { installed: true, eligible: true, granted: true, allowed: true, reason: "allowed", grant };
    },
  };
  const aiService = {
    async status() {
      calls.push(["ai-status"]);
      return {
        protocol: "greenways-ai/1",
        providerProfiles: [{ id: "openai.primary.abc123", provider: "openai", label: "Primary" }],
        providerCredentialStorage: "session",
        providerAccess: { openai: true },
      };
    },
    async generate(request, context) {
      calls.push(["generate", request, context]);
      return {
        protocol: "greenways-ai/1",
        requestId: request.requestId,
        provider: "openai",
        profileId: request.profileId,
        model: request.model,
        output: "Use a map.",
      };
    },
    async result(requestId, context) {
      calls.push(["result", requestId, context]);
      return {
        protocol: "greenways-ai/1",
        requestId,
        provider: "webapp.chatgpt",
        sessionId: "model/session/01234567",
        state: "ready",
        pending: true,
      };
    },
    async cancel(requestId, context) {
      calls.push(["cancel", requestId, context]);
      return { requestId, cancelled: true };
    },
  };
  return { calls, grant, authority, aiService };
}

test("accepts only the exact Playground top-frame sender", () => {
  assert.deepEqual(principalFromPlaygroundSender(sender, runtime), {
    appId: "hara-playground",
    origin: "https://playground.hara-lang.org",
    tabId: 42,
    documentId: "document-playground-0001",
  });
  assert.throws(
    () => principalFromPlaygroundSender({ ...sender, url: "https://playground.hara-lang.io/" }, runtime),
    (error) => error.code === "CALLER_DENIED",
  );
  assert.throws(
    () => principalFromPlaygroundSender({ ...sender, frameId: 1 }, runtime),
    /top frame/,
  );
  assert.throws(
    () => principalFromPlaygroundSender({ ...sender, id: "other-extension" }, runtime),
    /not this extension/,
  );
});

test("projects public AI and capability status without credentials", async () => {
  const service = services();
  const handler = createPlaygroundAiMessageHandler({
    runtime,
    tabs: { create: async () => ({ id: 90 }) },
    getAuthority: async () => service.authority,
    getAiService: async () => service.aiService,
  });
  const response = await invoke(handler, message("status"));
  assert.equal(response.ok, true);
  assert.equal(response.origin, "https://playground.hara-lang.org");
  assert.equal(response.capability.allowed, true);
  assert.equal(response.capability.grantId, service.grant.id);
  assert.equal(response.ai.providerProfiles[0].id, "openai.primary.abc123");
  assert.equal("secret" in response.ai.providerProfiles[0], false);
});

test("requires active model authority before generation", async () => {
  const service = services();
  const handler = createPlaygroundAiMessageHandler({
    runtime,
    tabs: { create: async () => ({ id: 90 }) },
    getAuthority: async () => service.authority,
    getAiService: async () => service.aiService,
  });
  const response = await invoke(handler, message("generate", {
    profileId: "openai.primary.abc123",
    model: "gpt-5",
    messages: [{ role: "user", content: "Explain this form" }],
    maxOutputTokens: 1000,
    timeoutMs: 60000,
  }));
  assert.equal(response.ok, true);
  assert.equal(response.result.output, "Use a map.");
  assert.equal(service.calls[0][0], "assert");
  const generation = service.calls.find(([name]) => name === "generate");
  assert.equal(generation[1].requestId, "bridge/0123456789abcdef");
  assert.equal(generation[2].grant.id, service.grant.id);
  assert.equal(generation[2].origin, "https://playground.hara-lang.org");
});

test("opens the Greenways OS app-management surface", async () => {
  const opened = [];
  const service = services();
  const handler = createPlaygroundAiMessageHandler({
    runtime,
    tabs: { create: async (options) => { opened.push(options); return { id: 91 }; } },
    getAuthority: async () => service.authority,
    getAiService: async () => service.aiService,
  });
  const response = await invoke(handler, message("open"));
  assert.equal(response.ok, true);
  assert.equal(response.tabId, 91);
  assert.deepEqual(opened, [{
    url: "chrome-extension://greenways-extension/src/launcher.html#manage-hara-playground",
    active: true,
  }]);
});

test("rejects arbitrary methods and payloads", async () => {
  const service = services();
  const handler = createPlaygroundAiMessageHandler({
    runtime,
    tabs: { create: async () => ({ id: 90 }) },
    getAuthority: async () => service.authority,
    getAiService: async () => service.aiService,
  });
  const unsupported = await new Promise((resolve) => {
    assert.equal(handler(message("fetch", { url: "https://attacker.example" }), sender, resolve), false);
  });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, "METHOD_DENIED");

  const payload = await invoke(handler, message("status", { url: "https://attacker.example" }));
  assert.equal(payload.ok, false);
  assert.equal(payload.code, "INVALID_REQUEST");
});

test("polls and cancels foreground sessions only with current model authority", async () => {
  const service = services();
  const handler = createPlaygroundAiMessageHandler({
    runtime,
    tabs: { create: async () => ({ id: 90 }) },
    getAuthority: async () => service.authority,
    getAiService: async () => service.aiService,
  });
  const result = await invoke(handler, message("result", {
    requestId: "request/0123456789abcdef",
  }));
  assert.equal(result.ok, true);
  assert.equal(result.result.pending, true);
  const polled = service.calls.find(([name]) => name === "result");
  assert.equal(polled[1], "request/0123456789abcdef");
  assert.equal(polled[2].grant.id, service.grant.id);

  const cancelled = await invoke(handler, message("cancel", {
    requestId: "request/0123456789abcdef",
  }));
  assert.equal(cancelled.result.cancelled, true);
  const cancel = service.calls.find(([name]) => name === "cancel");
  assert.equal(cancel[2].grant.id, service.grant.id);
});
