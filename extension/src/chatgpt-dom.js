const CONVERSATION_PATH = /^\/c\/([A-Za-z0-9_-]+)$/;
const TURN_SELECTOR = "[data-message-author-role]";
const COMPOSER_SELECTORS = Object.freeze([
  "textarea[data-testid='prompt-textarea']",
  "textarea#prompt-textarea",
  "[contenteditable='true'][data-testid='prompt-textarea']",
  "div.ProseMirror[contenteditable='true']",
]);

function text(value) {
  return String(value ?? "").trim();
}

function safeId(value, fallback) {
  const output = String(value ?? fallback).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 180);
  return output || fallback;
}

export function chatgptConversationId(locationValue = globalThis.location) {
  return locationValue?.pathname?.match(CONVERSATION_PATH)?.[1] ?? null;
}

export function chatgptCanonicalUrl(locationValue = globalThis.location) {
  if (!locationValue?.href) return null;
  const url = new URL(locationValue.href);
  url.search = "";
  url.hash = "";
  return url.href;
}

export function chatgptTurns(root = globalThis.document) {
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll(TURN_SELECTOR)].flatMap((node, index) => {
    const content = text(node.innerText || node.textContent);
    if (!content) return [];
    const role = text(node.getAttribute("data-message-author-role") || "unknown").toLowerCase();
    const container = node.closest("article, [data-testid^='conversation-turn']") || node;
    const id = safeId(
      container.getAttribute?.("data-message-id") || container.id,
      `rendered-${index + 1}`,
    );
    return [{ id, role, content, node: container }];
  });
}

export function chatgptSerializableTurns(root = globalThis.document) {
  return chatgptTurns(root).map(({ node: _node, ...turn }) => turn);
}

export function chatgptPageSnapshot({
  root = globalThis.document,
  locationValue = globalThis.location,
} = {}) {
  const turns = chatgptSerializableTurns(root);
  return Object.freeze({
    conversationId: chatgptConversationId(locationValue),
    url: chatgptCanonicalUrl(locationValue),
    title: text(root?.title).replace(/\s*[-–|]\s*ChatGPT\s*$/i, "").trim() || "ChatGPT",
    turns: Object.freeze(turns),
    assistantTurnIds: Object.freeze(turns.filter(({ role }) => role === "assistant").map(({ id }) => id)),
  });
}

export function findChatgptComposer(root = globalThis.document) {
  if (!root?.querySelector) return null;
  for (const selector of COMPOSER_SELECTORS) {
    const candidate = root.querySelector(selector);
    if (candidate) return candidate;
  }
  return null;
}

function setNativeValue(element, value) {
  const textareaType = globalThis.HTMLTextAreaElement;
  const inputType = globalThis.HTMLInputElement;
  const prototype = textareaType && element instanceof textareaType
    ? textareaType.prototype
    : inputType && element instanceof inputType
      ? inputType.prototype
      : null;
  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
}

export function setChatgptComposerText(value, root = globalThis.document) {
  const prompt = text(value);
  if (!prompt) throw new Error("The Greenways prompt is empty");
  const composer = findChatgptComposer(root);
  if (!composer) throw new Error("ChatGPT composer was not found");
  composer.focus();
  if ("value" in composer) {
    setNativeValue(composer, prompt);
  } else {
    composer.textContent = prompt;
  }
  composer.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    inputType: "insertText",
    data: prompt,
  }));
  composer.dispatchEvent(new Event("change", { bubbles: true }));
  return composer;
}

export function chatgptIsGenerating(root = globalThis.document) {
  if (!root?.querySelector) return false;
  return Boolean(root.querySelector(
    "button[data-testid='stop-button'], button[aria-label*='Stop generating' i], button[aria-label='Stop']",
  ));
}

export function newestAssistantAfter(baselineIds, root = globalThis.document) {
  const baseline = baselineIds instanceof Set ? baselineIds : new Set(baselineIds ?? []);
  const candidates = chatgptTurns(root).filter(({ role, id }) => role === "assistant" && !baseline.has(id));
  return candidates.at(-1) ?? null;
}
