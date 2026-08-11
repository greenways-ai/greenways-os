export const CHATGPT_PROVIDER_PROTOCOL = "greenways-chatgpt-provider/0-alpha";
export const CHATGPT_PROVIDER_SESSION_PROTOCOL = "greenways-model-session/0-alpha";
export const CHATGPT_PROVIDER_MESSAGE_TYPE = "greenways/chatgpt-provider";
export const CHATGPT_PROVIDER_APP_ID = "chatgpt-provider";
export const CHATGPT_PROVIDER_CAPABILITY = "model/provide";
export const CHATGPT_PROVIDER_ID = "webapp.chatgpt";
export const CHATGPT_PROVIDER_ORIGINS = Object.freeze([
  "https://chatgpt.com/*",
  "https://www.chatgpt.com/*",
  "https://chat.openai.com/*",
]);
export const CHATGPT_PROVIDER_ORIGIN_SET = Object.freeze(new Set([
  "https://chatgpt.com",
  "https://www.chatgpt.com",
  "https://chat.openai.com",
]));
export const CHATGPT_PROVIDER_SCRIPT_ID = "greenways-chatgpt-provider";
export const CHATGPT_PROVIDER_SCRIPT = "dist/chatgpt-provider-bridge.js";

export const CHATGPT_PROVIDER_STATES = Object.freeze([
  "created",
  "attached",
  "staged",
  "ready",
  "returned",
  "cancelled",
  "expired",
]);

export function isApprovedChatgptOrigin(value) {
  try {
    return CHATGPT_PROVIDER_ORIGIN_SET.has(new URL(value).origin);
  } catch {
    return false;
  }
}
