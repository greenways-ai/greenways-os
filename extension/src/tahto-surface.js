import {
  TAHTO_SETTINGS_KEY,
  TahtoClient,
  createTahtoNodeRecord,
  normalizeTahtoNodeState,
  removeTahtoNode,
  requestTahtoOriginAccess,
  revokeTahtoOriginAccess,
  setDefaultTahtoNode,
  upsertTahtoNode,
} from "./tahto-client.js";
import { TahtoKeyring } from "./tahto-keyring.js";
import { createTahtoMonitor } from "./tahto-monitor.js";
import { fabricStore, store, withOriginLock } from "./storage.js";

const appRoot = document.querySelector("#launcher-app");
const surfaceRoot = document.querySelector("#launcher-surfaces");
const TAHTO_LOCK = "tahto-nodes";
const DEFAULT_TAHTO_ORIGIN = "http://127.0.0.1:58100";
const keyring = new TahtoKeyring();
const monitor = createTahtoMonitor({ keyring });

let state = normalizeTahtoNodeState(null);
let monitorRecords = new Map();
let mountedSurface = null;
let decorateScheduled = false;
let stateError = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function defaultNode() {
  return state.nodes.find(({ origin }) => origin === state.defaultOrigin) ?? null;
}

function semanticReadiness(node) {
  const semantic = node?.status?.fabric?.semanticFabric ?? node?.descriptor?.components?.semanticFabric;
  const signing = node?.status?.fabric?.signatureProvider ?? node?.descriptor?.components?.signatureProvider;
  return semantic === "ready" && signing === "ready" ? "ready" : "pending";
}

function cardModel() {
  const selected = defaultNode();
  const observed = selected ? monitorRecords.get(selected.origin)?.latest : null;
  if (stateError) {
    return {
      state: "degraded",
      label: "Local state invalid",
      title: "Tahto connection state needs attention.",
      description: stateError.message,
      nodes: state.nodes.length,
      defaultLabel: "None",
      semantic: "Unavailable",
      action: "Inspect Tahto",
    };
  }
  if (!selected) {
    return {
      state: "local",
      label: "Not connected",
      title: "Connect application state without giving up your keys.",
      description: "Greenways OS can inspect a selected Tahto node now. Pairing and semantic writes remain disabled until the node advertises their production-ready contracts.",
      nodes: 0,
      defaultLabel: "None",
      semantic: "Not connected",
      action: "Connect Tahto",
    };
  }
  const healthy = (observed?.state ?? selected.health.status) === "ready";
  const semantic = semanticReadiness(selected);
  return {
    state: healthy ? "connected" : "degraded",
    label: observed ? `Monitor ${observed.state}` : (healthy ? "Control plane ready" : "Node degraded"),
    title: `${selected.label} is the default state fabric.`,
    description: healthy
      ? "Discovery, health and component readiness were validated as inert data. This connection is transport consent only; it is not pairing or application authority."
      : "The last validated node record is retained locally, but new work should wait until its control plane is healthy.",
    nodes: state.nodes.length,
    defaultLabel: selected.origin,
    semantic: semantic === "ready" ? "Ready" : "Pending production gates",
    monitored: observed ? new Date(observed.checkedAt).toLocaleString() : "Not sampled",
    revision: observed?.diagnostics?.checks?.metadata?.revision ?? "Paired detail unavailable",
    action: "Manage Tahto",
  };
}

function cardMarkup(model) {
  return `<section class="tahto-card" data-tahto data-state="${escapeHtml(model.state)}" aria-labelledby="tahto-heading">
    <header><p>TAHTO / APPLICATION-STATE FABRIC</p><span data-state="${escapeHtml(model.state)}"><i></i>${escapeHtml(model.label)}</span></header>
    <div class="tahto-card__body">
      <div><h2 id="tahto-heading">${escapeHtml(model.title)}</h2><p>${escapeHtml(model.description)}</p></div>
      <div class="tahto-card__route" aria-label="Greenways OS retains authority while Tahto holds application state"><span>GREENWAYS OS</span><i></i><b>TAHTO</b><i></i><span>STATE</span></div>
    </div>
    <dl><div><dt>Saved nodes</dt><dd>${escapeHtml(model.nodes)}</dd></div><div><dt>Default</dt><dd title="${escapeHtml(model.defaultLabel)}">${escapeHtml(model.defaultLabel)}</dd></div><div><dt>Semantic service</dt><dd>${escapeHtml(model.semantic)}</dd></div><div><dt>Metadata revision</dt><dd>${escapeHtml(model.revision ?? "Paired detail unavailable")}</dd></div><div><dt>Last monitor</dt><dd>${escapeHtml(model.monitored ?? "Not sampled")}</dd></div></dl>
    <footer><button type="button" data-tahto-open>${escapeHtml(model.action)}</button><span>Origin permission is not application authority.</span></footer>
  </section>`;
}

function placeCard() {
  decorateScheduled = false;
  const shell = appRoot?.querySelector(".launcher-shell");
  const intro = shell?.querySelector(".launcher-intro");
  if (!shell || !intro) return;
  const model = cardModel();
  const signature = JSON.stringify(model);
  let card = shell.querySelector("[data-tahto]");
  if (!card || card.dataset.signature !== signature) {
    const template = document.createElement("template");
    template.innerHTML = cardMarkup(model).trim();
    const replacement = template.content.firstElementChild;
    replacement.dataset.signature = signature;
    replacement.querySelector("[data-tahto-open]")?.addEventListener("click", openSurface);
    if (card) card.replaceWith(replacement);
    else intro.insertAdjacentElement("afterend", replacement);
    card = replacement;
  }
  // Visual ordering belongs to core-order.css. Do not move cards from an
  // observer callback: the legacy decorators observe the same tree.
}

function scheduleDecoration() {
  if (decorateScheduled) return;
  decorateScheduled = true;
  queueMicrotask(placeCard);
}

async function loadState() {
  try {
    state = normalizeTahtoNodeState(await store.get("settings", TAHTO_SETTINGS_KEY));
    monitorRecords = new Map((await fabricStore.values())
      .filter((record) => record?.protocol === "greenways-tahto-monitor/1")
      .map((record) => [record.origin, record]));
    stateError = null;
  } catch (error) {
    state = normalizeTahtoNodeState(null);
    stateError = error;
  }
  scheduleDecoration();
}

async function saveState(next) {
  const normalized = normalizeTahtoNodeState(next);
  await withOriginLock(TAHTO_LOCK, () => store.put("settings", TAHTO_SETTINGS_KEY, normalized));
  state = normalized;
  stateError = null;
  scheduleDecoration();
  return normalized;
}

function closeSurface() {
  mountedSurface?.destroy();
  mountedSurface = null;
}

function nodeRows(busyOrigin) {
  if (!state.nodes.length) return `<p class="tahto-empty">No Tahto nodes have been approved by this browser.</p>`;
  return `<div class="tahto-nodes">${state.nodes.map((node) => {
    const selected = node.origin === state.defaultOrigin;
    const busy = busyOrigin === node.origin;
    const semantic = semanticReadiness(node);
    const observed = monitorRecords.get(node.origin);
    const latest = observed?.latest;
    const diagnostics = latest?.diagnostics;
    const openIncidents = observed?.incidents?.filter(({ closedAt }) => closedAt === null).length ?? 0;
    return `<article data-default="${selected}" data-origin="${escapeHtml(node.origin)}">
      <label><input type="radio" name="default-node" value="${escapeHtml(node.origin)}" ${selected ? "checked" : ""} ${busy ? "disabled" : ""}><span><strong>${escapeHtml(node.label)}</strong><small>${escapeHtml(node.origin)}</small></span></label>
      <div><em data-state="${escapeHtml(latest?.state ?? node.health.status)}">${escapeHtml(latest?.state ?? node.health.status)}</em><span>Semantic ${escapeHtml(semantic)}</span><small>${latest ? `Monitored ${escapeHtml(new Date(latest.checkedAt).toLocaleString())} · ${escapeHtml(observed.samples.length)} samples · ${escapeHtml(openIncidents)} open incidents${diagnostics ? ` · revision ${escapeHtml(diagnostics.checks.metadata.revision)} · ${escapeHtml(diagnostics.counts.objects)} objects · ${escapeHtml(diagnostics.counts.heads)} heads` : latest.diagnosticError ? ` · paired detail denied` : ""}` : `Checked ${escapeHtml(new Date(node.checkedAt).toLocaleString())}`}</small></div>
      <footer><button type="button" data-tahto-pair="${escapeHtml(node.origin)}" ${busy || !node.descriptor.routes.pairingPrepare ? "disabled" : ""}>${node.descriptor.routes.pairingPrepare ? "Pair" : "Pairing unavailable"}</button><button type="button" data-tahto-refresh="${escapeHtml(node.origin)}" ${busy ? "disabled" : ""}>${busy ? "Checking…" : "Refresh"}</button><button type="button" data-tahto-forget="${escapeHtml(node.origin)}" ${busy ? "disabled" : ""}>Forget</button></footer>
    </article>`;
  }).join("")}</div>`;
}

function createSurface() {
  let active = true;
  let busyOrigin = null;
  let notice = stateError?.message ?? "";
  let noticeTone = stateError ? "error" : "quiet";
  const overlay = document.createElement("div");
  overlay.className = "world-surface-overlay tahto-overlay";
  overlay.dataset.tahtoOverlay = "true";
  overlay.innerHTML = `<button class="world-surface-scrim" type="button" aria-label="Close Tahto"></button><div class="world-surface-frame tahto-frame" role="dialog" aria-modal="true" aria-label="Tahto application-state fabric"></div>`;
  surfaceRoot.append(overlay);
  const frame = overlay.querySelector(".tahto-frame");

  function render() {
    if (!active) return;
    frame.innerHTML = `<section class="tahto-surface">
      <header><div><p>APPLICATION-STATE FABRIC</p><h1>Tahto</h1></div><button type="button" data-tahto-close aria-label="Close Tahto">×</button></header>
      <div class="tahto-body">
        <section class="tahto-hero"><span aria-hidden="true">T</span><div><h2>Choose where this browser keeps application state.</h2><p>Add a loopback or HTTPS Tahto origin. Greenways OS requests that exact Chrome permission, then validates only discovery, health and status. Private keys and application grants stay in this browser.</p></div></section>
        <form class="tahto-form"><label>Tahto origin<input name="origin" type="url" required value="${DEFAULT_TAHTO_ORIGIN}" placeholder="https://tahto.example"></label><label>Label<input name="label" type="text" maxlength="80" placeholder="My Tahto"></label><button type="submit" ${busyOrigin ? "disabled" : ""}>${busyOrigin === "new" ? "Inspecting node…" : "Add Tahto node"}</button></form>
        <section class="tahto-list"><div><p>APPROVED NODES</p><span>${escapeHtml(state.nodes.length)} saved · one explicit default</span></div>${nodeRows(busyOrigin)}</section>
        <div class="tahto-boundary"><strong>Discovery is descriptive, not authority.</strong><span>Pairing creates one non-extractable device key for the selected node and never grants administrator authority. Remote HTML, scripts, modules, Wasm and HAL are never evaluated.</span></div>
        ${notice ? `<p class="tahto-notice" data-tone="${escapeHtml(noticeTone)}" role="status">${escapeHtml(notice)}</p>` : ""}
      </div>
    </section>`;
    frame.querySelector("[data-tahto-close]")?.addEventListener("click", closeSurface);
    frame.querySelector(".tahto-form")?.addEventListener("submit", addNode);
    frame.querySelectorAll('input[name="default-node"]').forEach((input) => input.addEventListener("change", chooseDefault));
    frame.querySelectorAll("[data-tahto-pair]").forEach((button) => button.addEventListener("click", () => pairNode(button.dataset.tahtoPair)));
    frame.querySelectorAll("[data-tahto-refresh]").forEach((button) => button.addEventListener("click", () => refreshNode(button.dataset.tahtoRefresh)));
    frame.querySelectorAll("[data-tahto-forget]").forEach((button) => button.addEventListener("click", () => forgetNode(button.dataset.tahtoForget)));
  }

  async function addNode(event) {
    event.preventDefault();
    if (busyOrigin) return;
    const form = new FormData(event.currentTarget);
    const originInput = String(form.get("origin") ?? "");
    const label = String(form.get("label") ?? "").trim();
    busyOrigin = "new";
    notice = "Requesting access to this exact Tahto origin…";
    noticeTone = "quiet";
    render();
    let origin = null;
    let permissionGranted = false;
    let alreadyStored = false;
    try {
      const client = new TahtoClient({ origin: originInput });
      origin = client.origin;
      alreadyStored = state.nodes.some((node) => node.origin === origin);
      await requestTahtoOriginAccess(origin);
      permissionGranted = true;
      const inspected = await client.inspect();
      const record = createTahtoNodeRecord({ origin, label, ...inspected });
      await saveState(upsertTahtoNode(state, record));
      const monitored = await monitor.recordInspection(origin, inspected, { source: "manual" });
      monitorRecords.set(origin, monitored);
      notice = `${record.label} is available. Pairing and semantic authority were not granted.`;
      noticeTone = "good";
    } catch (error) {
      if (permissionGranted && origin && !alreadyStored) await revokeTahtoOriginAccess(origin).catch(() => {});
      notice = error?.message || "Tahto could not be inspected.";
      noticeTone = "error";
    } finally {
      busyOrigin = null;
      render();
    }
  }

  async function chooseDefault(event) {
    if (busyOrigin) return;
    try {
      await saveState(setDefaultTahtoNode(state, event.currentTarget.value));
      notice = "The default Tahto node was updated.";
      noticeTone = "good";
    } catch (error) {
      notice = error?.message || "The default Tahto node could not be changed.";
      noticeTone = "error";
    }
    render();
  }

  async function refreshNode(origin) {
    if (busyOrigin) return;
    busyOrigin = origin;
    notice = "Refreshing Tahto discovery and readiness…";
    noticeTone = "quiet";
    render();
    const started = Date.now();
    try {
      const previous = state.nodes.find((node) => node.origin === origin);
      if (!previous) throw new Error("Tahto node is not stored");
      const inspected = await new TahtoClient({ origin }).inspect();
      const record = createTahtoNodeRecord({ origin, label: previous.label, ...inspected });
      await saveState(upsertTahtoNode(state, record));
      const monitored = await monitor.recordInspection(origin, inspected, {
        source: "manual",
        latencyMs: Date.now() - started,
      });
      monitorRecords.set(origin, monitored);
      notice = `${record.label} is ${record.health.status}.`;
      noticeTone = "good";
    } catch (error) {
      const monitored = await monitor.record(origin, {
        error,
        source: "manual",
        latencyMs: Date.now() - started,
      }).catch(() => null);
      if (monitored) monitorRecords.set(origin, monitored);
      notice = error?.message || "Tahto could not be refreshed.";
      noticeTone = "error";
    } finally {
      busyOrigin = null;
      render();
    }
  }

  async function pairNode(origin) {
    if (busyOrigin) return;
    const invitation = window.prompt("Enter the one-time invitation created by this Tahto node:");
    if (!invitation) return;
    busyOrigin = origin;
    notice = "Creating a non-extractable device key and consuming the one-time invitation…";
    noticeTone = "quiet";
    render();
    try {
      const result = await new TahtoClient({ origin, keyring }).pair(invitation);
      notice = `Paired ${result.device} with ${result.node}. No administrator role or application grants were created.`;
      noticeTone = "good";
    } catch (error) {
      notice = error?.message || "Tahto pairing failed.";
      noticeTone = "error";
    } finally {
      busyOrigin = null;
      render();
    }
  }

  async function forgetNode(origin) {
    if (busyOrigin) return;
    busyOrigin = origin;
    notice = "Removing the saved node and its Chrome origin permission…";
    noticeTone = "quiet";
    render();
    try {
      await revokeTahtoOriginAccess(origin);
      await keyring.remove(origin);
      await saveState(removeTahtoNode(state, origin));
      notice = "The Tahto node and local private key were forgotten. No server-side device was revoked.";
      noticeTone = "good";
    } catch (error) {
      notice = error?.message || "The Tahto node could not be forgotten.";
      noticeTone = "error";
    } finally {
      busyOrigin = null;
      render();
    }
  }

  function keydown(event) {
    if (event.key === "Escape") closeSurface();
  }
  overlay.querySelector(".world-surface-scrim")?.addEventListener("click", closeSurface);
  window.addEventListener("keydown", keydown);
  render();
  return {
    destroy() {
      if (!active) return;
      active = false;
      window.removeEventListener("keydown", keydown);
      overlay.remove();
    },
  };
}

function openSurface() {
  closeSurface();
  mountedSurface = createSurface();
}

const observer = new MutationObserver(scheduleDecoration);
if (appRoot) observer.observe(appRoot, { childList: true, subtree: true });
loadState().catch((error) => {
  stateError = error;
  scheduleDecoration();
});
scheduleDecoration();
