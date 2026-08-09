import assert from "node:assert/strict";
import test from "node:test";
import { createChatsRuntime } from "../src/chats-runtime.js";
import { createChatConversation } from "../src/chats-store.js";

function memoryStore() {
  const records = new Map();
  return {
    get: async (id) => records.get(id),
    put: async (record) => records.set(record.id, record),
    delete: async (id) => records.delete(id),
    values: async () => [...records.values()],
  };
}

test("imports, searches, and captures idempotently behind authority", async () => {
  let checks = 0;
  const runtime = createChatsRuntime({ store: memoryStore(), assertAuthority: async () => { checks += 1; } });
  const draft = {
    provider: "chatgpt", sourceId: "one", source: "browser-observed", title: "One",
    messages: [{ id: "m1", parentId: null, role: "user", content: "Greenways", createdAt: "2026-08-09T00:00:00.000Z" }],
    activePath: ["m1"], createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
  };
  const record = await createChatConversation(draft);
  assert.equal((await runtime.call("chats/import", [[record]])).imported, 1);
  assert.equal((await runtime.call("chats/search", ["Greenways"])).results.length, 1);
  assert.equal((await runtime.capture(draft)).changed, false);
  assert.equal(checks, 2);
});

test("registers only the reviewed ChatGPT capture script", async () => {
  let registered = [];
  const scripting = {
    getRegisteredContentScripts: async () => registered,
    unregisterContentScripts: async () => { registered = []; },
    registerContentScripts: async (records) => { registered = records; },
  };
  const runtime = createChatsRuntime({ store: memoryStore(), scripting });
  const status = await runtime.call("chats/set-capture", [true]);
  assert.equal(status.capturing, true);
  assert.deepEqual(registered[0].matches, ["https://chatgpt.com/*", "https://www.chatgpt.com/*", "https://chat.openai.com/*"]);
  assert.deepEqual(registered[0].js, ["src/chats-capture.js"]);
});
