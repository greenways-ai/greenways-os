import {
  chatgptIsGenerating,
  chatgptPageSnapshot,
  newestAssistantAfter,
  setChatgptComposerText,
} from "./chatgpt-dom.js";
import {
  CHATGPT_PROVIDER_MESSAGE_TYPE,
  CHATGPT_PROVIDER_PROTOCOL,
} from "./chatgpt-provider-protocol.js";

const MAX_PREVIEW = 900;
let session = null;
let baselineAssistantIds = new Set();
let candidate = null;
let phase = "idle";
let timer = null;
let lastUrl = location.href;
const shadowRoots = new WeakMap();

function request(operation, sessionId = null, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({
      type: CHATGPT_PROVIDER_MESSAGE_TYPE,
      protocol: CHATGPT_PROVIDER_PROTOCOL,
      operation,
      sessionId,
      payload,
    }, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response?.ok) reject(new Error(response?.error || "Greenways provider request failed"));
      else resolve(response);
    });
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function preview(value) {
  const text = String(value ?? "").trim();
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}…` : text;
}

function host() {
  let element = document.querySelector("[data-greenways-chatgpt-provider]");
  if (element && shadowRoots.has(element)) return element;
  element?.remove();
  element = document.createElement("div");
  element.dataset.greenwaysChatgptProvider = "true";
  element.style.position = "fixed";
  element.style.zIndex = "2147483647";
  element.style.inset = "auto 18px 18px auto";
  document.documentElement.append(element);
  shadowRoots.set(element, element.attachShadow({ mode: "closed" }));
  return element;
}

function removeHost() {
  document.querySelector("[data-greenways-chatgpt-provider]")?.remove();
}

function render(message = "") {
  if (!session) {
    removeHost();
    return;
  }
  const element = host();
  const root = shadowRoots.get(element);
  const ready = phase === "ready" && candidate;
  root.innerHTML = `<style>
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .card { width: min(380px, calc(100vw - 36px)); max-height: min(620px, calc(100vh - 36px)); overflow: auto; border: 1px solid rgba(34,75,57,.22); border-radius: 18px; background: #f4efe5; color: #173c2c; box-shadow: 0 22px 70px rgba(20,36,29,.26); font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: start; padding: 16px 18px 12px; border-bottom: 1px solid rgba(34,75,57,.15); background: #1c4c38; color: #fffdf7; border-radius: 17px 17px 0 0; }
    header p { margin: 0; font-size: 11px; letter-spacing: .12em; text-transform: uppercase; opacity: .72; }
    header strong { display: block; margin-top: 3px; font-size: 16px; }
    .body { padding: 16px 18px 18px; }
    .from { margin: 0 0 12px; color: #527060; font-size: 12px; }
    .prompt, .answer { margin: 0 0 14px; padding: 12px 13px; border: 1px solid rgba(34,75,57,.14); border-radius: 12px; background: rgba(255,255,255,.52); white-space: pre-wrap; overflow-wrap: anywhere; }
    .answer { max-height: 220px; overflow: auto; }
    .status { margin: 0 0 14px; color: #4f675b; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { appearance: none; border: 1px solid rgba(34,75,57,.28); border-radius: 999px; background: transparent; color: #173c2c; padding: 8px 12px; font: inherit; font-weight: 650; cursor: pointer; }
    button.primary { border-color: #1c4c38; background: #1c4c38; color: #fffdf7; }
    button.icon { padding: 2px 7px; border: 0; color: inherit; background: transparent; font-size: 20px; line-height: 1; }
    button:focus-visible { outline: 3px solid rgba(38,149,148,.38); outline-offset: 2px; }
    code { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #62776c; }
  </style><section class="card" aria-label="Greenways for ChatGPT">
    <header><div><p>Greenways provider</p><strong>${escapeHtml(session.title)}</strong></div><button class="icon" type="button" data-dismiss aria-label="Dismiss Greenways request">×</button></header>
    <div class="body">
      <p class="from">From ${escapeHtml(session.callerAppId)} · foreground request</p>
      <div class="prompt">${escapeHtml(preview(session.prompt))}</div>
      ${ready ? `<div class="answer">${escapeHtml(preview(candidate.content))}</div>` : ""}
      <p class="status" role="status">${escapeHtml(message || statusMessage())}</p>
      <div class="actions">
        ${phase === "review" ? '<button class="primary" type="button" data-place>Place in composer</button>' : ""}
        ${ready ? '<button class="primary" type="button" data-return>Use this response in Greenways</button>' : ""}
        <button type="button" data-dismiss>Cancel request</button>
      </div>
      <p><code>No ChatGPT cookies, tokens, or private network responses are read.</code></p>
    </div>
  </section>`;
  root.querySelector("[data-place]")?.addEventListener("click", placePrompt);
  root.querySelector("[data-return]")?.addEventListener("click", returnResponse);
  root.querySelectorAll("[data-dismiss]").forEach((button) => button.addEventListener("click", dismiss));
}

function statusMessage() {
  if (phase === "review") return "Review the prompt, then place it in ChatGPT. Greenways will not press Send.";
  if (phase === "staged") return "Prompt placed. Review it and press ChatGPT’s normal Send button.";
  if (phase === "generating") return "ChatGPT is responding. The answer remains on this page until you choose it.";
  if (phase === "ready") return "Review the answer, then explicitly return it to Greenways.";
  if (phase === "returned") return "Response returned to Greenways.";
  return "Greenways is connected.";
}

function stage(next) {
  if (!next?.id || typeof next.prompt !== "string") return;
  session = next;
  baselineAssistantIds = new Set(chatgptPageSnapshot().assistantTurnIds);
  candidate = null;
  phase = "review";
  render();
}

async function placePrompt(event) {
  if (!event?.isTrusted) return;
  try {
    setChatgptComposerText(session.prompt);
    phase = "staged";
    render();
    const snapshot = chatgptPageSnapshot();
    await request("staged", session.id, { conversationId: snapshot.conversationId });
    schedule();
  } catch (error) {
    render(error?.message || "The prompt could not be placed in ChatGPT.");
  }
}

async function detectResponse() {
  timer = null;
  if (!session || !new Set(["staged", "generating"]).has(phase)) return;
  if (chatgptIsGenerating()) {
    phase = "generating";
    render();
    schedule();
    return;
  }
  const turn = newestAssistantAfter(baselineAssistantIds);
  if (!turn) {
    schedule();
    return;
  }
  const snapshot = chatgptPageSnapshot();
  try {
    await request("ready", session.id, {
      conversationId: snapshot.conversationId,
      assistantMessageId: turn.id,
      output: turn.content,
    });
    candidate = turn;
    phase = "ready";
    render();
  } catch (error) {
    render(error?.message || "Greenways could not prepare this response.");
  }
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(detectResponse, 650);
}

async function returnResponse(event) {
  if (!event?.isTrusted || !candidate || !session) return;
  try {
    const snapshot = chatgptPageSnapshot();
    await request("returned", session.id, {
      conversationId: snapshot.conversationId,
      assistantMessageId: candidate.id,
      output: candidate.content,
    });
    phase = "returned";
    render();
    setTimeout(() => {
      session = null;
      candidate = null;
      render();
    }, 1600);
  } catch (error) {
    render(error?.message || "The response could not be returned to Greenways.");
  }
}

async function dismiss(event) {
  if (event && !event.isTrusted) return;
  const current = session;
  session = null;
  candidate = null;
  render();
  if (current) await request("dismissed", current.id, {
    conversationId: chatgptPageSnapshot().conversationId,
  }).catch(() => {});
}

async function hello() {
  const snapshot = chatgptPageSnapshot();
  const response = await request("hello", null, {
    conversationId: snapshot.conversationId,
    url: snapshot.url,
  });
  if (response.command?.operation === "stage") stage(response.command.session);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== CHATGPT_PROVIDER_MESSAGE_TYPE || message.protocol !== CHATGPT_PROVIDER_PROTOCOL) return false;
  if (message.operation === "stage") stage(message.session);
  if (message.operation === "clear" && (!message.sessionId || message.sessionId === session?.id)) {
    session = null;
    candidate = null;
    render();
  }
  sendResponse({ ok: true });
  return false;
});

new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    void hello().catch(() => {});
  }
  if (session && new Set(["staged", "generating"]).has(phase)) schedule();
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

void hello().catch(() => {});
