import { USERSCRIPTS_APP_ID, USERSCRIPTS_CAPABILITY } from "./userscripts-store.js";

const RUN_AT_OPTIONS = [
  ["document_start", "Document start"],
  ["document_end", "Document end"],
  ["document_idle", "Document idle"],
];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function grantId() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(8));
  return `grant/userscripts-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function shortDigest(digest) {
  return typeof digest === "string" && digest.startsWith("sha256:") ? digest.slice(7, 19) : "—";
}

/**
 * Management surface for the bundled Userscripts app. Runs inside the
 * launcher page; every mutation goes through the kernel and requires an
 * active userscripts/manage grant for the installed app.
 */
export function createUserscriptsSurface({ root, close, session }) {
  let active = true;
  let scripts = [];
  let scriptStatus = null;
  let granted = false;
  let notice = "";
  let busy = false;
  let editing = null;

  function render() {
    if (!active) return;
    if (!session) {
      root.innerHTML = `<section class="userscripts-surface" aria-label="Userscripts">
        <header><div><p>USERSCRIPT RUNNER</p><h1>Userscripts</h1></div><button type="button" data-close-surface aria-label="Close Userscripts">×</button></header>
        <div class="userscripts-body"><p class="userscripts-notice">The local kernel session is unavailable.</p></div>
      </section>`;
      root.querySelector("[data-close-surface]").addEventListener("click", close);
      return;
    }

    const availability = scriptStatus && !scriptStatus.available
      ? `<p class="userscripts-notice userscripts-notice--warn">Chrome user scripts are off. Enable <strong>Allow User Scripts</strong> for Greenways OS in <code>chrome://extensions</code> (developer mode) so registered scripts can run.${scriptStatus.reason ? `<br><small>${escapeHtml(scriptStatus.reason)}</small>` : ""}</p>`
      : "";

    const authority = !granted
      ? `<div class="userscripts-authority">
          <p>Script management is consent-gated. Grant <code>${escapeHtml(USERSCRIPTS_CAPABILITY)}</code> to this exact app version to create, edit, enable, or remove scripts.</p>
          <button type="button" data-grant${busy ? " disabled" : ""}>Grant ${escapeHtml(USERSCRIPTS_CAPABILITY)}</button>
        </div>`
      : "";

    const list = scripts.length
      ? scripts.map((record) => `<article class="userscript-card" data-script-card="${escapeHtml(record.id)}">
          <div class="userscript-card-head">
            <strong>${escapeHtml(record.name)}</strong>
            <label class="userscript-toggle">
              <input type="checkbox" data-toggle-script="${escapeHtml(record.id)}"${record.enabled ? " checked" : ""}${busy || !granted ? " disabled" : ""}>
              <span>${record.enabled ? "Enabled" : "Disabled"}</span>
            </label>
          </div>
          <p class="userscript-meta">${escapeHtml(record.runAt.replace("_", " "))} · sha256 ${escapeHtml(shortDigest(record.digest))}</p>
          <ul class="userscript-matches">${record.matches.map((match) => `<li>${escapeHtml(match)}</li>`).join("")}</ul>
          <div class="userscript-actions">
            <button type="button" data-edit-script="${escapeHtml(record.id)}"${busy || !granted ? " disabled" : ""}>Edit</button>
            <button type="button" data-remove-script="${escapeHtml(record.id)}"${busy || !granted ? " disabled" : ""}>Remove</button>
          </div>
        </article>`).join("")
      : `<p class="userscripts-empty">No userscripts yet. Scripts you write stay in this browser profile and run in an isolated world.</p>`;

    const editor = editing ? `<form class="userscripts-form" data-editor>
        <h2>${editing.id ? "Edit script" : "New script"}</h2>
        <label>Name
          <input name="name" required maxlength="120" value="${escapeHtml(editing.name ?? "")}" placeholder="My page tweak">
        </label>
        <label>Match patterns (one per line)
          <textarea name="matches" required rows="3" placeholder="https://example.com/*">${escapeHtml((editing.matches ?? []).join("\n"))}</textarea>
        </label>
        <label>Run at
          <select name="runAt">${RUN_AT_OPTIONS.map(([value, label]) => `<option value="${value}"${(editing.runAt ?? "document_idle") === value ? " selected" : ""}>${label}</option>`).join("")}</select>
        </label>
        <label>Source
          <textarea name="source" required rows="10" spellcheck="false" placeholder="// Runs in an isolated world on matching pages&#10;console.log('hello from a userscript');">${escapeHtml(editing.source ?? "")}</textarea>
        </label>
        <label class="userscript-enabled-check">
          <input type="checkbox" name="enabled"${editing.enabled ? " checked" : ""}>
          <span>Enable after saving</span>
        </label>
        <div class="userscript-actions">
          <button type="submit"${busy ? " disabled" : ""}>Save script</button>
          <button type="button" data-cancel-edit${busy ? " disabled" : ""}>Cancel</button>
        </div>
      </form>` : "";

    root.innerHTML = `<section class="userscripts-surface" aria-label="Userscripts">
      <header><div><p>USERSCRIPT RUNNER</p><h1>Userscripts</h1></div><button type="button" data-close-surface aria-label="Close Userscripts">×</button></header>
      <div class="userscripts-body">
        ${availability}
        ${authority}
        ${editing ? editor : `
          <div class="userscripts-toolbar">
            <span>${scripts.length} script${scripts.length === 1 ? "" : "s"}${scriptStatus ? ` · ${scriptStatus.enabled} enabled` : ""}</span>
            <button type="button" data-new-script${busy || !granted ? " disabled" : ""}>New script</button>
          </div>
          <div class="userscript-list">${list}</div>`}
        ${notice ? `<p class="userscripts-notice" role="status">${escapeHtml(notice)}</p>` : ""}
      </div>
    </section>`;

    root.querySelector("[data-close-surface]").addEventListener("click", close);
    root.querySelector("[data-grant]")?.addEventListener("click", grantCapability);
    root.querySelector("[data-new-script]")?.addEventListener("click", () => {
      editing = { runAt: "document_idle", matches: [], enabled: true };
      render();
    });
    root.querySelector("[data-cancel-edit]")?.addEventListener("click", () => {
      editing = null;
      render();
    });
    root.querySelector("[data-editor]")?.addEventListener("submit", saveScript);
    root.querySelectorAll("[data-edit-script]").forEach((button) => button.addEventListener("click", () => {
      const record = scripts.find(({ id }) => id === button.dataset.editScript);
      if (record) {
        editing = { ...record };
        render();
      }
    }));
    root.querySelectorAll("[data-toggle-script]").forEach((input) => input.addEventListener("change", () => toggleScript(input.dataset.toggleScript, input.checked)));
    root.querySelectorAll("[data-remove-script]").forEach((button) => button.addEventListener("click", () => removeScript(button.dataset.removeScript)));
  }

  async function run(operation, successMessage) {
    busy = true;
    notice = "";
    render();
    try {
      await operation();
      await refresh();
      notice = successMessage;
    } catch (error) {
      notice = error?.message || "The userscript request failed.";
    } finally {
      busy = false;
      render();
    }
  }

  async function grantCapability() {
    await run(async () => {
      await session.dispatch("capabilities/grant", [{
        id: grantId(),
        appId: USERSCRIPTS_APP_ID,
        capability: USERSCRIPTS_CAPABILITY,
        constraints: {},
      }]);
    }, "Capability granted. Script management is unlocked for this app version.");
  }

  async function saveScript(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const draft = {
      id: editing.id,
      name: form.elements.name.value,
      matches: form.elements.matches.value.split("\n").map((line) => line.trim()).filter(Boolean),
      runAt: form.elements.runAt.value,
      enabled: form.elements.enabled.checked,
      source: form.elements.source.value,
    };
    await run(async () => {
      await session.call("userscripts/save", [draft]);
      editing = null;
    }, "Script saved.");
  }

  async function toggleScript(id, enabled) {
    await run(async () => {
      await session.call("userscripts/set-enabled", [id, enabled]);
    }, enabled ? "Script enabled." : "Script disabled.");
  }

  async function removeScript(id) {
    await run(async () => {
      await session.call("userscripts/remove", [id]);
    }, "Script removed.");
  }

  async function refresh() {
    const [statusValue, listValue, grantValue] = await Promise.all([
      session.call("userscripts/status"),
      session.call("userscripts/list"),
      session.call("capabilities/check", [USERSCRIPTS_APP_ID, USERSCRIPTS_CAPABILITY]).catch(() => null),
    ]);
    scriptStatus = statusValue;
    scripts = listValue?.scripts ?? [];
    granted = Boolean(grantValue);
  }

  refresh().catch((error) => {
    notice = error?.message || "Userscript state could not be read.";
    render();
  });
  render();

  return {
    update() {},
    destroy() { active = false; },
  };
}
