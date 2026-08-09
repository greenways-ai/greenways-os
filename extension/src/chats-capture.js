(() => {
  const MESSAGE_TYPE = "greenways/chats-observation";
  const CONVERSATION_PATH = /^\/c\/([A-Za-z0-9_-]+)$/;
  let timer = null;
  let lastPayload = "";

  function canonicalUrl() {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    return url.href;
  }

  function observation() {
    const match = location.pathname.match(CONVERSATION_PATH);
    if (!match) return null;
    const candidates = [...document.querySelectorAll("[data-message-author-role]")];
    const messages = candidates.map((node, index) => {
      const role = node.getAttribute("data-message-author-role") || "unknown";
      const container = node.closest("article, [data-testid^='conversation-turn']") || node;
      const id = container.getAttribute("data-message-id") || container.id || `rendered-${index + 1}`;
      return {
        id: String(id).replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 180),
        parentId: index ? null : null,
        role,
        content: node.innerText || node.textContent || "",
        createdAt: new Date().toISOString(),
      };
    }).filter(({ content }) => content.trim());
    for (let index = 1; index < messages.length; index += 1) messages[index].parentId = messages[index - 1].id;
    if (!messages.length) return null;
    const now = new Date().toISOString();
    return {
      provider: "chatgpt",
      sourceId: match[1],
      source: "browser-observed",
      title: document.title.replace(/\s*[-–|]\s*ChatGPT\s*$/i, "").trim() || "ChatGPT conversation",
      url: canonicalUrl(),
      messages,
      activePath: messages.map(({ id }) => id),
      createdAt: now,
      updatedAt: now,
    };
  }

  function send() {
    timer = null;
    const value = observation();
    if (!value) return;
    const payload = JSON.stringify(value);
    if (payload === lastPayload) return;
    lastPayload = payload;
    chrome.runtime.sendMessage({ type: MESSAGE_TYPE, observation: value }, () => void chrome.runtime.lastError);
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(send, 800);
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  schedule();
})();
