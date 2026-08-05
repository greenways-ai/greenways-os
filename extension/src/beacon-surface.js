import {
  BEACON_LINK_PROTOCOL,
  BEACON_SETTINGS_KEY,
  BeaconClient,
  createBeaconRecord,
  normalizeBeaconDescriptor,
  normalizeBeaconOrigin,
  normalizeSpaceDescriptor,
  privateSpaceCapabilitiesEnabled,
  requestBeaconOriginAccess,
  revokeBeaconOriginAccess,
} from "./beacon-client.js";
import { store, withOriginLock } from "./storage.js";

const appRoot = document.querySelector("#launcher-app");
const surfaceRoot = document.querySelector("#launcher-surfaces");
const BEACON_LOCK = "beacon";
const DEFAULT_BEACON_ORIGIN = "http://127.0.0.1:58100";

let connection = null;
let mountedSurface = null;
let decorateScheduled = false;
let lastError = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function normalizeStoredConnection(value) {
  if (!value) return null;
  if (value.protocol !== BEACON_LINK_PROTOCOL) {
    throw new Error("Stored Beacon link uses an unsupported protocol");
  }
  return Object.freeze({
    protocol: BEACON_LINK_PROTOCOL,
    origin: normalizeBeaconOrigin(value.origin),
    descriptor: normalizeBeaconDescriptor(value.descriptor),
    space: normalizeSpaceDescriptor(value.space),
    connectedAt: typeof value.connectedAt === "string"
      ? value.connectedAt
      : new Date().toISOString(),
  });
}

function serviceNames(space) {
  const names = space?.services?.map(({ name }) => name) ?? [];
  return names.length ? names.join(" · ") : "No Space services discovered";
}

function model() {
  if (!connection) {
    return {
      state: lastError ? "degraded" : "local",
      label: lastError ? "Unavailable" : "Not connected",
      title: "A local way into Greenways Space.",
      description: lastError
        ? "Beacon was not reachable. Greenways OS remains fully local; start the Hoplite service and try again when you are ready."
        : "Beacon is a Hara application on Hoplite. It gives this browser one inspectable route to greenways.space without becoming the browser kernel or another Hestia authority.",
      runtime: "Hoplite · Hara · Nginx",
      services: "Hestia · Ignatius · Historia",
      trust: "No Space trust yet",
      action: "Connect Beacon",
    };
  }

  const signed = privateSpaceCapabilitiesEnabled(connection.space);
  return {
    state: lastError ? "degraded" : (signed ? "trusted" : "connected"),
    label: lastError ? "Degraded" : (signed ? "Space verified" : "Space visible"),
    title: lastError
      ? "Beacon is keeping the last known Space catalogue."
      : "Beacon can see Greenways Space.",
    description: lastError
      ? "The last validated catalogue remains visible, but new Space calls should wait until the fixed HTTPS route is healthy again."
      : signed
        ? "The Space catalogue is signed, so locally approved applications may request its named capabilities through Beacon."
        : "Hestia, Ignatius and Historia are visible as inert development metadata. Private service actions remain disabled until Space publishes a signed catalogue.",
    runtime: `${connection.descriptor.runtime.applicationServer} · ${connection.descriptor.runtime.language} · ${connection.descriptor.runtime.edge}`,
    services: serviceNames(connection.space),
    trust: signed ? "Signed catalogue" : "Unsigned development catalogue",
    action: "Manage Beacon",
  };
}

function sectionMarkup(current) {
  return `<section class="beacon-card" data-beacon data-state="${escapeHtml(current.state)}" aria-labelledby="beacon-heading">
    <header class="beacon-card__header">
      <p>GREENWAYS BEACON / LOCAL HOPLITE GATEWAY</p>
      <span class="beacon-card__state" data-state="${escapeHtml(current.state)}"><i></i>${escapeHtml(current.label)}</span>
    </header>
    <div class="beacon-card__body">
      <div class="beacon-card__copy">
        <h2 id="beacon-heading">${escapeHtml(current.title)}</h2>
        <p>${escapeHtml(current.description)}</p>
      </div>
      <div class="beacon-card__diagram" data-state="${escapeHtml(current.state)}" aria-label="This browser connects through Greenways Beacon to Greenways Space">
        <span class="beacon-card__node beacon-card__node--browser">THIS BROWSER</span>
        <i class="beacon-card__path beacon-card__path--local"></i>
        <span class="beacon-card__node beacon-card__node--beacon"><b></b>BEACON</span>
        <i class="beacon-card__path beacon-card__path--space"></i>
        <span class="beacon-card__node beacon-card__node--space">GREENWAYS.SPACE</span>
      </div>
    </div>
    <dl class="beacon-card__register">
      <div><dt>Runtime</dt><dd>${escapeHtml(current.runtime)}</dd></div>
      <div><dt>Space services</dt><dd title="${escapeHtml(current.services)}">${escapeHtml(current.services)}</dd></div>
      <div><dt>Trust</dt><dd>${escapeHtml(current.trust)}</dd></div>
    </dl>
    <div class="beacon-card__actions">
      <button type="button" data-beacon-open>${escapeHtml(current.action)}</button>
      <span>Transport approval is not service authority.</span>
    </div>
  </section>`;
}

function placeSection() {
  decorateScheduled = false;
  const shell = appRoot?.querySelector(".launcher-shell");
  const intro = shell?.querySelector(".launcher-intro");
  if (!shell || !intro) return;

  const current = model();
  const signature = JSON.stringify([
    current.state,
    current.label,
    current.title,
    current.description,
    current.runtime,
    current.services,
    current.trust,
    current.action,
  ]);
  let section = shell.querySelector("[data-beacon]");

  if (!section || section.dataset.signature !== signature) {
    const template = document.createElement("template");
    template.innerHTML = sectionMarkup(current).trim();
    const replacement = template.content.firstElementChild;
    replacement.dataset.signature = signature;
    replacement.querySelector("[data-beacon-open]")?.addEventListener("click", openSurface);
    if (section) section.replaceWith(replacement);
    else intro.insertAdjacentElement("afterend", replacement);
    section = replacement;
  }

  // The legacy Home Link decorator is asynchronous. Keep Beacon immediately
  // above it whenever that compatibility surface appears or is re-rendered.
  const legacy = shell.querySelector("[data-home-node]");
  if (legacy && section.nextElementSibling !== legacy) legacy.before(section);
  else if (!legacy && intro.nextElementSibling !== section) intro.after(section);
}

function scheduleDecoration() {
  if (decorateScheduled) return;
  decorateScheduled = true;
  queueMicrotask(placeSection);
}

async function readLocalState() {
  const stored = await store.get("settings", BEACON_SETTINGS_KEY);
  try {
    connection = normalizeStoredConnection(stored);
    lastError = null;
  } catch (error) {
    connection = null;
    lastError = error;
  }
  scheduleDecoration();
}

function closeSurface() {
  mountedSurface?.destroy();
  mountedSurface = null;
}

function serviceRows() {
  const services = connection?.space?.services ?? [];
  if (!services.length) {
    return `<p class="beacon-empty">Connect Beacon to discover the services composed by Greenways Space.</p>`;
  }
  return `<div class="beacon-services">${services.map((service) => `<article>
    <span class="beacon-service-mark" aria-hidden="true"></span>
    <span><strong>${escapeHtml(service.name)}</strong><small>${escapeHtml(service.role)} · ${escapeHtml(service.authority)}</small></span>
    <em>${escapeHtml(service.status)}</em>
    <p>${escapeHtml(service.capabilities.join(" · "))}</p>
  </article>`).join("")}</div>`;
}

function createSurface() {
  let active = true;
  let busy = false;
  let notice = lastError?.message ?? "";
  let noticeTone = lastError ? "error" : "quiet";

  const overlay = document.createElement("div");
  overlay.className = "world-surface-overlay beacon-overlay";
  overlay.dataset.beaconOverlay = "true";
  overlay.innerHTML = `<button class="world-surface-scrim" type="button" aria-label="Close Greenways Beacon"></button>
    <div class="world-surface-frame beacon-frame" role="dialog" aria-modal="true" aria-label="Greenways Beacon"></div>`;
  surfaceRoot.append(overlay);
  const frame = overlay.querySelector(".beacon-frame");

  function render() {
    if (!active) return;
    const connected = Boolean(connection);
    const signed = privateSpaceCapabilitiesEnabled(connection?.space);
    const serviceCount = connection?.space?.services?.length ?? 0;

    frame.innerHTML = `<section class="beacon-surface">
      <header><div><p>LOCAL HOPLITE GATEWAY</p><h1>Greenways Beacon</h1></div><button type="button" data-beacon-close aria-label="Close Greenways Beacon">×</button></header>
      <div class="beacon-body">
        <section class="beacon-hero">
          <span class="beacon-hero-mark" aria-hidden="true"><i></i><i></i><i></i></span>
          <div><h2>${connected ? "A local edge for your connected worlds." : "Connect this browser to its local Beacon."}</h2><p>${connected
            ? "Beacon runs as Hara on Hoplite and provides a fixed, certificate-verified route to greenways.space. Space composes Hestia, Ignatius and other services; Beacon does not absorb their authority."
            : "Enter the loopback origin of the Beacon running on this machine. Greenways OS requests access only to that origin, verifies the Beacon descriptor, then reads the inert Space catalogue through its fixed route."}</p></div>
        </section>
        ${connected ? `<div class="beacon-metrics">
          <div><strong>Hoplite</strong><span>local application server</span></div>
          <div><strong>${escapeHtml(serviceCount)}</strong><span>Space services</span></div>
          <div><strong>${signed ? "Signed" : "Unsigned"}</strong><span>catalogue trust</span></div>
        </div>
        <dl class="beacon-identity">
          <div><dt>Beacon</dt><dd>${escapeHtml(connection.origin)}</dd></div>
          <div><dt>Runtime</dt><dd>${escapeHtml(connection.descriptor.runtime.namespace)} · ${escapeHtml(connection.descriptor.runtime.edge)}</dd></div>
          <div><dt>Space</dt><dd>${escapeHtml(connection.descriptor.space.origin)}</dd></div>
          <div><dt>Revision</dt><dd>${escapeHtml(connection.space.revision)}</dd></div>
        </dl>
        <section class="beacon-list"><div class="beacon-list__heading"><p>GREENWAYS SPACE SERVICES</p><span>Inert descriptors</span></div>${serviceRows()}</section>
        <div class="beacon-trust" data-signed="${signed}"><strong>${signed ? "Private capabilities may be requested." : "Private capabilities remain disabled."}</strong><span>${signed
          ? "The Space catalogue declares a signed trust state. Browser applications still require local capability approval before making a service call."
          : "The current catalogue is unsigned development metadata. Hestia and Ignatius are visible, but reachability through Beacon is not authentication or permission."}</span></div>
        <div class="beacon-actions"><button type="button" data-beacon-refresh ${busy ? "disabled" : ""}>${busy ? "Checking route…" : "Refresh Space"}</button><button type="button" data-beacon-disconnect ${busy ? "disabled" : ""}>Disconnect Beacon</button></div>`
          : `<form class="beacon-form">
          <label>Beacon origin<input name="origin" type="url" required value="${DEFAULT_BEACON_ORIGIN}" placeholder="http://127.0.0.1:58100"></label>
          <button type="submit" ${busy ? "disabled" : ""}>${busy ? "Verifying Beacon…" : "Connect Beacon"}</button>
        </form>
        <div class="beacon-trust" data-signed="false"><strong>Beacon is a gateway, not an account.</strong><span>The browser keeps its own kernel and app approvals. Beacon may transport explicit Space requests, but it cannot install extension code or turn Hestia and Ignatius into ambient authority.</span></div>`}
        ${notice ? `<p class="beacon-notice" data-tone="${escapeHtml(noticeTone)}" role="status">${escapeHtml(notice)}</p>` : ""}
        <p class="beacon-footnote">Descriptors from Beacon and Space are validated as inert data. JavaScript, Wasm, HAL, HTML, modules, source and executable entrypoints are rejected.</p>
      </div>
    </section>`;

    frame.querySelector("[data-beacon-close]")?.addEventListener("click", closeSurface);
    frame.querySelector(".beacon-form")?.addEventListener("submit", connect);
    frame.querySelector("[data-beacon-refresh]")?.addEventListener("click", refresh);
    frame.querySelector("[data-beacon-disconnect]")?.addEventListener("click", disconnect);
  }

  async function connect(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const originInput = String(form.get("origin") ?? "");
    busy = true;
    notice = "Requesting access to the local Beacon origin…";
    noticeTone = "quiet";
    render();

    let origin = null;
    let permissionGranted = false;
    try {
      const client = new BeaconClient({ origin: originInput });
      origin = client.origin;
      await requestBeaconOriginAccess(origin);
      permissionGranted = true;
      const { descriptor, space } = await client.inspect();
      const record = createBeaconRecord({ origin, descriptor, space });
      await withOriginLock(BEACON_LOCK, () => (
        store.put("settings", BEACON_SETTINGS_KEY, record)
      ));
      connection = record;
      lastError = null;
      notice = privateSpaceCapabilitiesEnabled(space)
        ? "Beacon and the signed Space catalogue are available."
        : "Beacon is connected. Space discovery is unsigned development metadata, so private capabilities remain disabled.";
      noticeTone = "good";
      scheduleDecoration();
    } catch (error) {
      if (permissionGranted && !connection && origin) {
        await revokeBeaconOriginAccess(origin).catch(() => {});
      }
      lastError = error;
      notice = error?.message || "Greenways Beacon could not be connected.";
      noticeTone = "error";
      scheduleDecoration();
    } finally {
      busy = false;
      render();
    }
  }

  async function refresh() {
    if (!connection || busy) return;
    busy = true;
    notice = "Checking Beacon and its fixed Space route…";
    noticeTone = "quiet";
    render();
    try {
      const client = new BeaconClient({ origin: connection.origin });
      const { descriptor, space } = await client.inspect();
      const record = createBeaconRecord({ origin: connection.origin, descriptor, space });
      await withOriginLock(BEACON_LOCK, () => (
        store.put("settings", BEACON_SETTINGS_KEY, record)
      ));
      connection = record;
      lastError = null;
      notice = privateSpaceCapabilitiesEnabled(space)
        ? "Beacon refreshed a signed Space catalogue."
        : "Beacon refreshed the unsigned development catalogue. Private capabilities remain disabled.";
      noticeTone = "good";
    } catch (error) {
      lastError = error;
      notice = error?.message || "Beacon could not refresh Greenways Space.";
      noticeTone = "error";
    } finally {
      busy = false;
      scheduleDecoration();
      render();
    }
  }

  async function disconnect() {
    if (!connection || busy) return;
    busy = true;
    notice = "Removing this browser's Beacon route…";
    noticeTone = "quiet";
    render();
    const previous = connection;
    try {
      await revokeBeaconOriginAccess(previous.origin);
      await withOriginLock(BEACON_LOCK, () => (
        store.delete("settings", BEACON_SETTINGS_KEY)
      ));
      connection = null;
      lastError = null;
      notice = "Beacon access was removed. Greenways OS remains available locally.";
      noticeTone = "good";
      scheduleDecoration();
    } catch (error) {
      notice = error?.message || "Beacon access could not be removed.";
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
  const other = surfaceRoot.querySelector(
    ".world-surface-overlay:not([data-beacon-overlay]) .world-surface-scrim",
  );
  other?.click();
  mountedSurface = createSurface();
}

if (appRoot && surfaceRoot) {
  new MutationObserver(scheduleDecoration).observe(appRoot, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("focus", scheduleDecoration);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleDecoration();
  });
  readLocalState().catch((error) => {
    lastError = error;
    scheduleDecoration();
  });
  scheduleDecoration();
}
