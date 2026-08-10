import {
  HOME_LINK_SETTINGS_KEY,
  HomeLinkClient,
  createHomeDevice,
  createHomeLinkRecord,
  requestHomeOriginAccess,
  revokeHomeOriginAccess,
} from "./home-link-client.js";
import { store, withOriginLock } from "./storage.js";

const appRoot = document.querySelector("#launcher-app");
const surfaceRoot = document.querySelector("#launcher-surfaces");
const HOME_LINK_LOCK = "home-link";
const DEFAULT_HOME_ORIGIN = "http://127.0.0.1:58100";

let connection = null;
let homeStatus = null;
let mountedSurface = null;
let decorateScheduled = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function setState(element, state) {
  if (element && element.dataset.state !== state) element.dataset.state = state;
}

function browserName() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "This device";
  return `${platform} browser`;
}

function homeAddress(link) {
  if (!link?.origin) return "Not paired";
  try {
    const url = new URL(link.origin);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return link.origin;
  }
}

function routeLabel(link) {
  if (!link?.origin) return "Local only";
  try {
    const { hostname } = new URL(link.origin);
    if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return "This machine";
    if (hostname.endsWith(".local")) return "Home network";
    if (hostname.endsWith(".ts.net")) return "Private mesh";
    return "Private HTTPS";
  } catch {
    return "Private route";
  }
}

function setCoreLabel(core, label) {
  if (!core || core.dataset.homeLinkLabel === label) return;
  core.dataset.homeLinkLabel = label;
  const mark = core.querySelector("b") || document.createElement("b");
  if (!mark.isConnected) core.prepend(mark);
  for (const node of [...core.childNodes]) {
    if (node !== mark) node.remove();
  }
  core.append(document.createTextNode(label));
}

function homeNodeModel() {
  if (!connection) {
    return {
      state: "local",
      label: "Compatibility only",
      title: "Legacy Home Link remains available for migration.",
      description: "Pair this browser only when preserving the first Greenways Home Node protocol.",
      action: "Use legacy Home Link",
      browser: "Local kernel",
      address: "Not paired",
      route: "Local only",
      core: "LEGACY HOME NODE",
      service: "COMPATIBILITY SERVICES",
    };
  }
  const serviceCount = homeStatus?.services?.length ?? connection.services?.length ?? 0;
  return {
    state: "connected",
    label: "Legacy link",
    title: "This browser retains its original signed Home Link.",
    description: "The device key remains available for identity export and recovery. This compatibility node is not a default network route.",
    action: "Manage legacy link",
    browser: connection.device.name,
    address: homeAddress(connection),
    route: routeLabel(connection),
    core: connection.node.name.toUpperCase(),
    service: `${serviceCount} LEGACY SERVICE${serviceCount === 1 ? "" : "S"}`,
  };
}

function decorateHomeNode() {
  decorateScheduled = false;
  const homeNode = appRoot?.querySelector("[data-home-node]");
  if (!homeNode) return;
  const model = homeNodeModel();

  homeNode.dataset.homeLinkManaged = "true";
  setState(homeNode, model.state);
  setState(homeNode.querySelector(".home-node__state"), model.state);
  setState(homeNode.querySelector(".home-node__diagram"), model.state);
  setText(homeNode.querySelector(".home-node__kicker"), "LEGACY HOME LINK / DEVICE MIGRATION");

  const state = homeNode.querySelector(".home-node__state");
  if (state && state.dataset.homeLinkLabel !== model.label) {
    state.dataset.homeLinkLabel = model.label;
    const dot = state.querySelector("i") || document.createElement("i");
    if (!dot.isConnected) state.prepend(dot);
    for (const node of [...state.childNodes]) {
      if (node !== dot) node.remove();
    }
    state.append(document.createTextNode(model.label));
  }

  setText(homeNode.querySelector(".home-node__copy h2"), model.title);
  setText(homeNode.querySelector(".home-node__copy p"), model.description);
  setText(homeNode.querySelector(".home-node__browser"), "THIS BROWSER");
  setCoreLabel(homeNode.querySelector(".home-node__core"), model.core);
  setText(homeNode.querySelector(".home-node__service"), model.service);

  const registers = homeNode.querySelectorAll(".home-node__register dd");
  setText(registers[0], model.browser);
  setText(registers[1], model.address);
  if (registers[1]) registers[1].title = connection?.origin || model.address;
  setText(registers[2], model.route);

  const action = homeNode.querySelector("[data-home-node-action]");
  setText(action, model.action);
  const connector = homeNode.querySelector('.home-node__actions a[href="#app-hestia-connector"]');
  setText(connector, "Inspect the legacy Hestia connector");
}

function scheduleDecoration() {
  if (decorateScheduled) return;
  decorateScheduled = true;
  queueMicrotask(decorateHomeNode);
}

async function readLocalState() {
  connection = await store.get("settings", HOME_LINK_SETTINGS_KEY);
  scheduleDecoration();
}

function closeSurface() {
  mountedSurface?.destroy();
  mountedSurface = null;
}

function statusPresence() {
  return {
    visible: !document.hidden,
    extensionVersion: globalThis.chrome?.runtime?.getManifest?.().version ?? "development",
    updatedAt: new Date().toISOString(),
  };
}

function assertConnectionNode(status, linkedConnection) {
  if (status.node.id !== linkedConnection.node.id) {
    throw new Error("The legacy Home Node identity changed after pairing");
  }
  return status;
}

function createSurface() {
  let active = true;
  let busy = false;
  let notice = "";
  let noticeTone = "quiet";

  const overlay = document.createElement("div");
  overlay.className = "world-surface-overlay home-link-overlay";
  overlay.dataset.homeLinkOverlay = "true";
  overlay.innerHTML = `<button class="world-surface-scrim" type="button" aria-label="Close Legacy Home Link"></button>
    <div class="world-surface-frame home-link-frame" role="dialog" aria-modal="true" aria-label="Legacy Home Link"></div>`;
  surfaceRoot.append(overlay);
  const frame = overlay.querySelector(".home-link-frame");

  function serviceRows() {
    const services = homeStatus?.services ?? connection?.services ?? [];
    if (!services.length) return `<p class="home-link-empty">The compatibility node is not advertising any legacy services.</p>`;
    return `<div class="home-link-services">${services.map((service) => `<article>
      <span class="home-link-service-dot" aria-hidden="true"></span>
      <span><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.kind)}${service.version ? ` · v${escapeHtml(service.version)}` : ""}</small></span>
      <em>${escapeHtml(service.status)}</em>
    </article>`).join("")}</div>`;
  }

  function browserRows() {
    const browsers = homeStatus?.browsers ?? [];
    if (!browsers.length) return `<p class="home-link-empty">Refresh to inspect browsers still paired through the first Home Link protocol.</p>`;
    return `<div class="home-link-browsers">${browsers.map((browser) => `<article data-current="${browser.current}">
      <span class="home-link-browser-glyph" aria-hidden="true"></span>
      <span><strong>${escapeHtml(browser.name)}${browser.current ? " · this browser" : ""}</strong><small>Last signed presence ${escapeHtml(new Date(browser.lastSeenAt).toLocaleString())}</small></span>
    </article>`).join("")}</div>`;
  }

  function render() {
    if (!active) return;
    const linked = Boolean(connection);
    frame.innerHTML = `<section class="home-link-surface">
      <header><div><p>LEGACY DEVICE MIGRATION</p><h1>Legacy Home Link</h1></div><button type="button" data-home-link-close aria-label="Close Legacy Home Link">×</button></header>
      <div class="home-link-body">
        <section class="home-link-hero">
          <span class="home-link-hero-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <div><h2>${linked ? "Your original browser link remains active." : "Pair only when preserving an existing Home Link."}</h2><p>${linked
            ? "This browser still proves signed presence with the first Greenways Home Node protocol. Keep it only while exporting or recovering its device identity."
            : "Enter a one-time code from the compatibility Home Node. This flow exists so old browser keys and signed records are not abandoned."}</p></div>
        </section>
        ${linked ? `<div class="home-link-metrics">
          <div><strong>${escapeHtml(homeStatus?.browsers?.length ?? "—")}</strong><span>legacy browsers</span></div>
          <div><strong>${escapeHtml((homeStatus?.services ?? connection.services).length)}</strong><span>compatibility services</span></div>
          <div><strong>Signed</strong><span>device presence</span></div>
        </div>
        <dl class="home-link-identity"><div><dt>Legacy node</dt><dd>${escapeHtml(connection.node.name)}</dd></div><div><dt>Origin</dt><dd>${escapeHtml(connection.origin)}</dd></div><div><dt>This browser</dt><dd>${escapeHtml(connection.device.name)}</dd></div></dl>
        <section class="home-link-list"><div class="home-link-list__heading"><p>LEGACY SERVICE DESCRIPTORS</p><span>Compatibility only</span></div>${serviceRows()}</section>
        <section class="home-link-list"><div class="home-link-list__heading"><p>PAIRED BROWSERS</p><span>Signed presence</span></div>${browserRows()}</section>
        <div class="home-link-actions"><button type="button" data-home-link-refresh ${busy ? "disabled" : ""}>${busy ? "Checking legacy node…" : "Refresh legacy presence"}</button><button type="button" data-home-link-disconnect ${busy ? "disabled" : ""}>Remove legacy link</button></div>`
          : `<form class="home-link-form">
          <label>Legacy Home Node origin<input name="origin" type="url" required value="${DEFAULT_HOME_ORIGIN}" placeholder="https://home.example"></label>
          <label>Browser name<input name="name" type="text" maxlength="80" required value="${escapeHtml(browserName())}"></label>
          <label>One-time pairing code<input name="code" type="text" inputmode="text" maxlength="9" autocomplete="one-time-code" required placeholder="ABCD-EFGH"></label>
          <button type="submit" ${busy ? "disabled" : ""}>${busy ? "Pairing legacy browser…" : "Pair legacy Home Link"}</button>
        </form>
        <div class="home-link-boundary"><strong>Compatibility is not the new architecture.</strong><span>The original Home Link remains isolated so existing browser keys can be recovered or migrated.</span></div>`}
        ${notice ? `<p class="home-link-notice" data-tone="${escapeHtml(noticeTone)}" role="status">${escapeHtml(notice)}</p>` : ""}
        <p class="home-link-footnote">Legacy service descriptors remain inert data. Greenways OS never evaluates remote JavaScript, Wasm, HAL, HTML or executable UI supplied by the compatibility node.</p>
      </div>
    </section>`;
    frame.querySelector("[data-home-link-close]")?.addEventListener("click", closeSurface);
    frame.querySelector(".home-link-form")?.addEventListener("submit", pair);
    frame.querySelector("[data-home-link-refresh]")?.addEventListener("click", refresh);
    frame.querySelector("[data-home-link-disconnect]")?.addEventListener("click", disconnect);
  }

  async function pair(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const origin = String(form.get("origin") ?? "");
    const name = String(form.get("name") ?? "");
    const code = String(form.get("code") ?? "");
    busy = true;
    notice = "Requesting access to the legacy Home Node origin…";
    noticeTone = "quiet";
    render();
    let requestedOrigin = null;
    let permissionGranted = false;
    let pairedRecord = null;
    let client = null;
    try {
      client = new HomeLinkClient({ origin });
      requestedOrigin = client.origin;
      await requestHomeOriginAccess(requestedOrigin);
      permissionGranted = true;
      const discovery = await client.discover();
      if (!discovery.pairing.available) throw new Error("This compatibility node is not currently accepting a browser pairing");
      const device = await createHomeDevice(name);
      const receipt = await client.pair({ code, device, node: discovery.node });
      if (receipt.node.id !== discovery.node.id) throw new Error("Legacy Home discovery changed during pairing");
      pairedRecord = createHomeLinkRecord({ origin: requestedOrigin, receipt, device });
      await withOriginLock(HOME_LINK_LOCK, () => store.put("settings", HOME_LINK_SETTINGS_KEY, pairedRecord));
      connection = pairedRecord;
      try {
        homeStatus = assertConnectionNode(
          await client.status(pairedRecord, statusPresence()),
          pairedRecord,
        );
        notice = "The legacy browser link is paired. Its private signing key remains local.";
        noticeTone = "good";
      } catch (statusError) {
        homeStatus = null;
        notice = `The legacy link is paired, but presence is not yet available: ${statusError?.message || statusError}`;
        noticeTone = "quiet";
      }
      scheduleDecoration();
    } catch (error) {
      if (pairedRecord && !connection && client) {
        await client.unpair(pairedRecord).catch(() => {});
      }
      if (permissionGranted && !connection && requestedOrigin) {
        await revokeHomeOriginAccess(requestedOrigin).catch(() => {});
      }
      notice = error?.message || "This browser could not pair with the compatibility node.";
      noticeTone = "error";
    } finally {
      busy = false;
      render();
    }
  }

  async function refresh() {
    if (!connection || busy) return;
    busy = true;
    notice = "Sending signed legacy browser presence…";
    noticeTone = "quiet";
    render();
    try {
      homeStatus = assertConnectionNode(
        await new HomeLinkClient({ origin: connection.origin }).status(connection, statusPresence()),
        connection,
      );
      notice = `The compatibility node confirmed ${homeStatus.browsers.length} paired browser${homeStatus.browsers.length === 1 ? "" : "s"}.`;
      noticeTone = "good";
      scheduleDecoration();
    } catch (error) {
      notice = error?.message || "The compatibility node could not confirm this browser.";
      noticeTone = "error";
    } finally {
      busy = false;
      render();
    }
  }

  async function disconnect() {
    if (!connection || busy) return;
    busy = true;
    notice = "Removing this browser's legacy Home Link…";
    noticeTone = "quiet";
    render();
    const previous = connection;
    let remoteError = null;
    try {
      await new HomeLinkClient({ origin: previous.origin }).unpair(previous);
    } catch (error) {
      remoteError = error;
    }
    let permissionError = null;
    try {
      await revokeHomeOriginAccess(previous.origin);
    } catch (error) {
      permissionError = error;
    }
    try {
      await withOriginLock(HOME_LINK_LOCK, () => store.delete("settings", HOME_LINK_SETTINGS_KEY));
      connection = null;
      homeStatus = null;
      notice = permissionError
        ? `The legacy link was removed, but Chrome origin access still needs attention: ${permissionError.message}`
        : remoteError
          ? "The local legacy link was removed. The unreachable compatibility node may retain a stale public device entry."
          : "The legacy Home Link was removed. Other local Greenways records were not changed.";
      noticeTone = permissionError ? "error" : remoteError ? "quiet" : "good";
      scheduleDecoration();
    } catch (error) {
      notice = error?.message || "The legacy Home Link could not be removed.";
      noticeTone = "error";
    } finally {
      busy = false;
      render();
    }
  }

  function keydown(event) {
    if (event.key === "Escape") closeSurface();
  }

  overlay.querySelector(".world-surface-scrim")?.addEventListener("click", closeSurface);
  window.addEventListener("keydown", keydown);
  render();
  frame.querySelector("button, input")?.focus();

  if (connection) refresh();

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
  const otherSurface = surfaceRoot.querySelector(".world-surface-overlay:not([data-home-link-overlay]) .world-surface-scrim");
  otherSurface?.click();
  mountedSurface = createSurface();
}

appRoot?.addEventListener("click", (event) => {
  const action = event.target.closest?.("[data-home-node-action]");
  if (!action || action.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  openSurface();
}, true);

if (appRoot) {
  new MutationObserver(scheduleDecoration).observe(appRoot, { childList: true, subtree: true });
  window.addEventListener("focus", scheduleDecoration);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleDecoration();
  });

  readLocalState().catch((error) => {
    console.error("Legacy Greenways Home Link could not read local state", error);
    scheduleDecoration();
  });
  scheduleDecoration();
}
