import assert from "node:assert/strict";
import test from "node:test";
import {
  chatgptCanonicalUrl,
  chatgptConversationId,
  chatgptPageSnapshot,
} from "../src/chatgpt-dom.js";

function turn(role, content, id) {
  const container = {
    id,
    getAttribute(name) { return name === "data-message-id" ? id : null; },
  };
  return {
    innerText: content,
    textContent: content,
    getAttribute(name) { return name === "data-message-author-role" ? role : null; },
    closest() { return container; },
  };
}

test("projects only visible ChatGPT conversation data", () => {
  const locationValue = {
    href: "https://chatgpt.com/c/conversation-1?temporary-chat=true#latest",
    pathname: "/c/conversation-1",
  };
  const root = {
    title: "Example – ChatGPT",
    querySelectorAll() {
      return [turn("user", "Hello", "user-1"), turn("assistant", "Hi", "assistant-1")];
    },
  };
  assert.equal(chatgptConversationId(locationValue), "conversation-1");
  assert.equal(chatgptCanonicalUrl(locationValue), "https://chatgpt.com/c/conversation-1");
  assert.deepEqual(chatgptPageSnapshot({ root, locationValue }), {
    conversationId: "conversation-1",
    url: "https://chatgpt.com/c/conversation-1",
    title: "Example",
    turns: [
      { id: "user-1", role: "user", content: "Hello" },
      { id: "assistant-1", role: "assistant", content: "Hi" },
    ],
    assistantTurnIds: ["assistant-1"],
  });
});
