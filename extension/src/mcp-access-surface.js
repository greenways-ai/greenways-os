import { getAppManifest } from "./app-catalog.js";
import {
  MCP_ACCESS_APP_ID,
  MCP_ACCESS_CAPABILITY,
  MCP_ACCESS_ORIGIN,
  MCP_ACCESS_ORIGINS,
  MCP_PAIRING_SCOPE,
  MCP_READ_TOOLS,
} from "./mcp-access-protocol.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function grantId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `grant/mcp-access-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function createMcpAccessSurface({ root, close, session }) {
  let active = true;
  let busy = false;
  let granted = false;
  let status = null;
  let notice = "";

  function render() {
    if (!active) return;
    const controller = status?.controller;
    const tools = MCP_READ_TOOLS.map((tool) => `<li><code>${escapeHtml(tool)}</code></li>`).join("");
    root.innerHTML = `<section class="chats-surface" aria-label="Greenways MCP Access">
      <header><div><p>REMOTE MCP CONSENT</p><h1>Greenways MCP Access</h1></div><button type="button" data-close-surface aria-label="Close Greenways MCP Access">×</button></header>
      <div class="chats-body">
        <p class="chats-intro">Approve a read-only ChatGPT or MCP connection with your local Greenways identity. The remote gateway receives a revocable connection ID, never your controller key.</p>
        ${!granted ? `<div class="chats-authority"><p>This reviewed adapter requires an active <code>${MCP_ACCESS_CAPABILITY}</code> grant for the exact installed app version.</p><button type="button" data-grant-mcp${busy ? " disabled" : ""}>Grant MCP pairing access</button></div>` : ""}
        <div class="chats-toolbar">
          <button type="button" data-toggle-mcp${!granted || busy ? " disabled" : ""}>${status?.enabled ? "Disable authorization adapter" : "Enable authorization adapter"}</button>
          <span>${status?.originAccess ? "Gateway page access approved" : "Gateway page access off"}</span>
        </div>
        <div class="chats-authority">
          <p><strong>Controller</strong><br>${controller ? `@${escapeHtml(controller.handle)} · ${escapeHtml(controller.algorithm)}` : "Create a controller identity in Keyring before approving MCP connections."}</p>
          <p><strong>Remote boundary</strong><br><code>${MCP_ACCESS_ORIGIN}</code> · scope <code>${MCP_PAIRING_SCOPE}</code></p>
          <details><summary>Exact read tools</summary><ul>${tools}</ul></details>
        </div>
        ${notice ? `<p class="chats-notice" role="status">${escapeHtml(notice)}</p>` : ""}
        <p class="chats-intro">On an authorization page, Greenways adds a separate Approve with Greenways OS button. It fills the signed assertion only after your click and never presses the page’s final Authorize button.</p>
      </div>
    </section>`;
    root.querySelector("[data-close-surface]").addEventListener("click", close);
    root.querySelector("[data-grant-mcp]")?.addEventListener("click", grant);
    root.querySelector("[data-toggle-mcp]")?.addEventListener("click", toggle);
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
      notice = error?.message || "The MCP access request failed.";
    } finally {
      busy = false;
      render();
    }
  }

  async function grant() {
    await run(() => session.dispatch("capabilities/grant", [{
      id: grantId(),
      appId: MCP_ACCESS_APP_ID,
      capability: MCP_ACCESS_CAPABILITY,
      constraints: {
        origin: MCP_ACCESS_ORIGIN,
        scope: MCP_PAIRING_SCOPE,
        tools: MCP_READ_TOOLS,
        interaction: "explicit-user-approval",
      },
    }]), "Greenways MCP Access can now approve exact read-only pairing challenges.");
  }

  async function toggle() {
    await run(async () => {
      if (!status?.enabled) {
        const allowed = await chrome.permissions.request({ origins: MCP_ACCESS_ORIGINS });
        if (!allowed) throw new Error("MCP authorization page access was not granted");
        await session.call("mcp-access/set-enabled", [true]);
      } else {
        await session.call("mcp-access/set-enabled", [false]);
      }
    }, status?.enabled ? "MCP authorization adapter disabled." : "MCP authorization adapter enabled.");
  }

  async function refresh() {
    const [statusValue, grantValue] = await Promise.all([
      session.call("mcp-access/status"),
      session.call("capabilities/check", [MCP_ACCESS_APP_ID, MCP_ACCESS_CAPABILITY]).catch(() => null),
    ]);
    status = statusValue;
    granted = Boolean(grantValue);
  }

  async function sync() {
    try {
      await refresh();
    } catch (error) {
      notice = error?.message || "Greenways MCP Access could not refresh.";
    }
    render();
  }

  if (!getAppManifest(MCP_ACCESS_APP_ID)) throw new Error("Greenways MCP Access is not part of this build");
  render();
  void sync();
  return {
    update() { void sync(); },
    destroy() { active = false; },
  };
}
