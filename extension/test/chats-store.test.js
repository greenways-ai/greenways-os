import assert from "node:assert/strict";
import test from "node:test";
import {
  createChatConversation,
  importChatGPTExport,
  searchChatConversations,
  validateChatConversation,
} from "../src/chats-store.js";

const now = "2026-08-09T00:00:00.000Z";

test("imports ChatGPT conversation graphs without flattening the active path", async () => {
  const records = await importChatGPTExport([{
    id: "conversation-1",
    title: "Tahto backup design",
    create_time: 1786233600,
    update_time: 1786233660,
    current_node: "assistant-1",
    mapping: {
      root: { id: "root", parent: null, message: null },
      "user-1": { id: "user-1", parent: "root", message: { author: { role: "user" }, create_time: 1786233600, content: { parts: ["How should backups work?"] } } },
      "assistant-1": { id: "assistant-1", parent: "user-1", message: { author: { role: "assistant" }, create_time: 1786233660, content: { parts: ["Use sealed objects."] } } },
    },
  }]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "chat/chatgpt/conversation-1");
  assert.deepEqual(records[0].activePath, ["user-1", "assistant-1"]);
  assert.match(records[0].digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(validateChatConversation(records[0]).messages.length, 2);
});

test("searches titles and message content locally", async () => {
  const record = await createChatConversation({
    provider: "chatgpt",
    sourceId: "searchable",
    source: "browser-observed",
    title: "Greenways architecture",
    url: "https://chatgpt.com/c/searchable?private=removed",
    messages: [{ id: "message-1", parentId: null, role: "assistant", content: "Tahto stores sealed backups.", createdAt: now }],
    activePath: ["message-1"],
    createdAt: now,
    updatedAt: now,
  });
  assert.equal(record.url, "https://chatgpt.com/c/searchable");
  assert.equal(searchChatConversations([record], "sealed Tahto")[0].id, record.id);
  assert.deepEqual(searchChatConversations([record], "missing"), []);
});

test("rejects cyclic, dangling, and credential-bearing records", async () => {
  const base = {
    provider: "chatgpt", sourceId: "invalid", source: "browser-observed", title: "Invalid",
    messages: [{ id: "one", parentId: "missing", role: "user", content: "hello", createdAt: now }],
    activePath: ["one"], createdAt: now, updatedAt: now,
  };
  await assert.rejects(createChatConversation(base), /dangling parent/);
  await assert.rejects(createChatConversation({ ...base, messages: [{ ...base.messages[0], parentId: null }], url: "https://owner:secret@chatgpt.com/c/invalid" }), /credential-free/);
});
