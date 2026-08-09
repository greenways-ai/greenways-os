import "../../src/background.js";
import { createPlaygroundAiMessageHandler } from "../../src/playground-ai-host.js";

const fixtureSecret = "fixture-secret-must-never-leave-the-worker";
const grant = {
  id: "grant/hara-playground/model-generate/browser-fixture",
  constraints: { origins: ["https://playground.hara-lang.org"] },
};
const pending = new Map();

globalThis.__greenwaysAiFixture = { mode: "allowed" };

const authority = {
  async status() {
    const allowed = globalThis.__greenwaysAiFixture.mode !== "denied";
    return {
      installed: true,
      eligible: true,
      granted: allowed,
      allowed,
      reason: allowed ? "allowed" : "grant-required",
      grant: allowed ? grant : null,
    };
  },
  async assert() {
    const status = await this.status();
    if (status.allowed) return status;
    const error = new Error("Fixture grant is revoked");
    error.code = "CAPABILITY_DENIED";
    throw error;
  },
};

const aiService = {
  async status() {
    return {
      protocol: "greenways-ai/1",
      providerProfiles: [{ id: "openai.fixture", provider: "openai", label: "Fixture OpenAI" }],
      providerCredentialStorage: "session",
      providerAccess: { openai: true },
    };
  },
  async generate(request) {
    if (globalThis.__greenwaysAiFixture.mode === "permission-denied") {
      const error = new Error("Provider network permission is missing");
      error.code = "PROVIDER_PERMISSION_REQUIRED";
      throw error;
    }
    if (request.profileId !== "openai.fixture") {
      const error = new Error("Unsupported fixture profile");
      error.code = "PROVIDER_PROFILE_NOT_FOUND";
      throw error;
    }
    if (request.model === "fixture/cancel") {
      return new Promise((resolve, reject) => pending.set(request.requestId, { resolve, reject }));
    }
    // The fake adapter deliberately touches its worker-only credential so the
    // browser assertion can prove that it is absent from every page projection.
    if (!fixtureSecret.startsWith("fixture-secret")) throw new Error("Invalid fixture secret");
    return {
      protocol: "greenways-ai/1",
      requestId: request.requestId,
      provider: "openai",
      profileId: request.profileId,
      model: request.model,
      output: "Deterministic fixture completion",
    };
  },
  cancel(requestId) {
    const request = pending.get(requestId);
    pending.delete(requestId);
    if (request) {
      const error = new Error("Model request was cancelled");
      error.code = "REQUEST_CANCELLED";
      request.reject(error);
    }
    return { requestId, cancelled: Boolean(request) };
  },
};

globalThis.chrome.runtime.onMessage.addListener(createPlaygroundAiMessageHandler({
  getAuthority: async () => authority,
  getAiService: async () => aiService,
}));
