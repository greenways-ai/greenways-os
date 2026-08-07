import {
  KEYRING_PROVIDERS,
  createProviderProfileId,
} from "./keyring.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function panelMarkup(state, notice, tone, busy) {
  const controller = state.controller;
  const profiles = state.providerProfiles;
  return `<section class="keyring-panel" role="dialog" aria-modal="true" aria-label="Greenways Keyring">
    <header><div><p>GREENWAYS OS / CORE 01</p><h1>Keyring</h1></div><button type="button" data-close-keyring aria-label="Close Keyring">×</button></header>
    <main>
      <section class="keyring-lead"><i>⌁</i><div><h2>Keys stay local. Packages ask for operations.</h2><p>The controller key is non-extractable and durable. Provider credentials live only in Chrome session storage and clear on restart, reload, disable, or update.</p></div></section>
      <section class="keyring-block"><div class="keyring-title"><div><p>CONTROLLER</p><h2>Signing identity</h2></div><span>${controller ? "Ready" : "Not created"}</span></div>
        ${controller
          ? `<dl><div><dt>Handle</dt><dd>@${escapeHtml(controller.handle)}</dd></div><div><dt>Key ID</dt><dd><code>${escapeHtml(controller.keyId)}</code></dd></div><div><dt>Algorithm</dt><dd>${escapeHtml(controller.algorithm)}</dd></div></dl>`
          : `<form data-controller-form><label>Greenways handle<input name="handle" required autocomplete="nickname" placeholder="river.studio"></label><button ${busy ? "disabled" : ""}>Create non-extractable controller key</button></form>`}
      </section>
      <section class="keyring-block"><div class="keyring-title"><div><p>PROVIDER CREDENTIALS</p><h2>Session-only API access</h2></div><span>${profiles.length} loaded</span></div>
        ${profiles.length
          ? `<div class="profile-list">${profiles.map((profile) => `<article><span><strong>${escapeHtml(profile.label)}</strong><small>${escapeHtml(profile.provider)} · session only</small></span><button type="button" data-remove-profile="${escapeHtml(profile.id)}" ${busy ? "disabled" : ""}>Remove</button></article>`).join("")}</div>`
          : `<p class="keyring-empty">No provider credentials are loaded.</p>`}
        <form class="provider-form" data-provider-form><label>Provider<select name="provider">${KEYRING_PROVIDERS.map(({ id, name }) => `<option value="${id}">${name}</option>`).join("")}</select></label><label>Profile label<input name="label" required maxlength="80" placeholder="Personal models"></label><label class="secret-field">API credential<input name="secret" type="password" required autocomplete="off" placeholder="Session only"></label><button ${busy ? "disabled" : ""}>Add session credential</button></form>
        ${profiles.length ? `<button type="button" class="clear-profiles" data-clear-profiles ${busy ? "disabled" : ""}>Clear all session credentials</button>` : ""}
      </section>
      ${notice ? `<p class="keyring-notice" data-tone="${tone}">${escapeHtml(notice)}</p>` : ""}
      <p class="keyring-footnote">Native connectors may use a credential only for an allowlisted, typed operation. Website forwarding, arbitrary URLs, custom authorization headers, and raw provider payloads remain unavailable.</p>
    </main>
  </section>`;
}

export async function openKeyringSurface({ root, keyring, onChanged = () => {} }) {
  if (!root || typeof root.append !== "function") throw new TypeError("Keyring surface root is required");
  if (!keyring || typeof keyring.status !== "function") throw new TypeError("Greenways Keyring is required");
  root.querySelector("[data-keyring-overlay]")?.remove();

  let state = await keyring.status();
  let notice = "";
  let tone = "quiet";
  let busy = false;
  let active = true;
  const overlay = document.createElement("div");
  overlay.className = "keyring-overlay";
  overlay.dataset.keyringOverlay = "";
  overlay.innerHTML = `<button type="button" class="keyring-scrim" aria-label="Close Keyring"></button><div class="keyring-frame"></div>`;
  root.append(overlay);
  const frame = overlay.querySelector(".keyring-frame");

  async function reload() {
    state = await keyring.status();
    await onChanged(state);
  }

  async function act(operation, message) {
    if (busy) return;
    busy = true;
    notice = "Updating the local keyring…";
    tone = "quiet";
    render();
    try {
      await operation();
      await reload();
      notice = message;
      tone = "good";
    } catch (error) {
      notice = error?.message || "The keyring could not be updated.";
      tone = "error";
    } finally {
      busy = false;
      render();
    }
  }

  function render() {
    if (!active) return;
    frame.innerHTML = panelMarkup(state, notice, tone, busy);
    frame.querySelector("[data-close-keyring]")?.addEventListener("click", destroy);
    frame.querySelector("[data-controller-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      act(
        () => keyring.createController(String(data.get("handle") ?? "")),
        "Controller key created locally.",
      );
    });
    frame.querySelector("[data-provider-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const provider = String(data.get("provider") ?? "");
      const label = String(data.get("label") ?? "");
      const secret = String(data.get("secret") ?? "");
      act(
        () => keyring.addProviderProfile({
          id: createProviderProfileId(provider, label),
          provider,
          label,
          secret,
        }),
        "Provider credential loaded for this browser session.",
      );
    });
    frame.querySelectorAll("[data-remove-profile]").forEach((button) => {
      button.addEventListener("click", () => act(
        () => keyring.removeProviderProfile(button.dataset.removeProfile),
        "Provider credential removed.",
      ));
    });
    frame.querySelector("[data-clear-profiles]")?.addEventListener("click", () => act(
      () => keyring.clearProviderSession(),
      "All session credentials cleared.",
    ));
  }

  function destroy() {
    if (!active) return;
    active = false;
    window.removeEventListener("keydown", keydown);
    overlay.remove();
  }

  function keydown(event) {
    if (event.key === "Escape") destroy();
  }

  overlay.querySelector(".keyring-scrim")?.addEventListener("click", destroy);
  window.addEventListener("keydown", keydown);
  render();
  frame.querySelector("button, input, select")?.focus();
  return Object.freeze({ close: destroy });
}
