import { getAppManifest } from "./app-catalog.js";
import {
  GreenwaysKeyring,
  KEYRING_PROVIDERS,
  createProviderProfileId,
} from "./keyring.js";
import { packageKindLabel, projectPackage } from "./package-manager.js";

const appRoot = document.querySelector("#launcher-app");
const surfaceRoot = document.querySelector("#launcher-surfaces");
const keyring = new GreenwaysKeyring();
let snapshot = null;
let keyringError = null;
let scheduled = false;
let overlay = null;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const setText = (node, value) => { if (node && node.textContent !== value) node.textContent = value; };
const setHtml = (node, value) => { if (node && node.innerHTML !== value) node.innerHTML = value; };

function counts(shell) {
  return {
    installed: shell.querySelectorAll(".app-section:not(.catalog-section) [data-app-card]").length,
    available: shell.querySelectorAll(".catalog-section [data-app-card]").length,
  };
}

function coreMarkup(shell) {
  const packages = counts(shell);
  const controller = snapshot?.controller;
  const profiles = snapshot?.providerProfiles ?? [];
  const state = keyringError ? "NEEDS ATTENTION" : controller || profiles.length ? "READY" : "SET UP";
  return `<section class="core-products" data-core-products>
    <header class="core-heading"><div><p>GREENWAYS OS / CORE</p><h2>Keys first. Packages second.</h2></div><span>Local Hara kernel</span></header>
    <div class="core-grid">
      <article class="core-card core-card--keyring"><b>01</b><i>⌁</i><div><p>KEYRING · ${state}</p><h3>Own the keys your tools use.</h3><span>${controller ? `@${escapeHtml(controller.handle)} · ` : "Controller not created · "}${profiles.length} session model profile${profiles.length === 1 ? "" : "s"}</span></div><button data-open-keyring>Open keyring</button></article>
      <article class="core-card core-card--packages"><b>02</b><i>▦</i><div><p>PACKAGE MANAGER · LOCAL APPROVALS</p><h3>Add capabilities without surrendering the kernel.</h3><span>${packages.installed} installed · ${packages.available} available · executable extension code stays bundled</span></div><button data-manage-packages>Manage packages</button></article>
    </div>
    <p class="core-boundary">Packages may request typed keyring operations. They are never given a readable provider credential or private signing key.</p>
  </section>`;
}

function connectionsMarkup() {
  return `<section class="core-connections" data-core-connections>
    <header class="core-heading"><div><p>OPTIONAL CONNECTIONS</p><h2>Homes, gateways, and migration</h2></div><span>Network by consent</span></header>
    <p>Beacon, Hestia, and legacy Home Link extend Greenways OS. They do not sit above local keys or package approvals.</p>
    <div data-connection-items></div>
  </section>`;
}

function decorate() {
  scheduled = false;
  const shell = appRoot?.querySelector(".launcher-shell");
  const intro = shell?.querySelector(".launcher-intro");
  if (!shell || !intro) return;

  // The older Beacon/Home decorators retain their compatibility markup, but
  // the first-product shell no longer renders that network-led hero. Avoid
  // rewriting its children so independent MutationObservers cannot fight over
  // copy or connection status.
  if (!intro.hidden) intro.hidden = true;
  setText(shell.querySelector(".launcher-brand small"), "LOCAL KEYRING + PACKAGE MANAGER");

  const signature = JSON.stringify([snapshot?.controller?.keyId, snapshot?.providerProfiles?.map(({ id }) => id), Boolean(keyringError), counts(shell)]);
  let core = shell.querySelector(":scope > [data-core-products]");
  if (!core || core.dataset.signature !== signature) {
    const template = document.createElement("template");
    template.innerHTML = coreMarkup(shell).trim();
    const next = template.content.firstElementChild;
    next.dataset.signature = signature;
    if (core) core.replaceWith(next); else intro.after(next);
    core = next;
    core.querySelector("[data-open-keyring]")?.addEventListener("click", () => openKeyring().catch((error) => { keyringError = error; schedule(); }));
    core.querySelector("[data-manage-packages]")?.addEventListener("click", () => shell.querySelector(".app-section")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  if (intro.nextElementSibling !== core) intro.after(core);

  const sections = [...shell.querySelectorAll(":scope > .app-section")];
  const installed = sections.find((section) => !section.classList.contains("catalog-section"));
  const catalog = sections.find((section) => section.classList.contains("catalog-section"));
  if (installed) {
    installed.setAttribute("aria-label", "Installed apps");
    setText(installed.querySelector(".section-heading p"), "PACKAGE MANAGER");
    setText(installed.querySelector(".section-heading h2"), "Installed packages");
  }
  if (catalog) {
    setText(catalog.querySelector(".section-heading p"), "PACKAGE CATALOGUE");
    setText(catalog.querySelector(".section-heading h2"), "Available packages");
  }
  let anchor = core;
  for (const section of [installed, catalog]) {
    if (!section) continue;
    if (anchor.nextElementSibling !== section) anchor.after(section);
    anchor = section;
  }
  shell.querySelectorAll("[data-app-card]").forEach((card) => {
    const manifest = getAppManifest(card.dataset.appCard);
    if (manifest) setText(card.querySelector(".app-copy p"), packageKindLabel(projectPackage(manifest).kind));
  });

  let connections = shell.querySelector(":scope > [data-core-connections]");
  if (!connections) {
    const template = document.createElement("template");
    template.innerHTML = connectionsMarkup().trim();
    connections = template.content.firstElementChild;
  }
  if (anchor.nextElementSibling !== connections) anchor.after(connections);
  const legacy = shell.querySelector("[data-home-node]");
  const items = connections.querySelector("[data-connection-items]");
  if (legacy && legacy.parentElement !== items) items.append(legacy);
  // Beacon's reviewed decorator keeps itself immediately before Home Link, so
  // moving the legacy card here also demotes Beacon without duplicating it.
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(decorate);
}

async function refresh() {
  try { snapshot = await keyring.status(); keyringError = null; }
  catch (error) { keyringError = error; }
  schedule();
}

function closeKeyring() {
  overlay?.remove();
  overlay = null;
}

function panelMarkup(state, notice, tone, busy) {
  const controller = state.controller;
  const profiles = state.providerProfiles;
  return `<section class="keyring-panel" role="dialog" aria-modal="true" aria-label="Greenways Keyring">
    <header><div><p>GREENWAYS OS / CORE 01</p><h1>Keyring</h1></div><button data-close-keyring aria-label="Close Keyring">×</button></header>
    <main>
      <section class="keyring-lead"><i>⌁</i><div><h2>Keys stay local. Packages ask for operations.</h2><p>The controller key is non-extractable and durable. Provider credentials live only in Chrome session storage and clear on restart, reload, disable, or update.</p></div></section>
      <section class="keyring-block"><div class="keyring-title"><div><p>CONTROLLER</p><h2>Signing identity</h2></div><span>${controller ? "Ready" : "Not created"}</span></div>
        ${controller ? `<dl><div><dt>Handle</dt><dd>@${escapeHtml(controller.handle)}</dd></div><div><dt>Key ID</dt><dd><code>${escapeHtml(controller.keyId)}</code></dd></div><div><dt>Algorithm</dt><dd>${escapeHtml(controller.algorithm)}</dd></div></dl>` : `<form data-controller-form><label>Greenways handle<input name="handle" required autocomplete="nickname" placeholder="river.studio"></label><button ${busy ? "disabled" : ""}>Create non-extractable controller key</button></form>`}
      </section>
      <section class="keyring-block"><div class="keyring-title"><div><p>MODEL PROVIDERS</p><h2>Session credentials</h2></div><span>${profiles.length} loaded</span></div>
        ${profiles.length ? `<div class="profile-list">${profiles.map((profile) => `<article><span><strong>${escapeHtml(profile.label)}</strong><small>${escapeHtml(profile.provider)} · session only</small></span><button data-remove-profile="${escapeHtml(profile.id)}" ${busy ? "disabled" : ""}>Remove</button></article>`).join("")}</div>` : `<p class="keyring-empty">No model credentials are loaded.</p>`}
        <form class="provider-form" data-provider-form><label>Provider<select name="provider">${KEYRING_PROVIDERS.map(({ id, name }) => `<option value="${id}">${name}</option>`).join("")}</select></label><label>Profile label<input name="label" required maxlength="80" placeholder="Personal coding"></label><label class="secret-field">API credential<input name="secret" type="password" required autocomplete="off" placeholder="Session only"></label><button ${busy ? "disabled" : ""}>Add session credential</button></form>
        ${profiles.length ? `<button class="clear-profiles" data-clear-profiles ${busy ? "disabled" : ""}>Clear all session credentials</button>` : ""}
      </section>
      ${notice ? `<p class="keyring-notice" data-tone="${tone}">${escapeHtml(notice)}</p>` : ""}
      <p class="keyring-footnote">The website forwarder remains off until exact origin grants, budgets, context disclosure, and typed provider operations are implemented.</p>
    </main>
  </section>`;
}

async function openKeyring() {
  closeKeyring();
  let state = snapshot ?? await keyring.status();
  let notice = keyringError?.message ?? "";
  let tone = keyringError ? "error" : "quiet";
  let busy = false;
  let active = true;
  overlay = document.createElement("div");
  overlay.className = "keyring-overlay";
  overlay.innerHTML = `<button class="keyring-scrim" aria-label="Close Keyring"></button><div class="keyring-frame"></div>`;
  surfaceRoot.append(overlay);
  const currentOverlay = overlay;
  const frame = currentOverlay.querySelector(".keyring-frame");

  async function reload() { state = await keyring.status(); snapshot = state; keyringError = null; schedule(); }
  async function act(operation, message) {
    if (busy) return;
    busy = true; notice = "Updating the local keyring…"; tone = "quiet"; render();
    try { await operation(); await reload(); notice = message; tone = "good"; }
    catch (error) { notice = error?.message || "The keyring could not be updated."; tone = "error"; }
    finally { busy = false; render(); }
  }
  function render() {
    if (!active) return;
    frame.innerHTML = panelMarkup(state, notice, tone, busy);
    frame.querySelector("[data-close-keyring]")?.addEventListener("click", destroy);
    frame.querySelector("[data-controller-form]")?.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); act(() => keyring.createController(String(data.get("handle") ?? "")), "Controller key created locally."); });
    frame.querySelector("[data-provider-form]")?.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const provider = String(data.get("provider") ?? ""); const label = String(data.get("label") ?? ""); act(() => keyring.addProviderProfile({ id: createProviderProfileId(provider, label), provider, label, secret: String(data.get("secret") ?? "") }), "Provider credential loaded for this browser session."); });
    frame.querySelectorAll("[data-remove-profile]").forEach((button) => button.addEventListener("click", () => act(() => keyring.removeProviderProfile(button.dataset.removeProfile), "Provider credential removed.")));
    frame.querySelector("[data-clear-profiles]")?.addEventListener("click", () => act(() => keyring.clearProviderSession(), "All session credentials cleared."));
  }
  function destroy() { if (!active) return; active = false; window.removeEventListener("keydown", keydown); currentOverlay.remove(); if (overlay === currentOverlay) overlay = null; }
  function keydown(event) { if (event.key === "Escape") destroy(); }
  currentOverlay.querySelector(".keyring-scrim")?.addEventListener("click", destroy);
  window.addEventListener("keydown", keydown);
  render();
  frame.querySelector("button, input, select")?.focus();
}

if (appRoot && surfaceRoot) {
  new MutationObserver(schedule).observe(appRoot, { childList: true, subtree: true });
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refresh();
  schedule();
}
