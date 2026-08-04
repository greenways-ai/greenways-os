import { store } from "./storage.js";

const appRoot = document.querySelector("#launcher-app");
const HOME_APP_ID = "hestia-connector";
const COPY = {
  eyebrow: "LOCAL KERNEL · PRIVATE HOME · PARTICIPATION BY INVITATION",
  heading: "Bring your browser<br><em>back home.</em>",
  description: "Greenways OS keeps a sovereign kernel inside each browser profile, then gives those profiles a private Hestia home for services, records and agents you control.",
};

let decorateScheduled = false;
let decorationRevision = 0;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function setText(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function setHtml(element, value) {
  if (element && element.innerHTML !== value) element.innerHTML = value;
}

function connectorCard() {
  return appRoot?.querySelector(`[data-app-card="${HOME_APP_ID}"]`) ?? null;
}

function connectorControl(card = connectorCard()) {
  return card?.querySelector(
    "[data-open-app], [data-install-app], [data-update-app]",
  ) ?? null;
}

function connectorInstalled(card = connectorCard()) {
  return Boolean(card?.querySelector("[data-open-app]"));
}

function homeAddress(connection) {
  if (!connection?.origin) return "Not configured";
  try {
    const url = new URL(connection.origin);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return connection.origin;
  }
}

function routeLabel(connection) {
  if (!connection?.origin) return "Local only";
  try {
    const { hostname } = new URL(connection.origin);
    if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      return "This machine";
    }
    if (hostname.endsWith(".local")) return "Home network";
    if (hostname.endsWith(".ts.net")) return "Private mesh";
    return "Private origin";
  } catch {
    return "Private origin";
  }
}

function homeModel({ connection, installed, available }) {
  if (connection) {
    return {
      state: "connected",
      label: "Connected",
      title: "This browser has a private route home.",
      description: "Signed records can move between this browser profile and your Hestia node without making remote participation a condition of use.",
      action: "Open home link",
      address: homeAddress(connection),
      route: routeLabel(connection),
      disabled: !available,
    };
  }

  if (installed) {
    return {
      state: "ready",
      label: "Connector ready",
      title: "Pair this browser with a home node.",
      description: "The local kernel is already usable. Pairing adds a private Hestia authority for Historia, Hara, agents, files and future Home Services.",
      action: "Pair home node",
      address: "Awaiting origin",
      route: "Local only",
      disabled: !available,
    };
  }

  return {
    state: "local",
    label: "Local only",
    title: "Give your browsers a home you control.",
    description: "Enable the bundled Hestia connector to pair this browser profile with a machine in your home. Nothing is exposed publicly and the browser remains useful offline.",
    action: "Enable home connector",
    address: "Not configured",
    route: "Local only",
    disabled: !available,
  };
}

function operatingLayers() {
  const register = document.createElement("div");
  register.className = "intro-register";
  register.setAttribute("aria-label", "Greenways operating layers");
  register.innerHTML = `
    <span><b>01</b> Local browser kernel</span>
    <span><b>02</b> Private home link</span>
    <span><b>03</b> Participation by consent</span>
  `;
  return register;
}

function homeNodeMarkup(model, connection) {
  const origin = connection?.origin || model.address;
  return `<section class="home-node" data-state="${model.state}" data-home-node aria-labelledby="home-node-heading">
    <header class="home-node__header">
      <p class="home-node__kicker">HOME NODE / PRIVATE SERVICE HOST</p>
      <span class="home-node__state" data-state="${model.state}"><i></i>${escapeHtml(model.label)}</span>
    </header>
    <div class="home-node__body">
      <div class="home-node__copy">
        <h2 id="home-node-heading">${escapeHtml(model.title)}</h2>
        <p>${escapeHtml(model.description)}</p>
      </div>
      <div class="home-node__diagram" data-state="${model.state}" aria-hidden="true">
        <span class="home-node__browser">THIS BROWSER</span>
        <i class="home-node__rail"></i>
        <span class="home-node__core"><b></b>HESTIA NODE</span>
        <span class="home-node__service">SIGNED SERVICES</span>
      </div>
    </div>
    <dl class="home-node__register">
      <div><dt>This browser</dt><dd>Local kernel</dd></div>
      <div><dt>Home address</dt><dd title="${escapeHtml(origin)}">${escapeHtml(model.address)}</dd></div>
      <div><dt>Route</dt><dd>${escapeHtml(model.route)}</dd></div>
    </dl>
    <div class="home-node__actions">
      <button type="button" data-home-node-action${model.disabled ? " disabled aria-disabled=\"true\"" : ""}>${escapeHtml(model.action)}</button>
      <a href="#app-${HOME_APP_ID}">Inspect the Hestia connector</a>
    </div>
  </section>`;
}

function waitForControl(predicate, timeout = 4_000) {
  const current = connectorControl();
  if (predicate(current)) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const control = connectorControl();
      if (!predicate(control)) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve(control);
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("The Hestia connector did not become ready"));
    }, timeout);
    observer.observe(appRoot, { childList: true, subtree: true });
  });
}

async function openHomeNode() {
  const card = connectorCard();
  const control = connectorControl(card);
  if (!control || control.disabled) return;

  if (control.matches("[data-install-app]")) {
    control.click();
    const open = await waitForControl((candidate) => (
      candidate?.matches("[data-open-app]") && !candidate.disabled
    ));
    open.click();
    return;
  }

  if (control.matches("[data-open-app]")) control.click();
}

function decorateIntro(shell) {
  const intro = shell.querySelector(".launcher-intro");
  if (!intro) return;

  setText(intro.querySelector(".eyebrow"), COPY.eyebrow);
  setHtml(intro.querySelector("h1"), COPY.heading);
  setText(intro.querySelector(":scope > p:not(.eyebrow)"), COPY.description);
  if (!intro.querySelector(".intro-register")) intro.append(operatingLayers());
}

async function decorateLauncher() {
  decorateScheduled = false;
  const revision = ++decorationRevision;
  const shell = appRoot?.querySelector(".launcher-shell");
  if (!shell) return;

  decorateIntro(shell);

  const card = connectorCard();
  const control = connectorControl(card);
  const [connection] = await Promise.all([
    store.get("settings", "hestia").catch(() => null),
  ]);
  if (revision !== decorationRevision || !shell.isConnected) return;

  const model = homeModel({
    connection,
    installed: connectorInstalled(card),
    available: Boolean(control && !control.disabled),
  });
  const signature = JSON.stringify([
    model.state,
    model.label,
    model.address,
    model.route,
    model.action,
    model.disabled,
  ]);
  const existing = shell.querySelector("[data-home-node]");

  if (!existing || existing.dataset.signature !== signature) {
    existing?.remove();
    const template = document.createElement("template");
    template.innerHTML = homeNodeMarkup(model, connection).trim();
    const homeNode = template.content.firstElementChild;
    homeNode.dataset.signature = signature;
    homeNode.querySelector("[data-home-node-action]")
      ?.addEventListener("click", () => openHomeNode().catch(() => {}));
    shell.querySelector(".launcher-intro")?.insertAdjacentElement("afterend", homeNode);
  }

  const privacy = shell.querySelector(".privacy-line span:last-child");
  setText(
    privacy,
    connection
      ? `Paired with ${homeAddress(connection)}`
      : "No remote service is trusted by default",
  );
}

function scheduleDecoration() {
  if (decorateScheduled) return;
  decorateScheduled = true;
  queueMicrotask(() => decorateLauncher().catch(() => {
    decorateScheduled = false;
  }));
}

if (appRoot) {
  new MutationObserver(scheduleDecoration).observe(appRoot, {
    childList: true,
    subtree: true,
  });
  window.addEventListener("focus", scheduleDecoration);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) scheduleDecoration();
  });
  scheduleDecoration();
}
