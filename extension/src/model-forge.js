import { randomId } from "./protocol.js";
import { createTripoSiteDriverBroker } from "./site-driver-broker.js";
import {
  SITE_DRIVER_REQUEST_PROTOCOL,
  TRIPO_STUDIO_DRIVER_ID,
  TRIPO_STUDIO_GENERATE_URL,
  TRIPO_STUDIO_ORIGIN_PATTERN,
  siteDriverSupportsUrl,
  getSiteDriverDescriptor,
} from "./site-driver-protocol.js";

const root = document.querySelector("#model-forge-app");
const broker = createTripoSiteDriverBroker();
const descriptor = getSiteDriverDescriptor(TRIPO_STUDIO_DRIVER_ID);

let tabs = [];
let selectedTabId = null;
let attachment = null;
let requestId = null;
let promptRoot = null;
let confirmationToken = null;
let observation = null;
let busy = false;
let notice = "Grant access to Tripo Studio, then attach a Generate Model tab.";
let tone = "quiet";
let polling = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function request(operation, { args = {}, requestId: requestedId = requestId, tabId = null } = {}) {
  return broker.handle({
    protocol: SITE_DRIVER_REQUEST_PROTOCOL,
    driverId: TRIPO_STUDIO_DRIVER_ID,
    operation,
    requestId: requestedId,
    tabId,
    args,
  });
}

async function hasOriginPermission() {
  return chrome.permissions.contains({ origins: [TRIPO_STUDIO_ORIGIN_PATTERN] });
}

async function ensureOriginPermission() {
  // permissions.request must begin in the direct user-gesture call stack. It is
  // safe to request an already granted optional origin; Chrome returns true.
  const granted = await chrome.permissions.request({ origins: [TRIPO_STUDIO_ORIGIN_PATTERN] });
  if (!granted && !await hasOriginPermission()) {
    throw new Error("Tripo Studio access was not granted");
  }
  return true;
}

function tabLabel(tab) {
  const title = String(tab.title || "Tripo Studio").trim();
  const route = (() => {
    try { return new URL(tab.url || tab.pendingUrl).pathname; } catch { return ""; }
  })();
  return `${title} · ${route || "Generate Model"}`;
}

async function refreshTabs() {
  if (!await hasOriginPermission()) {
    tabs = [];
    selectedTabId = null;
    return;
  }
  const values = await chrome.tabs.query({ url: TRIPO_STUDIO_ORIGIN_PATTERN });
  tabs = values
    .filter((tab) => Number.isSafeInteger(tab.id) && siteDriverSupportsUrl(descriptor, tab.url || tab.pendingUrl))
    .sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active))
      || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0));
  if (!tabs.some(({ id }) => id === selectedTabId)) selectedTabId = tabs[0]?.id ?? null;
}

function currentTab() {
  return tabs.find(({ id }) => id === selectedTabId) ?? null;
}

function stopPolling() {
  if (polling !== null) clearTimeout(polling);
  polling = null;
}

function scheduleObservation() {
  stopPolling();
  if (!requestId || !["submitted", "running"].includes(observation?.state)) return;
  polling = setTimeout(async () => {
    try {
      observation = await request("observe");
      notice = observation.message;
      tone = observation.state === "failed" ? "error" : observation.state === "completed" ? "good" : "quiet";
      render();
      scheduleObservation();
    } catch (error) {
      notice = error?.message || "Tripo Studio observation stopped.";
      tone = "error";
      render();
    }
  }, 2000);
}

function stateLabel() {
  if (observation?.state) return observation.state.replaceAll("-", " ");
  if (confirmationToken) return "awaiting confirmation";
  if (promptRoot) return "staged";
  if (attachment) return attachment.probe?.state || "attached";
  return "detached";
}

function render() {
  const tab = currentTab();
  const canAttach = Boolean(tab) && !busy;
  const canStage = Boolean(attachment && tab && !busy);
  const canReview = Boolean(promptRoot && requestId && !busy && !observation);
  const canSubmit = Boolean(confirmationToken && requestId && !busy && !observation);
  const permissionKnown = tabs.length > 0 || attachment;
  const progress = observation?.progress;

  root.innerHTML = `
    <div class="forge-shell">
      <header class="forge-header">
        <div class="forge-brand"><span class="forge-mark" aria-hidden="true">◇</span><span><strong>Greenways OS</strong><small>ROOT / MODEL FORGE</small></span></div>
        <span class="forge-state" data-state="${escapeHtml(observation?.state || (attachment ? "attached" : "detached"))}"><i></i>${escapeHtml(stateLabel())}</span>
      </header>

      <main>
        <section class="forge-hero">
          <div><p class="eyebrow">TRIPO STUDIO SITE DRIVER</p><h1>Generate in the browser.<br><em>Use the Studio credits you already have.</em></h1><p>Greenways stages one prompt in your signed-in Tripo Studio tab, asks you to confirm the visible generation, then observes the page. It never reads cookies, calls the Tripo API, or submits in the background.</p></div>
          <dl><div><dt>Provider</dt><dd>Tripo Studio</dd></div><div><dt>Transport</dt><dd>Foreground DOM</dd></div><div><dt>Billing</dt><dd>Studio credits</dd></div></dl>
        </section>

        <section class="forge-grid">
          <article class="forge-panel connection-panel">
            <header><div><p>01 / ATTACH</p><h2>Tripo workspace</h2></div><span>${permissionKnown ? "EXACT ORIGIN" : "NO ACCESS"}</span></header>
            <p>Access is requested only for <code>studio.tripo3d.ai</code>. Open the Generate Model workspace and sign in normally.</p>
            <div class="forge-actions">
              <button type="button" data-grant ${busy ? "disabled" : ""}>Grant Tripo access</button>
              <button type="button" class="quiet" data-open-tripo ${busy ? "disabled" : ""}>Open Tripo Studio</button>
              <button type="button" class="quiet" data-refresh-tabs ${busy ? "disabled" : ""}>Find tabs</button>
            </div>
            <label>Generate Model tab
              <select data-tab-select ${tabs.length && !busy ? "" : "disabled"}>
                ${tabs.length
                  ? tabs.map((candidate) => `<option value="${candidate.id}" ${candidate.id === selectedTabId ? "selected" : ""}>${escapeHtml(tabLabel(candidate))}</option>`).join("")
                  : `<option>No compatible Tripo tab found</option>`}
              </select>
            </label>
            <div class="forge-actions"><button type="button" data-attach ${canAttach ? "" : "disabled"}>Attach selected tab</button>${attachment ? `<button type="button" class="quiet" data-detach ${busy ? "disabled" : ""}>Detach</button>` : ""}</div>
            ${attachment ? `<p class="attachment-note"><strong>Attached</strong><span>${escapeHtml(attachment.attachment?.url || tab?.url || "Tripo Studio")}</span></p>` : ""}
          </article>

          <article class="forge-panel prompt-panel">
            <header><div><p>02 / STAGE</p><h2>Text to 3D</h2></div><span>FOREGROUND</span></header>
            <label>Model prompt<textarea data-prompt rows="9" maxlength="4000" spellcheck="true" ${canStage ? "" : "disabled"} placeholder="A translucent glass mosaic sculpture with rounded edges…">${escapeHtml(root.dataset.prompt || "")}</textarea></label>
            <div class="prompt-meta"><span>${promptRoot ? `Request ${escapeHtml(requestId)}` : "No request staged"}</span><span>Text only in this first slice</span></div>
            <div class="forge-actions">
              <button type="button" data-stage ${canStage ? "" : "disabled"}>Stage in Tripo</button>
              <button type="button" class="quiet" data-focus-tripo ${attachment && !busy ? "" : "disabled"}>Review Tripo tab</button>
            </div>
          </article>

          <article class="forge-panel submit-panel">
            <header><div><p>03 / CONFIRM</p><h2>One generation</h2></div><span>NO BATCHING</span></header>
            <div class="review-card">
              <dl><div><dt>Prompt root</dt><dd><code>${escapeHtml(promptRoot || "Not staged")}</code></dd></div><div><dt>Visible cost</dt><dd>${escapeHtml(root.dataset.visibleCost || "Read from Tripo when explicit")}</dd></div><div><dt>Action</dt><dd>Generate Model once</dd></div></dl>
            </div>
            <div class="forge-actions">
              <button type="button" data-review ${canReview ? "" : "disabled"}>Review staged request</button>
              <button type="button" class="generate-once" data-submit ${canSubmit ? "" : "disabled"}>Generate once</button>
            </div>
            <p class="confirmation-copy">The Generate button is never activated without this foreground confirmation. A submitted Greenways request ID cannot be reused.</p>
          </article>

          <article class="forge-panel run-panel">
            <header><div><p>04 / OBSERVE</p><h2>Studio run</h2></div><button type="button" class="quiet compact" data-observe ${attachment && !busy ? "" : "disabled"}>Check now</button></header>
            <div class="run-state"><span>${escapeHtml(observation?.state || "idle")}</span><strong>${progress === null || progress === undefined ? "—" : `${Math.round(progress)}%`}</strong></div>
            <div class="run-progress"><i style="--progress:${Number(progress || 0)}%"></i></div>
            <p>${escapeHtml(observation?.message || "Submit a staged request to observe Tripo Studio.")}</p>
            <div class="forge-actions"><button type="button" class="quiet" data-focus-tripo ${attachment && !busy ? "" : "disabled"}>Open attached tab</button>${observation?.state === "completed" ? `<button type="button" data-focus-tripo>Inspect and export in Tripo</button>` : ""}</div>
          </article>
        </section>

        <p class="forge-notice" data-tone="${escapeHtml(tone)}" role="status"><i></i>${escapeHtml(notice)}</p>
      </main>
      <footer><span>GREENWAYS / MODEL FORGE</span><span>Exact-origin site driver · no Tripo API key</span></footer>
    </div>`;

  const prompt = root.querySelector("[data-prompt]");
  prompt?.addEventListener("input", () => { root.dataset.prompt = prompt.value; });
  root.querySelector("[data-tab-select]")?.addEventListener("change", (event) => {
    selectedTabId = Number(event.currentTarget.value);
  });
  root.querySelector("[data-grant]")?.addEventListener("click", () => act(async () => {
    await ensureOriginPermission();
    await refreshTabs();
    notice = tabs.length ? "Tripo Studio access granted. Select a Generate Model tab." : "Access granted. Open the Tripo Generate Model workspace, then find tabs.";
  }));
  root.querySelector("[data-open-tripo]")?.addEventListener("click", () => act(async () => {
    await chrome.tabs.create({ url: TRIPO_STUDIO_GENERATE_URL });
    notice = "Tripo Studio opened. Sign in, return here, and select Find tabs.";
  }));
  root.querySelector("[data-refresh-tabs]")?.addEventListener("click", () => act(async () => {
    await ensureOriginPermission();
    await refreshTabs();
    notice = tabs.length ? `Found ${tabs.length} compatible Tripo tab${tabs.length === 1 ? "" : "s"}.` : "No compatible Tripo Generate Model tab was found.";
  }));
  root.querySelector("[data-attach]")?.addEventListener("click", () => act(async () => {
    await ensureOriginPermission();
    const result = await request("attach", { requestId: null, tabId: selectedTabId });
    attachment = result;
    notice = result.message;
    tone = result.state === "compatible" ? "good" : "quiet";
  }));
  root.querySelector("[data-detach]")?.addEventListener("click", () => act(async () => {
    await request("detach", { requestId: null });
    attachment = null;
    requestId = null;
    promptRoot = null;
    confirmationToken = null;
    observation = null;
    root.dataset.visibleCost = "";
    stopPolling();
    notice = "Tripo Studio detached.";
  }));
  root.querySelector("[data-stage]")?.addEventListener("click", () => act(async () => {
    const value = String(root.querySelector("[data-prompt]")?.value || "").trim();
    if (!value) throw new Error("Enter a model prompt first");
    root.dataset.prompt = value;
    requestId = randomId("site-request");
    const result = await request("stage-prompt", { args: { prompt: value } });
    promptRoot = result.promptRoot;
    confirmationToken = null;
    observation = null;
    root.dataset.visibleCost = "";
    notice = result.message;
    tone = "good";
  }));
  root.querySelector("[data-review]")?.addEventListener("click", () => act(async () => {
    const result = await request("review");
    confirmationToken = result.confirmationToken;
    root.dataset.visibleCost = result.visibleCreditCost || "Not explicitly labelled on the page";
    notice = result.message;
    tone = "quiet";
  }));
  root.querySelector("[data-submit]")?.addEventListener("click", () => act(async () => {
    const result = await request("submit", { args: { confirmationToken } });
    confirmationToken = null;
    observation = result;
    notice = result.message;
    tone = "good";
    scheduleObservation();
  }));
  root.querySelector("[data-observe]")?.addEventListener("click", () => act(async () => {
    observation = await request("observe", { requestId: requestId || null });
    notice = observation.message;
    tone = observation.state === "failed" ? "error" : observation.state === "completed" ? "good" : "quiet";
    scheduleObservation();
  }));
  root.querySelectorAll("[data-focus-tripo]").forEach((button) => button.addEventListener("click", () => act(async () => {
    const target = currentTab() || (attachment?.attachment?.tabId ? await chrome.tabs.get(attachment.attachment.tabId) : null);
    if (!target?.id) throw new Error("The attached Tripo Studio tab is unavailable");
    if (target.windowId !== undefined) await chrome.windows.update(target.windowId, { focused: true });
    await chrome.tabs.update(target.id, { active: true });
    notice = "Tripo Studio focused.";
  })));
}

async function act(operation) {
  if (busy) return;
  busy = true;
  tone = "quiet";
  render();
  try {
    await operation();
  } catch (error) {
    notice = error?.message || "Model Forge could not complete that operation.";
    tone = "error";
  } finally {
    busy = false;
    render();
  }
}

async function start() {
  render();
  await refreshTabs();
  const status = await request("status", { requestId: null });
  if (status.attachment) {
    attachment = status;
    selectedTabId = status.attachment.tabId;
    const staged = status.attachment.staged;
    if (staged?.requestId && staged?.promptRoot) {
      requestId = staged.requestId;
      promptRoot = staged.promptRoot;
      if (status.attachment.submittedRequestIds?.includes(requestId)) {
        observation = await request("observe", { requestId });
        scheduleObservation();
      }
    }
    notice = observation?.message || status.message;
    tone = observation?.state === "failed"
      ? "error"
      : observation?.state === "completed" || status.state === "compatible"
        ? "good"
        : "quiet";
  }
  render();
}

window.addEventListener("beforeunload", stopPolling, { once: true });
start().catch((error) => {
  console.error("Model Forge failed", error);
  root.innerHTML = `<section class="forge-fatal"><p>MODEL FORGE</p><h1>The browser driver could not start.</h1><code>${escapeHtml(error?.message || error)}</code></section>`;
});
