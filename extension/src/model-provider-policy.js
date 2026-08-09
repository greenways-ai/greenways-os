export const MODEL_PROVIDER_POLICY = Object.freeze({
  openrouter: Object.freeze({
    id: "openrouter",
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    permissionOrigin: "https://openrouter.ai/*",
  }),
  openai: Object.freeze({
    id: "openai",
    name: "OpenAI",
    endpoint: "https://api.openai.com/v1/responses",
    permissionOrigin: "https://api.openai.com/*",
  }),
  anthropic: Object.freeze({
    id: "anthropic",
    name: "Anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    permissionOrigin: "https://api.anthropic.com/*",
  }),
});

export const MODEL_PROVIDERS = Object.freeze(Object.values(MODEL_PROVIDER_POLICY));

export function getModelProviderPolicy(provider) {
  return MODEL_PROVIDER_POLICY[String(provider ?? "").toLowerCase()] ?? null;
}
