import { chatStore } from "./storage.js";
import {
  CHATS_APP_ID,
  CHATS_CAPABILITY,
  CHATGPT_ORIGINS,
  createChatConversation,
  searchChatConversations,
  validateChatConversation,
} from "./chats-store.js";

export {
  CHATS_APP_ID,
  CHATS_CAPABILITY,
} from "./chats-store.js";

export const CHATS_METHODS = Object.freeze([
  "chats/status",
  "chats/list",
  "chats/search",
  "chats/import",
  "chats/capture",
  "chats/remove",
  "chats/set-capture",
]);

const CAPTURE_SCRIPT_ID = "greenways-chats-chatgpt";
const CAPTURE_SCRIPT = "src/chats-capture.js";

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function list(value, label) {
  if (!Array.isArray(value)) throw errorWithCode(`${label} must be an array`, "INVALID_REQUEST");
  return value;
}

export function createChatsRuntime({
  store = chatStore,
  scripting = globalThis.chrome?.scripting,
  assertAuthority = async () => {},
} = {}) {
  if (!store || typeof store.values !== "function" || typeof store.put !== "function") {
    throw new TypeError("Chats runtime requires a durable chat store");
  }
  if (typeof assertAuthority !== "function") throw new TypeError("Chats runtime requires an authority gate");

  async function records() {
    return (await store.values()).map(validateChatConversation);
  }

  async function registrations() {
    if (!scripting?.getRegisteredContentScripts) return [];
    return scripting.getRegisteredContentScripts({ ids: [CAPTURE_SCRIPT_ID] });
  }

  async function status() {
    return {
      ok: true,
      available: Boolean(scripting?.registerContentScripts),
      capturing: (await registrations()).length > 0,
      providers: [{ id: "chatgpt", supported: true, origins: CHATGPT_ORIGINS }],
      conversations: (await records()).length,
    };
  }

  async function setCapture(args) {
    await assertAuthority();
    const enabled = args[0];
    if (typeof enabled !== "boolean") throw errorWithCode("Chats capture state must be a boolean", "INVALID_REQUEST");
    if (!scripting?.registerContentScripts || !scripting?.unregisterContentScripts) {
      throw errorWithCode("Chrome scripting is unavailable", "CHATS_CAPTURE_UNAVAILABLE");
    }
    await scripting.unregisterContentScripts({ ids: [CAPTURE_SCRIPT_ID] }).catch(() => {});
    if (enabled) {
      await scripting.registerContentScripts([{
        id: CAPTURE_SCRIPT_ID,
        js: [CAPTURE_SCRIPT],
        matches: CHATGPT_ORIGINS,
        runAt: "document_idle",
        persistAcrossSessions: true,
      }]);
    }
    return status();
  }

  async function putMany(values) {
    await assertAuthority();
    const conversations = list(values, "Chats import").map(validateChatConversation);
    for (const record of conversations) await store.put(record);
    return { ok: true, imported: conversations.length };
  }

  async function capture(args) {
    await assertAuthority();
    const record = await createChatConversation(args[0]);
    const previous = await store.get(record.id);
    if (previous?.digest === record.digest) return { ok: true, changed: false, record: previous };
    await store.put(record);
    return { ok: true, changed: true, record };
  }

  return Object.freeze({
    async call(method, args = []) {
      if (!CHATS_METHODS.includes(method)) throw errorWithCode(`Unsupported Chats method: ${method}`, "INVALID_REQUEST");
      if (method === "chats/status") return status();
      if (method === "chats/list") return { ok: true, conversations: await records() };
      if (method === "chats/search") return { ok: true, results: searchChatConversations(await records(), args[0]) };
      if (method === "chats/import") return putMany(args[0]);
      if (method === "chats/capture") return capture(args);
      if (method === "chats/remove") {
        await assertAuthority();
        await store.delete(String(args[0]));
        return { ok: true };
      }
      return setCapture(args);
    },
    capture: (observation) => capture([observation]),
    status,
  });
}
