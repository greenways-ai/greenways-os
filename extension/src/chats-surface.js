import { unzipSync, strFromU8 } from "fflate";
import { getAppManifest } from "./app-catalog.js";
import {
  CHATS_APP_ID,
  CHATS_CAPABILITY,
  CHATGPT_ORIGINS,
  importChatGPTExport,
} from "./chats-store.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function grantId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `grant/chats-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function readExport(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.toLowerCase().endsWith(".zip")) {
    const files = unzipSync(bytes);
    const path = Object.keys(files).find((name) => /(^|\/)conversations\.json$/i.test(name));
    if (!path) throw new Error("The ZIP does not contain conversations.json");
    return JSON.parse(strFromU8(files[path]));
  }
  return JSON.parse(strFromU8(bytes));
}

export function createChatsSurface({ root, close, session }) {
  let active = true;
  let busy = false;
  let granted = false;
  let status = null;
  let conversations = [];
  let results = [];
  let notice = "";

  function render() {
    if (!active) return;
    const cards = (results.length ? results : conversations.map((record) => ({
      id: record.id,
      title: record.title,
      updatedAt: record.updatedAt,
      excerpt: record.messages.at(-1)?.content ?? "",
    }))).map((record) => `<article class="chat-card">
      <div><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(new Date(record.updatedAt).toLocaleString())}</small></div>
      <p>${escapeHtml(record.excerpt || "No text preview")}</p>
      <button type="button" data-remove-chat="${escapeHtml(record.id)}"${!granted || busy ? " disabled" : ""}>Remove</button>
    </article>`).join("");
    root.innerHTML = `<section class="chats-surface" aria-label="Chats">
      <header><div><p>PRIVATE AI CONVERSATION ARCHIVE</p><h1>Chats</h1></div><button type="button" data-close-surface aria-label="Close Chats">×</button></header>
      <div class="chats-body">
        <p class="chats-intro">Import your official ChatGPT export, search locally, and optionally keep conversations current as you view them. Conversation content stays in this browser unless you explicitly enrol a Tahto backup.</p>
        ${!granted ? `<div class="chats-authority"><p>Import and page capture require an active <code>${CHATS_CAPABILITY}</code> grant for this exact Chats version.</p><button type="button" data-grant-chats${busy ? " disabled" : ""}>Grant local archive access</button></div>` : ""}
        <div class="chats-toolbar">
          <form data-chat-search><input name="query" type="search" placeholder="Search every imported conversation" aria-label="Search chats"><button type="submit">Search</button></form>
          <label class="chats-import">Import ChatGPT export<input type="file" data-chat-import accept=".zip,.json,application/zip,application/json"${!granted || busy ? " disabled" : ""}></label>
          <button type="button" data-toggle-capture${!granted || busy ? " disabled" : ""}>${status?.capturing ? "Pause automatic capture" : "Enable automatic capture"}</button>
        </div>
        <p class="chats-summary">${conversations.length} conversation${conversations.length === 1 ? "" : "s"} · ChatGPT${status?.capturing ? " · automatic capture active" : ""}</p>
        ${notice ? `<p class="chats-notice" role="status">${escapeHtml(notice)}</p>` : ""}
        <div class="chat-list">${cards || "<p>No conversations yet. Import an official export or enable capture, then open a ChatGPT conversation.</p>"}</div>
      </div>
    </section>`;
    root.querySelector("[data-close-surface]").addEventListener("click", close);
    root.querySelector("[data-grant-chats]")?.addEventListener("click", grant);
    root.querySelector("[data-chat-import]")?.addEventListener("change", importFile);
    root.querySelector("[data-toggle-capture]")?.addEventListener("click", toggleCapture);
    root.querySelector("[data-chat-search]")?.addEventListener("submit", search);
    root.querySelectorAll("[data-remove-chat]").forEach((button) => button.addEventListener("click", () => remove(button.dataset.removeChat)));
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
      notice = error?.message || "The Chats request failed.";
    } finally {
      busy = false;
      render();
    }
  }

  async function grant() {
    await run(() => session.dispatch("capabilities/grant", [{
      id: grantId(),
      appId: CHATS_APP_ID,
      capability: CHATS_CAPABILITY,
      constraints: { providers: ["chatgpt"] },
    }]), "Chats can now manage its local archive.");
  }

  async function importFile(event) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    await run(async () => {
      const records = await importChatGPTExport(await readExport(file));
      await session.call("chats/import", [records]);
    }, "ChatGPT export imported and indexed locally.");
  }

  async function toggleCapture() {
    await run(async () => {
      if (!status?.capturing) {
        const allowed = await chrome.permissions.request({ origins: CHATGPT_ORIGINS });
        if (!allowed) throw new Error("ChatGPT page access was not granted");
      }
      await session.call("chats/set-capture", [!status?.capturing]);
      if (status?.capturing) await chrome.permissions.remove({ origins: CHATGPT_ORIGINS });
    }, status?.capturing ? "Automatic capture paused." : "Automatic ChatGPT capture enabled.");
  }

  async function search(event) {
    event.preventDefault();
    const query = String(new FormData(event.currentTarget).get("query") ?? "").trim();
    if (!query) {
      results = [];
      render();
      return;
    }
    try {
      results = (await session.call("chats/search", [query]))?.results ?? [];
      notice = `${results.length} matching conversation${results.length === 1 ? "" : "s"}.`;
    } catch (error) {
      notice = error?.message || "Search failed.";
    }
    render();
  }

  async function remove(id) {
    await run(() => session.call("chats/remove", [id]), "Conversation removed from the local archive.");
  }

  async function refresh() {
    const [statusValue, listValue, grantValue] = await Promise.all([
      session.call("chats/status"),
      session.call("chats/list"),
      session.call("capabilities/check", [CHATS_APP_ID, CHATS_CAPABILITY]).catch(() => null),
    ]);
    status = statusValue;
    conversations = listValue?.conversations ?? [];
    granted = Boolean(grantValue);
  }

  if (!getAppManifest(CHATS_APP_ID)) throw new Error("Chats is not part of this build");
  refresh().catch((error) => { notice = error?.message || "Chats could not start."; render(); });
  render();
  return { update() {}, destroy() { active = false; } };
}
