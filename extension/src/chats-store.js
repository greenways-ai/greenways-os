import { canonical, sha256 } from "./protocol.js";

export const CHATS_APP_ID = "chats";
export const CHATS_CAPABILITY = "chats/capture";
export const CHAT_CONVERSATION_PROTOCOL = "greenways-chat-conversation/0-alpha";
export const CHAT_PROVIDER = "chatgpt";
export const CHATGPT_ORIGINS = Object.freeze([
  "https://chatgpt.com/*",
  "https://www.chatgpt.com/*",
  "https://chat.openai.com/*",
]);
export const CHAT_LIMITS = Object.freeze({
  conversations: 10_000,
  messages: 4_096,
  contentBytes: 2 * 1024 * 1024,
  titleCharacters: 500,
});

const encoder = new TextEncoder();
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ID_PART = /^[A-Za-z0-9._:-]{1,180}$/;
const ROLES = new Set(["user", "assistant", "system", "tool", "unknown"]);
const SOURCES = new Set(["official-export", "browser-observed"]);

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  for (const key of Object.keys(plainObject(value, label))) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function string(value, label, maximum = 4096, { empty = false } = {}) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!empty && !output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function identifier(value, label) {
  const output = string(value, label, 180);
  if (!ID_PART.test(output)) throw new Error(`${label} is invalid`);
  return output;
}

function canonicalTime(value, label) {
  const output = string(value, label, 80);
  if (!Number.isFinite(Date.parse(output)) || new Date(output).toISOString() !== output) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return output;
}

function optionalUrl(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new URL(string(value, label, 2048));
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.href;
}

function normalizeMessage(value, index) {
  const label = `Chat message ${index}`;
  const input = plainObject(value, label);
  closedKeys(input, new Set(["id", "parentId", "role", "content", "createdAt"]), label);
  const role = string(input.role ?? "unknown", `${label} role`, 20).toLowerCase();
  if (!ROLES.has(role)) throw new Error(`${label} role is unsupported`);
  const content = string(input.content ?? "", `${label} content`, CHAT_LIMITS.contentBytes, { empty: true });
  if (encoder.encode(content).byteLength > CHAT_LIMITS.contentBytes) throw new Error(`${label} content is too large`);
  return Object.freeze({
    id: identifier(input.id, `${label} id`),
    parentId: input.parentId === null || input.parentId === undefined ? null : identifier(input.parentId, `${label} parent id`),
    role,
    content,
    createdAt: canonicalTime(input.createdAt, `${label} createdAt`),
  });
}

function conversationBody(value, label = "Chat conversation") {
  const input = plainObject(value, label);
  const provider = string(input.provider, `${label} provider`, 40).toLowerCase();
  if (provider !== CHAT_PROVIDER) throw new Error(`${label} provider is unsupported`);
  const source = string(input.source, `${label} source`, 40);
  if (!SOURCES.has(source)) throw new Error(`${label} source is unsupported`);
  if (!Array.isArray(input.messages) || !input.messages.length) throw new Error(`${label} must contain messages`);
  if (input.messages.length > CHAT_LIMITS.messages) throw new Error(`${label} contains too many messages`);
  const messages = input.messages.map(normalizeMessage);
  const ids = messages.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} contains duplicate message ids`);
  const idSet = new Set(ids);
  for (const message of messages) {
    if (message.parentId !== null && !idSet.has(message.parentId)) throw new Error(`${label} contains a dangling parent`);
  }
  const seen = new Set();
  const visiting = new Set();
  const byId = new Map(messages.map((message) => [message.id, message]));
  const visit = (id) => {
    if (seen.has(id)) return;
    if (visiting.has(id)) throw new Error(`${label} contains a message cycle`);
    visiting.add(id);
    const parent = byId.get(id)?.parentId;
    if (parent) visit(parent);
    visiting.delete(id);
    seen.add(id);
  };
  for (const id of ids) visit(id);
  const activePath = Array.isArray(input.activePath) ? input.activePath.map((id, index) => identifier(id, `${label} active path ${index}`)) : [];
  if (activePath.some((id) => !idSet.has(id)) || new Set(activePath).size !== activePath.length) {
    throw new Error(`${label} active path is invalid`);
  }
  return {
    protocol: CHAT_CONVERSATION_PROTOCOL,
    id: `chat/${provider}/${identifier(input.sourceId, `${label} source id`)}`,
    provider,
    sourceId: identifier(input.sourceId, `${label} source id`),
    source,
    title: string(input.title || "Untitled chat", `${label} title`, CHAT_LIMITS.titleCharacters),
    url: optionalUrl(input.url, `${label} URL`),
    messages: Object.freeze(messages),
    activePath: Object.freeze(activePath),
    createdAt: canonicalTime(input.createdAt, `${label} createdAt`),
    updatedAt: canonicalTime(input.updatedAt, `${label} updatedAt`),
  };
}

export async function createChatConversation(value) {
  const body = conversationBody(value);
  if (body.updatedAt < body.createdAt) throw new Error("Chat conversation update cannot precede creation");
  return Object.freeze({ ...body, digest: await sha256(canonical(body)) });
}

export function validateChatConversation(value) {
  const input = plainObject(value, "Chat conversation");
  closedKeys(input, new Set([
    "protocol", "id", "provider", "sourceId", "source", "title", "url",
    "messages", "activePath", "createdAt", "updatedAt", "digest",
  ]), "Chat conversation");
  if (input.protocol !== CHAT_CONVERSATION_PROTOCOL) throw new Error(`Chat conversation protocol must be ${CHAT_CONVERSATION_PROTOCOL}`);
  const body = conversationBody(input);
  if (input.id !== body.id) throw new Error("Chat conversation id does not match its source identity");
  if (!SHA256.test(input.digest)) throw new Error("Chat conversation digest is invalid");
  return Object.freeze({ ...body, digest: input.digest });
}

function isoTime(seconds, fallback) {
  const value = Number(seconds);
  return Number.isFinite(value) ? new Date(value * 1000).toISOString() : fallback;
}

function messageText(message) {
  const parts = message?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => typeof part === "string" ? part : part?.text ?? "").filter(Boolean).join("\n");
}

export async function importChatGPTExport(value, { now = () => new Date() } = {}) {
  const conversations = Array.isArray(value) ? value : plainObject(value, "ChatGPT export").conversations;
  if (!Array.isArray(conversations)) throw new TypeError("ChatGPT export must be an array of conversations");
  if (conversations.length > CHAT_LIMITS.conversations) throw new Error("ChatGPT export contains too many conversations");
  const fallback = now().toISOString();
  const output = [];
  for (const [conversationIndex, conversationValue] of conversations.entries()) {
    const conversation = plainObject(conversationValue, `ChatGPT conversation ${conversationIndex}`);
    const sourceId = identifier(String(conversation.id ?? conversation.conversation_id ?? `export-${conversationIndex}`), "ChatGPT conversation id");
    const mapping = plainObject(conversation.mapping ?? {}, `ChatGPT conversation ${sourceId} mapping`);
    const messages = [];
    for (const [nodeId, nodeValue] of Object.entries(mapping)) {
      const node = plainObject(nodeValue, `ChatGPT node ${nodeId}`);
      if (!node.message) continue;
      const content = messageText(node.message);
      if (!content.trim()) continue;
      messages.push({
        id: identifier(String(node.id ?? nodeId), "ChatGPT message id"),
        parentId: node.parent && mapping[node.parent]?.message ? String(node.parent) : null,
        role: String(node.message.author?.role ?? "unknown"),
        content,
        createdAt: isoTime(node.message.create_time ?? conversation.create_time, fallback),
      });
    }
    if (!messages.length) continue;
    const messageIds = new Set(messages.map(({ id }) => id));
    const activePath = [];
    let cursor = conversation.current_node;
    const visited = new Set();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      if (messageIds.has(String(cursor))) activePath.unshift(String(cursor));
      cursor = mapping[cursor]?.parent;
    }
    output.push(await createChatConversation({
      provider: CHAT_PROVIDER,
      sourceId,
      source: "official-export",
      title: String(conversation.title ?? "Untitled chat"),
      url: `https://chatgpt.com/c/${sourceId}`,
      messages,
      activePath,
      createdAt: isoTime(conversation.create_time, messages[0].createdAt),
      updatedAt: isoTime(conversation.update_time, messages.at(-1).createdAt),
    }));
  }
  return Object.freeze(output);
}

export function searchChatConversations(records, query) {
  const terms = string(query, "Chat search query", 500).toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return records.map(validateChatConversation).flatMap((record) => {
    const haystack = `${record.title}\n${record.messages.map(({ content }) => content).join("\n")}`.toLocaleLowerCase();
    if (!terms.every((term) => haystack.includes(term))) return [];
    const message = record.messages.find(({ content }) => terms.some((term) => content.toLocaleLowerCase().includes(term)));
    return [{
      id: record.id,
      title: record.title,
      provider: record.provider,
      updatedAt: record.updatedAt,
      excerpt: (message?.content ?? record.title).slice(0, 320),
    }];
  }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
