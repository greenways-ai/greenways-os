import {
  BUILTIN_APPS,
  SYSTEM_APP_IDS,
  getAppManifest,
  validateAppManifest,
} from "./app-catalog.js";
import {
  HestiaClient,
  requestOriginAccess,
  revokeOriginAccess,
} from "./hestia-client.js";
import { sameManifestApproval } from "./app-launch.js";
import { KernelClient } from "./kernel-client.js";
import { store, withOriginLock } from "./storage.js";
import { SurfaceHost } from "./surface-host.js";
import { EffectRuntime } from "./world-session.js";

const appRoot = document.querySelector("#launcher-app");
const surfaceRoot = document.querySelector("#launcher-surfaces");
const systemIds = new Set(SYSTEM_APP_IDS);
const APP_LIFECYCLE_LOCK = "app-lifecycle";
const catalog = BUILTIN_APPS.map((manifest) => {
  validateAppManifest(manifest);
  return manifest;
});

let session;
let surfaceHost;
let status = { tone: "quiet", message: "Starting the local kernel…" };
let connectorConnected = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function appGlyph(manifest) {
  const glyphs = {
    "greenways-home": "⌂",
    "greenways-worlds": "◎",
    historia: "≡",
    "hestia-connector": "◇",
    "hara-playground": "λ",
  };
  return glyphs[manifest.id] || manifest.name.slice(0, 1).toUpperCase();
}

function installedManifests() {
  return session?.state?.apps?.installed ?? [];
}

function isSystemApp(manifest) {
  return systemIds.has(manifest.id) || manifest.category === "system";
}

function fixedManifestById(id) {
  try {
    return getAppManifest(id);
  } catch {
    return null;
  }
}

function requirementLabel(manifest) {
  if (!manifest.requirement) return "Runs in this browser";
  return manifest.requirement.name;
}

function appCard(manifest, { installed, updateAvailable = false }) {
  const system = isSystemApp(manifest);
  return `<article class="app-card" id="app-${escapeHtml(manifest.id)}" data-app-card="${escapeHtml(manifest.id)}">
    <div class="app-icon app-icon--${escapeHtml(manifest.id)}" aria-hidden="true">${escapeHtml(appGlyph(manifest))}</div>
    <div class="app-copy">
      <p>${system ? "SYSTEM" : escapeHtml(manifest.category || "APP")}</p>
      <h2>${escapeHtml(manifest.name)}</h2>
      <span>${escapeHtml(manifest.description)}</span>
    </div>
    <div class="app-meta">
      <span>${escapeHtml(manifest.publisher.name)} · v${escapeHtml(manifest.version)}</span>
      <small>${escapeHtml(requirementLabel(manifest))}</small>
    </div>
    <div class="app-actions">
      ${updateAvailable
        ? `<button class="app-install" type="button" data-update-app="${escapeHtml(manifest.id)}">Approve v${escapeHtml(manifest.version)}</button><button class="app-more" type="button" data-remove-app="${escapeHtml(manifest.id)}" aria-label="Remove ${escapeHtml(manifest.name)}">Remove</button>`
        : installed
        ? `<button class="app-open" type="button" data-open-app="${escapeHtml(manifest.id)}">Open</button>${system ? "" : `<button class="app-more" type="button" data-remove-app="${escapeHtml(manifest.id)}" aria-label="Remove ${escapeHtml(manifest.name)}">Remove</button>`}`
        : `<button class="app-install" type="button" data-install-app="${escapeHtml(manifest.id)}">Install locally</button>`}
    </div>
  </article>`;
}

function mosaicMark() {
  const cells = ["0011100", "0100010", "1000001", "1001111", "1000001", "0100010", "0011100"].join("");
  return `<span class="launcher-mark" aria-hidden="true">${[...cells].map((cell, index) => `<i data-on="${cell}" style="--tone:${index % 5}"></i>`).join("")}</span>`;
}

function render() {
  const installed = installedManifests();
  const installedIds = new Set(installed.map(({ id }) => id));
  const available = catalog.filter(({ id }) => !installedIds.has(id));
  const connected = connectorConnected;
  appRoot.innerHTML = `<div class="launcher-shell">
    <header class="launcher-header">
      <div class="launcher-brand">${mosaicMark()}<span><strong>Greenways OS</strong><small>YOUR LOCAL PARTICIPATION KERNEL</small></span></div>
      <span class="kernel-state"><i></i>Local</span>
    </header>
    <section class="launcher-intro">
      <p class="eyebrow">SOVEREIGN FIRST · SOCIAL WHEN INVITED</p>
      <h1>Your browser,<br><em>made inhabitable.</em></h1>
      <p>Install private tools and connectors around one locally owned kernel. Participation is something you choose—not the price of entry.</p>
      <div class="privacy-line"><span><i></i><strong>Local state</strong> stays on this device</span><span>${connected ? "Hestia connected" : "No remote home connected"}</span></div>
    </section>
    <section class="app-section" aria-labelledby="installed-heading">
      <div class="section-heading"><div><p>YOUR SPACE</p><h2 id="installed-heading">Installed apps</h2></div><span>${installed.length} local</span></div>
      <div class="app-grid">${installed.map((approved) => {
        const current = fixedManifestById(approved.id);
        const updateAvailable = !isSystemApp(approved)
          && Boolean(current)
          && !sameManifestApproval(approved, current);
        return appCard(updateAvailable ? current : approved, { installed: true, updateAvailable });
      }).join("")}</div>
    </section>
    <section class="app-section catalog-section" aria-labelledby="catalog-heading">
      <div class="section-heading"><div><p>OPTIONAL SERVICES</p><h2 id="catalog-heading">Add to your browser</h2></div><span>${available.length} available</span></div>
      ${available.length ? `<div class="app-grid">${available.map((manifest) => appCard(manifest, { installed: false })).join("")}</div>` : `<p class="catalog-empty">Every bundled app is installed. Nothing was fetched from a remote store.</p>`}
    </section>
    <p class="launcher-status" data-tone="${escapeHtml(status.tone)}" role="status"><i></i>${escapeHtml(status.message)}</p>
    <footer class="launcher-footer"><span>GREENWAYS / OS</span><span>Local by default · network by consent</span></footer>
  </div>`;

  appRoot.querySelectorAll("[data-open-app]").forEach((button) => button.addEventListener("click", () => openApp(button.dataset.openApp)));
  appRoot.querySelectorAll("[data-install-app]").forEach((button) => button.addEventListener("click", () => installApp(button.dataset.installApp)));
  appRoot.querySelectorAll("[data-update-app]").forEach((button) => button.addEventListener("click", () => updateApp(button.dataset.updateApp)));
  appRoot.querySelectorAll("[data-remove-app]").forEach((button) => button.addEventListener("click", () => removeApp(button.dataset.removeApp)));
}

function setStatus(message, tone = "quiet") {
  status = { message, tone };
  render();
}

function withFreshInstalledApps(operation) {
  return withOriginLock(APP_LIFECYCLE_LOCK, async () => {
    await session.refresh();
    return operation();
  });
}

async function clearHestiaConnection(connection) {
  const current = connection === undefined
    ? await store.get("settings", "hestia")
    : connection;
  if (!current) return;
  await revokeOriginAccess(current.origin);
  await store.delete("settings", "hestia");
  connectorConnected = false;
}

function requireInstalledHestiaConnector() {
  if (!installedManifests().some(({ id }) => id === "hestia-connector")) {
    throw new Error("Hestia Connector is not installed");
  }
}

async function installApp(appId) {
  const manifest = fixedManifestById(appId);
  if (!manifest) return setStatus("That app is not in the bundled catalog.", "error");
  try {
    await withFreshInstalledApps(() => session.dispatch("apps/install", [manifest]));
    setStatus(`${manifest.name} was installed in this browser.`, "good");
  } catch (error) {
    setStatus(error?.message || "The app could not be installed.", "error");
  }
}

async function updateApp(appId) {
  const manifest = fixedManifestById(appId);
  if (!manifest || isSystemApp(manifest)) return setStatus("That app cannot be updated through the optional-app flow.", "error");
  try {
    await withFreshInstalledApps(() => session.dispatch("apps/update", [manifest]));
    setStatus(`${manifest.name} v${manifest.version} was approved in this browser.`, "good");
  } catch (error) {
    setStatus(error?.message || "The app update could not be approved.", "error");
  }
}

async function openApp(appId) {
  const manifest = fixedManifestById(appId);
  if (!manifest) return setStatus("That app is not in the bundled catalog.", "error");
  try {
    setStatus(`Opening ${manifest.name}…`);
    await withFreshInstalledApps(() => session.dispatch("apps/open", [appId]));
    setStatus(`${manifest.name} opened.`, "good");
  } catch (error) {
    setStatus(error?.message || "The app could not be opened.", "error");
  }
}

async function removeApp(appId) {
  const manifest = fixedManifestById(appId);
  if (!manifest || isSystemApp(manifest)) return setStatus("System apps remain installed with the local kernel.", "error");
  try {
    await withFreshInstalledApps(async () => {
      if (appId === "hestia-connector") await clearHestiaConnection();
      await session.dispatch("apps/remove", [appId]);
    });
    setStatus(`${manifest.name} was removed. Its own local records were left intact.`, "good");
  } catch (error) {
    setStatus(error?.message || "The app could not be removed.", "error");
  }
}

function createHestiaConnectorSurface({ root, close }) {
  let active = true;
  let connection = null;
  let outbox = [];
  let notice = "";
  let busy = false;

  function surfaceRender() {
    if (!active) return;
    root.innerHTML = `<section class="hestia-surface" aria-label="Hestia connector">
      <header><div><p>PRIVATE HOME CONNECTOR</p><h1>Hestia</h1></div><button type="button" data-close-surface aria-label="Close Hestia connector">×</button></header>
      <div class="hestia-body">
        <section class="hestia-hero"><span class="hestia-orb">◇</span><div><h2>${connection ? "Your private home is paired." : "Give your browser a home node."}</h2><p>Hestia receives only the signed records you explicitly synchronize. Origin access is requested when you pair—not when Greenways starts.</p></div></section>
        <div class="hestia-metrics"><div><strong>${connection ? "Connected" : "Local only"}</strong><span>connection</span></div><div><strong>${outbox.length}</strong><span>signed records waiting</span></div></div>
        <form class="hestia-form">
          <label>Hestia origin<input name="origin" type="url" required value="${escapeHtml(connection?.origin || "http://127.0.0.1:58080")}" placeholder="https://home.example"></label>
          <label>Scoped device token<input name="token" type="password" ${connection ? "" : "required"} autocomplete="off" placeholder="${connection ? "Leave blank to keep the current token" : "Device token"}"></label>
          <button type="submit" ${busy ? "disabled" : ""}>${busy ? "Checking node…" : connection ? "Update connection" : "Pair this Hestia"}</button>
        </form>
        ${notice ? `<p class="hestia-notice" role="status">${escapeHtml(notice)}</p>` : ""}
        <div class="hestia-actions">
          <button type="button" data-hestia-sync ${!connection || busy ? "disabled" : ""}>Synchronize signed outbox</button>
          ${connection ? `<button type="button" data-hestia-disconnect ${busy ? "disabled" : ""}>Disconnect</button>` : ""}
        </div>
        <p class="hestia-footnote">The device token stays in this extension's local database. Removing the connector does not delete your signed records.</p>
      </div>
    </section>`;
    root.querySelector("[data-close-surface]").addEventListener("click", close);
    root.querySelector(".hestia-form").addEventListener("submit", pair);
    root.querySelector("[data-hestia-sync]")?.addEventListener("click", sync);
    root.querySelector("[data-hestia-disconnect]")?.addEventListener("click", disconnect);
  }

  async function refresh() {
    [connection, outbox] = await Promise.all([
      store.get("settings", "hestia"),
      store.values("outbox"),
    ]);
    connectorConnected = Boolean(connection);
    render();
    surfaceRender();
  }

  async function pair(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const origin = String(data.get("origin"));
    const submittedToken = String(data.get("token"));
    busy = true;
    notice = "Requesting access to this origin…";
    surfaceRender();
    let client = null;
    let requestedOrigin = null;
    let previousOrigin = null;
    let permissionGranted = false;
    try {
      client = new HestiaClient({ origin });
      requestedOrigin = client.origin;
      requireInstalledHestiaConnector();
      await requestOriginAccess(requestedOrigin);
      permissionGranted = true;
      await withFreshInstalledApps(async () => {
        requireInstalledHestiaConnector();
        connection = await store.get("settings", "hestia");
        previousOrigin = connection?.origin ?? null;
        const token = submittedToken || (previousOrigin === requestedOrigin ? connection?.token : null);
        if (!token) {
          throw new Error(previousOrigin && previousOrigin !== requestedOrigin
            ? "A new scoped device token is required when changing Hestia nodes"
            : "A scoped Hestia device token is required");
        }
        await client.discover();
        if (previousOrigin && previousOrigin !== requestedOrigin) {
          await revokeOriginAccess(previousOrigin);
        }
        connection = { origin: requestedOrigin, token };
        await store.put("settings", "hestia", connection);
      });
      connectorConnected = true;
      render();
      notice = "Hestia is paired. Synchronization remains under your control.";
    } catch (error) {
      if (permissionGranted && requestedOrigin !== previousOrigin) {
        await revokeOriginAccess(requestedOrigin).catch(() => {});
      }
      notice = error?.message || "Hestia could not be reached.";
    } finally {
      busy = false;
      surfaceRender();
    }
  }

  async function sync() {
    if (!connection || busy) return;
    busy = true;
    notice = "Checking the local signed outbox…";
    surfaceRender();
    try {
      await withFreshInstalledApps(async () => {
        requireInstalledHestiaConnector();
        [connection, outbox] = await Promise.all([
          store.get("settings", "hestia"),
          store.values("outbox"),
        ]);
        if (!connection) throw new Error("Hestia Connector is not paired");
        if (!outbox.length) {
          notice = "The signed outbox is already synchronized.";
          return;
        }
        const response = await new HestiaClient({ origin: connection.origin }).append(outbox, { deviceToken: connection.token });
        await store.deleteMany("outbox", outbox.map((entry) => entry.inclusion.eventHash));
        notice = `Hestia accepted ${response.accepted ?? outbox.length} signed record${outbox.length === 1 ? "" : "s"}.`;
        outbox = [];
      });
    } catch (error) {
      notice = `${error?.message || "Hestia is unavailable"} The local outbox was kept.`;
    } finally {
      busy = false;
      surfaceRender();
    }
  }

  async function disconnect() {
    if (busy) return;
    busy = true;
    notice = "Revoking this connector's origin access…";
    surfaceRender();
    try {
      await withOriginLock(APP_LIFECYCLE_LOCK, async () => {
        connection = await store.get("settings", "hestia");
        await clearHestiaConnection(connection);
      });
      connection = null;
      notice = "Hestia was disconnected. Local records were not changed.";
      render();
    } catch (error) {
      notice = error?.message || "Hestia could not be disconnected.";
    } finally {
      busy = false;
      surfaceRender();
    }
  }

  refresh().catch((error) => { notice = error?.message || "Local connector state could not be read."; surfaceRender(); });
  surfaceRender();
  return {
    update() {},
    destroy() { active = false; },
  };
}

async function start() {
  const effects = new EffectRuntime()
    .register("ui", "open-surface", ([surfaceId, payload], context) => {
      surfaceHost.open(surfaceId, payload || { appId: surfaceId }, { session: context.session });
    })
    .register("ui", "close-surface", () => surfaceHost.close());

  surfaceHost = new SurfaceHost(surfaceRoot, {
    onRequestClose: () => session?.dispatch("surface/close").catch((error) => setStatus(error?.message || "The interface could not close.", "error")),
  });
  surfaceHost.register("hestia-connector", createHestiaConnectorSurface);
  session = new KernelClient({ clientKind: "launcher", effects });
  session.subscribe((haraState) => {
    const activeSurface = haraState?.surface?.active;
    if (activeSurface === "hestia-connector" && surfaceHost.activeId !== activeSurface) {
      surfaceHost.open(activeSurface, haraState.surface.payload || { appId: activeSurface }, { session });
    } else if (!activeSurface && surfaceHost.activeId) {
      surfaceHost.close();
    } else {
      surfaceHost.update(haraState);
    }
    render();
  });

  render();
  await session.start();
  await withOriginLock(APP_LIFECYCLE_LOCK, async () => {
    const hestia = await store.get("settings", "hestia");
    const connectorInstalled = installedManifests().some(({ id }) => id === "hestia-connector");
    if (hestia && !connectorInstalled) await clearHestiaConnection(hestia);
    else connectorConnected = Boolean(hestia);
  });
  setStatus("Local kernel ready. Network participation is off until you choose it.", "good");
  await handleLaunchIntent();
}

window.addEventListener("beforeunload", () => session?.destroy(), { once: true });

async function handleLaunchIntent() {
  const match = location.hash.match(/^#app-([a-z0-9]+(?:[.-][a-z0-9]+)*)$/);
  const appId = match?.[1];
  const manifest = appId ? fixedManifestById(appId) : null;
  if (!manifest) return;
  if (installedManifests().some(({ id }) => id === appId)) {
    await openApp(appId);
    return;
  }
  setStatus(`Install ${manifest.name} locally to continue. Its capabilities remain off until then.`);
  const card = document.getElementById(`app-${appId}`);
  card?.scrollIntoView({ block: "center" });
  card?.querySelector("[data-install-app]")?.focus();
}

start().catch((error) => {
  console.error("Greenways launcher failed", error);
  appRoot.innerHTML = `<section class="launcher-fatal"><p>LOCAL KERNEL</p><h1>Greenways could not start.</h1><code>${escapeHtml(error?.message || error)}</code></section>`;
});
