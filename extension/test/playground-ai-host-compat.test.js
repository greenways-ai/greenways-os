import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAYGROUND_AI_MESSAGE_TYPE,
  PLAYGROUND_AI_PROTOCOL,
  createPlaygroundAiMessageHandler,
} from "../src/playground-ai-host.js";

const runtime = {
  id: "greenways-extension",
  getURL: (path) => `chrome-extension://greenways-extension/${path}`,
};

const sender = {
  id: runtime.id,
  url: "https://playground.hara-lang.org/project",
  frameId: 0,
  documentId: "document-playground-compat-0001",
  tab: { id: 42, incognito: false },
};

function message(operation, payload = {}) {
  return {
    type: PLAYGROUND_AI_MESSAGE_TYPE,
    protocol: PLAYGROUND_AI_PROTOCOL,
    requestId: "bridge/compatibility-0001",
    operation,
    payload,
  };
}

function invoke(handler, request) {
  return new Promise((resolve) => {
    assert.equal(handler(request, sender, resolve), true);
  });
}

test("status requires only the AI status projection", async () => {
  const grant = {
    id: "grant/hara-playground/model-generate/compatibility",
    constraints: { origins: ["https://playground.hara-lang.org"] },
  };
  const authority = {
    async status() {
      return {
        installed: true,
        eligible: true,
        granted: true,
        allowed: true,
        reason: "allowed",
        grant,
      };
    },
    async assert() {
      return this.status();
    },
  };
  const statusOnlyService = {
    async status() {
      return {
        protocol: "greenways-ai/1",
        providerProfiles: [],
        providerCredentialStorage: "session",
        providerAccess: {},
      };
    },
  };
  const handler = createPlaygroundAiMessageHandler({
    runtime,
    tabs: { create: async () => ({ id: 90 }) },
    getAuthority: async () => authority,
    getAiService: async () => statusOnlyService,
  });

  const response = await invoke(handler, message("status"));
  assert.equal(response.ok, true);
  assert.equal(response.capability.allowed, true);
  assert.equal(response.ai.protocol, "greenways-ai/1");
});
