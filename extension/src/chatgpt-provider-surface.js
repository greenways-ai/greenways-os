import { getAppManifest } from "./app-catalog.js";
import {
  CHATGPT_PROVIDER_APP_ID,
  CHATGPT_PROVIDER_CAPABILITY,
  CHATGPT_PROVIDER_ID,
  CHATGPT_PROVIDER_ORIGINS,
} from "./chatgpt-provider-protocol.js";

const ACTIVE_STATES = new Set(["created", "attached", "staged", "ready"]);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function grantId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `grant/chatgpt-provider-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function stateLabel(state) {
  return ({
    created: "Opening ChatGPT",
    attached: "Ready for review",
    staged: "Waiting for you to send",
    ready: "Response ready",
    returned: "Returned to Greenways",
    cancelled: "Cancelled",
    expired: "Expired",
  })[state] ?? state;
}

export function createChatgptProviderSurface({ root, close, session }) {
  let active = true;
  let busy = false;
  let syncing = false;
  let granted = false;
  let status = null;
  let sessions = [];
  let notice = "";

  function render() {
    if (!active) return;
    const cards = sessions.map((record) => `<article class="chat-card">
      <div><strong>${escapeHtml(record.request.title)}</strong><small>${escapeHtml(stateLabel(record.state))} · ${escapeHtml(new Date(record.updatedAt).toLocaleString())}</small></div>
      <p>${escapeHtml(record.output || record.request.prompt)}</p>
      ${ACTIVE_STATES.has(record.state)
        ? `<button type="button" data-cancel-session="${escapeHtml(record.id)}"${busy ? " disabled" : ""}>Cancel</button>`
        : ""}
    </article>`).join("");
    root.innerHTML = `<section class="chats-surface" aria-label="Greenways for ChatGPT">
      <header><div><p>FOREGROUND WEBAPP PROVIDER</p><h1>Greenways for ChatGPT</h1></div><button type="button" data-close-surface aria-label="Close Greenways for ChatGPT">×</button></header>
      <div class="chats-body">
        <p class="chats-intro">Use the visible ChatGPT web application as an interactive Greenways model provider. Greenways can place a reviewed prompt, but it never presses Send and returns an answer only after you explicitly select it.</p>
        ${!granted ? `<div class="chats-authority"><p>This reviewed adapter requires an active <code>${CHATGPT_PROVIDER_CAPABILITY}</code> grant for the exact installed app version.</p><button type="button" data-grant-provider${busy ? " disabled" : ""}>Grant foreground provider access</button></div>` : ""}
        <div class="chats-toolbar">
          <button type="button" data-toggle-provider${!granted || busy ? " disabled" : ""}>${status?.enabled ? "Disable ChatGPT adapter" : "Enable ChatGPT adapter"}</button>
          <span>${status?.originAccess ? "ChatGPT page access approved" : "ChatGPT page access off"}</span>
        </div>
        <form data-provider-request class="chats-authority">
          <label>Request title<input name="title" maxlength="160" value="Greenways request"${!status?.enabled || busy ? " disabled" : ""}></label>
          <label>Prompt<textarea name="prompt" rows="7" maxlength="65536" placeholder="Ask ChatGPT to help with this Greenways task…" required${!status?.enabled || busy ? " disabled" : ""}></textarea></label>
          <button type="submit"${!status?.enabled || busy ? " disabled" : ""}>Open in ChatGPT</button>
        </form>
        <p class="chats-summary">Provider <code>${CHATGPT_PROVIDER_ID}</code> · ${status?.activeSessions ?? 0} active · ${status?.returnedSessions ?? 0} returned</p>
        ${notice ? `<p class="chats-notice" role="status">${escapeHtml(notice)}</p>` : ""}
        <div class="chat-list">${cards || "<p>No foreground model sessions yet.</p>"}</div>
        <p class="chats-intro">The page adapter does not read ChatGPT cookies, tokens, local storage credentials, billing data, or private network responses. API providers remain the route for unattended execution.</p>
      </div>
    </section>`;
    root.querySelector("[data-close-surface]").addEventListener("click", close);
    root.querySelector("[data-grant-provider]")?.addEventListener("click", grant);
    root.querySelector("[data-toggle-provider]")?.addEventListener("click", toggle);
    root.querySelector("[data-provider-request]")?.addEventListener("submit", createRequest);
    root.querySelectorAll("[data-cancel-session]").forEach((button) => (
      button.addEventListener("click", () => cancel(button.dataset.cancelSession))
    ));
  }

  async function run(operation, success) {
    busy = true;
    notice = "";
    render();
    try {
      await operation();
      await refresh();
      notice = success;
    } catch (error) {
      notice = error?.message || "The ChatGPT provider request failed.";
    } finally {
      busy = false;
      render();
    }
  }

  async function grant() {
    await run(() => session.dispatch("capabilities/grant", [{
      id: grantId(),
      appId: CHATGPT_PROVIDER_APP_ID,
      capability: CHATGPT_PROVIDER_CAPABILITY,
      constraints: {
        provider: CHATGPT_PROVIDER_ID,
        origins: CHATGPT_PROVIDER_ORIGINS,
        interaction: "foreground",
      },
    }]), "Greenways for ChatGPT can now manage foreground model sessions.");
  }

  async function toggle() {
    await run(async () => {
      if (!status?.enabled) {
        const allowed = await chrome.permissions.request({ origins: CHATGPT_PROVIDER_ORIGINS });
        if (!allowed) throw new Error("ChatGPT page access was not granted");
        await session.call("chatgpt-provider/set-enabled", [true]);
      } else {
        await session.call("chatgpt-provider/set-enabled", [false]);
      }
    }, status?.enabled ? "ChatGPT adapter disabled." : "ChatGPT adapter enabled for foreground requests.");
  }

  async function createRequest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const prompt = String(data.get("prompt") ?? "").trim();
    const title = String(data.get("title") ?? "").trim();
    if (!prompt) return;
    await run(async () => {
      await session.call("chatgpt-provider/create", [{
        prompt,
        title,
        callerAppId: CHATGPT_PROVIDER_APP_ID,
      }]);
      form.reset();
    }, "Request opened in ChatGPT. Review the in-page Greenways card before placing the prompt.");
  }

  async function cancel(id) {
    await run(() => session.call("chatgpt-provider/cancel", [id]), "Foreground model session cancelled.");
  }

  async function refresh() {
    const [statusValue, listValue, grantValue] = await Promise.all([
      session.call("chatgpt-provider/status"),
      session.call("chatgpt-provider/list").catch(() => ({ sessions: [] })),
      session.call("capabilities/check", [CHATGPT_PROVIDER_APP_ID, CHATGPT_PROVIDER_CAPABILITY]).catch(() => null),
    ]);
    status = statusValue;
    sessions = listValue?.sessions ?? [];
    granted = Boolean(grantValue);
  }

  async function sync() {
    if (!active || busy || syncing) return;
    syncing = true;
    try {
      await refresh();
      render();
    } catch (error) {
      notice = error?.message || "Greenways for ChatGPT could not refresh.";
      render();
    } finally {
      syncing = false;
    }
  }

  if (!getAppManifest(CHATGPT_PROVIDER_APP_ID)) throw new Error("Greenways for ChatGPT is not part of this build");
  render();
  void sync();
  return {
    update() { void sync(); },
    destroy() { active = false; },
  };
}
