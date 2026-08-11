import {
  SYSTEM_APP_IDS,
  getBuiltinAppCatalog,
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
import { createUserscriptsSurface } from "./userscripts-surface.js";
import { createChatsSurface } from "./chats-surface.js";
import { createChatgptProviderSurface } from "./chatgpt-provider-surface.js";
import { EffectRuntime } from "./world-session.js";
import { GreenwaysKeyring } from "./keyring.js";
import { openKeyringSurface } from "./keyring-surface.js";
import {
  LAUNCHER_ROUTES,
  appShellMarkup,
  routeFromHash,
} from "./app-shell.js";

const appRoot = document.querySelector("#launcher-app");
const surfaceRoot = document.querySelector("#launcher-surfaces");
const systemIds = new Set(SYSTEM_APP_IDS);
const APP_LIFECYCLE_LOCK = "app-lifecycle";
let catalog = [];

let session;
let surfaceHost;
let status = { tone: "quiet", message: "Starting the local kernel…" };
let connectorConnected = false;
let kernelReady = false;
const keyring = new GreenwaysKeyring();
let keyringSnapshot = { controller: null, providerProfiles: [] };
let renderedRoute;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function appGlyph(manifest) {
  const glyphs = {
    "greenways-worlds": "◎",
    chats: "≡",
    "chatgpt-provider": "✦",
    userscripts: "⌁",
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

function appRow(manifest, { installed, updateAvailable = false }) {
  const system = isSystemApp(manifest);
  const disabled = kernelReady ? "" : ' disabled aria-disabled="true"';
  return `<article class="gw-row" id="app-${escapeHtml(manifest.id)}" data-app-card="${escapeHtml(manifest.id)}">
    <div class="gw-row__main"><span class="gw-row__icon" aria-hidden="true">${escapeHtml(appGlyph(manifest))}</span><div class="gw-row__copy">
      <h3>${escapeHtml(manifest.name)}</h3>
      <span>${escapeHtml(manifest.publisher.name)} · ${escapeHtml(requirementLabel(manifest))} · v${escapeHtml(manifest.version)}</span>
    </div></div>
    <div class="gw-row__actions">
      ${updateAvailable
        ? `<button class="gw-button gw-button--primary" type="button" data-update-app="${escapeHtml(manifest.id)}"${disabled}>Approve v${escapeHtml(manifest.version)}</button><button class="gw-button gw-button--danger" type="button" data-remove-app="${escapeHtml(manifest.id)}" aria-label="Remove ${escapeHtml(manifest.name)}"${disabled}>Remove</button>`
        : installed
        ? `<button class="gw-button" type="button" data-open-app="${escapeHtml(manifest.id)}"${disabled}>Open</button>${system ? "" : `<button class="gw-button gw-button--danger" type="button" data-remove-app="${escapeHtml(manifest.id)}" aria-label="Remove ${escapeHtml(manifest.name)}"${disabled}>Remove</button>`}`
        : `<button class="gw-button gw-button--primary" type="button" data-install-app="${escapeHtml(manifest.id)}"${disabled}>Install locally</button>`}
    </div>
  </article>`;
}

function pageHeader(title, description) {
  return `<header class="gw-page__header"><h2>${title}</h2><p>${description}</p></header>`;
}

function homePage(installed, available) {
  return `${pageHeader("Greenways OS", "Your local browser system at a glance.")}<div class="gw-settings">
    <section><h3>System</h3><div class="gw-group">
      <div class="gw-row"><div class="gw-row__main"><span class="gw-row__icon">λ</span><div class="gw-row__copy"><strong>Kernel</strong><span>Resident Hara runtime</span></div></div><span class="gw-row__value">${kernelReady ? "Ready" : "Starting…"}</span></div>
      <div class="gw-row"><div class="gw-row__main"><span class="gw-row__icon">▦</span><div class="gw-row__copy"><strong>Apps</strong><span>${installed.length} installed · ${available.length} available</span></div></div><a class="gw-button" href="launcher.html#apps">Manage</a></div>
      <div class="gw-row"><div class="gw-row__main"><span class="gw-row__icon">⌁</span><div class="gw-row__copy"><strong>Keyring</strong><span>Local signing identity and session credentials</span></div></div><a class="gw-button" href="launcher.html#keyring">Open</a></div>
    </div></section>
    <section><h3>Privacy</h3><div class="gw-group"><div class="gw-row"><div class="gw-row__copy"><strong>Local by default</strong><span>Network services remain off until you explicitly connect them.</span></div><span class="gw-row__value">${connectorConnected ? "Hestia connected" : "No remote home"}</span></div></div></section>
  </div>`;
}

function appsPage(installed, available) {
  return `${pageHeader("Apps", "Install and manage capabilities bundled with this build.")}<div class="gw-settings">
    <section aria-label="Installed apps"><h3>Installed</h3><div class="gw-group">${installed.length ? installed.map((approved) => {
      const current = fixedManifestById(approved.id);
      const updateAvailable = !isSystemApp(approved) && Boolean(current) && !sameManifestApproval(approved, current);
      return appRow(updateAvailable ? current : approved, { installed: true, updateAvailable });
    }).join("") : '<p class="gw-empty">No apps are installed.</p>'}</div></section>
    <section aria-label="Available apps"><h3>Available</h3><div class="gw-group">${available.length ? available.map((manifest) => appRow(manifest, { installed: false })).join("") : '<p class="gw-empty">Every bundled app is installed.</p>'}</div></section>
  </div>`;
}

function connectionsPage(installedIds) {
  const disabled = kernelReady ? "" : " disabled";
  const hestiaInstalled = installedIds.has("hestia-connector");
  return `${pageHeader("Connections", "Optional services require explicit permission and remain subordinate to local keys.")}<div class="gw-settings"><section><h3>Services</h3><div class="gw-group">
    <div class="gw-row"><div class="gw-row__main"><span class="gw-row__icon">T</span><div class="gw-row__copy"><strong>Tahto</strong><span>Application-state fabric</span></div></div><button class="gw-button" data-open-tahto${disabled}>Configure</button></div>
    <div class="gw-row"><div class="gw-row__main"><span class="gw-row__icon">H</span><div class="gw-row__copy"><strong>Hestia</strong><span>Private signed-record synchronization</span></div></div>${hestiaInstalled ? `<button class="gw-button" data-open-app="hestia-connector"${disabled}>${connectorConnected ? "Manage" : "Connect"}</button>` : `<button class="gw-button" data-install-app="hestia-connector"${disabled}>Install</button>`}</div>
    <div class="gw-row"><div class="gw-row__main"><span class="gw-row__icon">↺</span><div class="gw-row__copy"><strong>Legacy Home Link</strong><span>Compatibility and identity migration only</span></div></div><button class="gw-button" data-open-home-link${disabled}>Configure</button></div>
  </div></section></div>`;
}

function generalPage() {
  return `${pageHeader("General", "Greenways follows the browser profile and macOS appearance.")}<div class="gw-settings"><section><h3>Appearance</h3><div class="gw-group">
    <div class="gw-row"><div class="gw-row__copy"><strong>Appearance</strong><span>Automatically follows the operating system</span></div><span class="gw-row__value">System</span></div>
    <div class="gw-row"><div class="gw-row__copy"><strong>App window</strong><span>Compact standalone browser utility</span></div><span class="gw-row__value">920 × 680</span></div>
  </div></section><section><h3>Storage</h3><div class="gw-group"><div class="gw-row"><div class="gw-row__copy"><strong>Browser-local data</strong><span>Packages, keys, and application records stay in this profile.</span></div><span class="gw-row__value">On this Mac</span></div></div></section></div>`;
}

function keyringPage() {
  const controller = keyringSnapshot.controller;
  const profiles = keyringSnapshot.providerProfiles ?? [];
  return `${pageHeader("Keyring", "Manage local identity and temporary provider credentials.")}<div class="gw-settings"><section><h3>Identity</h3><div class="gw-group">
    <div class="gw-row"><div class="gw-row__main"><span class="gw-row__icon">⌁</span><div class="gw-row__copy"><strong>Controller key</strong><span>${controller ? `@${escapeHtml(controller.handle)} · ${escapeHtml(controller.algorithm)}` : "No controller identity has been created"}</span></div></div><button class="gw-button" data-open-keyring>${controller ? "Manage" : "Set Up"}</button></div>
    <div class="gw-row"><div class="gw-row__copy"><strong>Model credentials</strong><span>Credentials are held only for this browser session.</span></div><span class="gw-row__value">${profiles.length} loaded</span></div>
  </div></section></div>`;
}

function aboutPage() {
  const manifest = chrome.runtime.getManifest();
  return `${pageHeader("About", "Greenways OS is a programmable, browser-resident local system.")}<div class="gw-settings"><section><div class="gw-group">
    <div class="gw-row"><div class="gw-row__main"><span class="gw-row__icon"><img src="assets/brand/greenways-small.svg" alt="" width="20" height="20"></span><div class="gw-row__copy"><strong>Greenways OS</strong><span>Resident Hara kernel and bundled applications</span></div></div><span class="gw-row__value">Version ${escapeHtml(manifest.version)}</span></div>
    <div class="gw-row"><div class="gw-row__copy"><strong>Security model</strong><span>Local state, exact package approval, and network access by consent.</span></div><span class="gw-row__value">Manifest V3</span></div>
  </div></section></div>`;
}

function activeLauncherRoute() {
  return location.hash.startsWith("#app-") || location.hash.startsWith("#root-")
    ? "apps"
    : routeFromHash(location.hash, LAUNCHER_ROUTES, "home");
}

function render() {
  const installed = installedManifests();
  const installedIds = new Set(installed.map(({ id }) => id));
  const available = catalog.filter(({ id }) => !installedIds.has(id));
  const route = activeLauncherRoute();
  if (renderedRoute && renderedRoute !== route) {
    surfaceRoot.querySelector("[data-keyring-overlay]")?.remove();
  }
  renderedRoute = route;
  const pages = {
    home: ["Home", "Overview", homePage(installed, available)],
    apps: ["Apps", `${installed.length} installed`, appsPage(installed, available)],
    connections: ["Connections", "Network by consent", connectionsPage(installedIds)],
    general: ["General", "System settings", generalPage()],
    keyring: ["Keyring", "Local authority", keyringPage()],
    about: ["About", `Version ${chrome.runtime.getManifest().version}`, aboutPage()],
  };
  const [title, detail, content] = pages[route] ?? pages.home;
  appRoot.innerHTML = appShellMarkup({
    activeRoute: route,
    title,
    detail,
    content: `<div class="launcher-shell">${content}<div class="launcher-intro" hidden></div></div><p class="gw-inline-status" data-tone="${escapeHtml(status.tone)}" role="status">${escapeHtml(status.message)}</p>`,
    state: kernelReady ? "Local" : "Starting",
    tone: kernelReady ? "good" : status.tone,
  });

  appRoot.querySelectorAll("[data-open-app]").forEach((button) => button.addEventListener("click", () => openApp(button.dataset.openApp)));
  appRoot.querySelectorAll("[data-install-app]").forEach((button) => button.addEventListener("click", () => installApp(button.dataset.installApp)));
  appRoot.querySelectorAll("[data-update-app]").forEach((button) => button.addEventListener("click", () => updateApp(button.dataset.updateApp)));
  appRoot.querySelectorAll("[data-remove-app]").forEach((button) => button.addEventListener("click", () => removeApp(button.dataset.removeApp)));
  appRoot.querySelector("[data-open-keyring]")?.addEventListener("click", () => openKeyringSurface({
    root: surfaceRoot,
    keyring,
    onChanged(next) { keyringSnapshot = next; render(); },
  }).catch((error) => setStatus(error?.message || "The keyring could not open.", "error")));
  appRoot.querySelector("[data-open-tahto]")?.addEventListener("click", () => {
    const delegate = appRoot.querySelector("[data-tahto-open]");
    if (delegate) delegate.click();
    else setStatus("Tahto settings are still loading.", "error");
  });
  appRoot.querySelector("[data-open-home-link]")?.addEventListener("click", () => {
    const delegate = appRoot.querySelector("[data-home-node-action]");
    if (delegate && !delegate.disabled) delegate.click();
    else setStatus("Legacy Home Link is still loading.", "error");
  });
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
  catalog = (await getBuiltinAppCatalog()).map((manifest) => {
    validateAppManifest(manifest);
    return manifest;
  });
  const effects = new EffectRuntime()
    .register("ui", "open-surface", ([surfaceId, payload], context) => {
      surfaceHost.open(surfaceId, payload || { appId: surfaceId }, { session: context.session });
    })
    .register("ui", "close-surface", () => surfaceHost.close());

  surfaceHost = new SurfaceHost(surfaceRoot, {
    onRequestClose: () => session?.dispatch("surface/close").catch((error) => setStatus(error?.message || "The interface could not close.", "error")),
  });
  surfaceHost.register("chats", createChatsSurface);
  surfaceHost.register("chatgpt-provider", createChatgptProviderSurface);
  surfaceHost.register("userscripts", createUserscriptsSurface);
  session = new KernelClient({ clientKind: "launcher", effects });
  session.subscribe((haraState) => {
    const activeSurface = haraState?.surface?.active;
    if (activeSurface && surfaceHost.factories.has(activeSurface) && surfaceHost.activeId !== activeSurface) {
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
  const [hestiaConnection, nextKeyringSnapshot] = await Promise.all([
    store.get("settings", "hestia"),
    keyring.status(),
  ]);
  connectorConnected = Boolean(hestiaConnection);
  keyringSnapshot = nextKeyringSnapshot;
  kernelReady = true;
  setStatus("Local kernel ready. Network participation is off until you choose it.", "good");
  await handleLaunchIntent();
}

window.addEventListener("beforeunload", () => session?.destroy(), { once: true });
window.addEventListener("hashchange", () => {
  render();
  void handleLaunchIntent();
});

async function handleLaunchIntent() {
  const rootMatch = location.hash.match(/^#root-([a-z0-9]+(?:[.-][a-z0-9]+)*)$/);
  if (rootMatch?.[1] === "greenways-devtools") {
    location.assign("devtools.html#kernel");
    return;
  }
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
