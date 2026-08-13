import { DaemonNativeBridge } from "./daemon-bridge.js";

const STATE_COPY = Object.freeze({
  connecting: Object.freeze({ label: "Connecting", tone: "quiet", detail: "Opening the exact local browser session…" }),
  connected: Object.freeze({ label: "Connected", tone: "good", detail: "Chrome is authenticated to the local Greenways daemon." }),
  "daemon-unavailable": Object.freeze({ label: "Daemon unavailable", tone: "error", detail: "The native host is installed, but greenwaysd is not reachable." }),
  "native-host-unavailable": Object.freeze({ label: "Native host unavailable", tone: "error", detail: "Install the exact Greenways Native Messaging companion for this extension." }),
  "credential-unavailable": Object.freeze({ label: "Credential unavailable", tone: "error", detail: "The fixed browser-bridge credential file is missing or not private." }),
  "authentication-rejected": Object.freeze({ label: "Authentication rejected", tone: "error", detail: "Re-enrol the local client with the browser-bridge role." }),
  "session-expired": Object.freeze({ label: "Session expired", tone: "error", detail: "Reconnect to open a new connection-bound browser session." }),
  "protocol-mismatch": Object.freeze({ label: "Protocol mismatch", tone: "error", detail: "The extension and local daemon companion do not share a supported protocol." }),
  disconnected: Object.freeze({ label: "Disconnected", tone: "quiet", detail: "The browser has no active daemon session." }),
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function shortDigest(value) {
  const source = String(value || "");
  return source.length > 24 ? `${source.slice(0, 15)}…${source.slice(-8)}` : source;
}

function dateTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

export function connectionStateView(status) {
  return STATE_COPY[status?.state] ?? STATE_COPY.disconnected;
}

function actionMarkup(status) {
  if (status.state === "connecting") {
    return '<button class="gw-button" type="button" disabled>Connecting…</button>';
  }
  if (status.state === "connected") {
    return '<button class="gw-button" type="button" data-daemon-action="refresh">Refresh</button><button class="gw-button" type="button" data-daemon-action="disconnect">Disconnect</button>';
  }
  return `<button class="gw-button gw-button--primary" type="button" data-daemon-action="connect">${status.state === "disconnected" ? "Connect" : "Reconnect"}</button>`;
}

function connectedDetails(status) {
  const daemon = status.daemon;
  const actor = status.actor;
  const identity = status.identity;
  const session = status.session;
  if (!daemon || !actor || !session) return "";
  return `<div class="gw-connection-details" aria-label="Authenticated local connection details">
    <div><span>Local node</span><strong title="${escapeHtml(daemon.nodeId)}">${escapeHtml(daemon.nodeId)}</strong></div>
    <div><span>Daemon</span><strong>v${escapeHtml(daemon.daemonVersion)} · generation ${escapeHtml(daemon.generation)}</strong></div>
    <div><span>Browser client</span><strong>${escapeHtml(actor.label)} · ${escapeHtml(actor.role)}</strong></div>
    <div><span>Identity</span><strong>${identity ? `@${escapeHtml(identity.handle)} · ${escapeHtml(shortDigest(identity.keyId))}` : "Not configured"}</strong></div>
    <div><span>Session expires</span><strong>${escapeHtml(dateTime(session.expiresAtUnixMs))}</strong></div>
    <div><span>Request budget</span><strong>${escapeHtml(session.remainingRequests)} remaining</strong></div>
  </div>`;
}

export function connectionCardMarkup(status, extensionId) {
  const state = connectionStateView(status);
  const error = status?.error?.message
    ? `<p class="gw-connection-error" role="alert">${escapeHtml(status.error.message)}</p>`
    : "";
  const guidance = status.state === "native-host-unavailable"
    ? `<details class="gw-disclosure" open><summary>Installation guidance</summary><div class="gw-connection-install"><p>Install the dedicated Greenways browser bridge, restricted to this packaged extension ID:</p><code>greenways-browser-bridge-install --extension-id ${escapeHtml(extensionId)} --browser chrome</code><p>The installer fixes the daemon socket and browser credential paths. Chrome cannot choose another local authority.</p></div></details>`
    : "";
  return `<section class="gw-connection-center" data-daemon-connection-center>
    <h3>Local daemon</h3>
    <div class="gw-group">
      <div class="gw-row gw-connection-summary">
        <div class="gw-row__main"><span class="gw-row__icon" data-tone="${escapeHtml(state.tone)}">◎</span><div class="gw-row__copy"><strong>Greenways browser bridge</strong><span>${escapeHtml(state.detail)}</span></div></div>
        <div class="gw-row__actions">${actionMarkup(status)}</div>
      </div>
      ${connectedDetails(status)}
      ${error}
      ${guidance}
      <div class="gw-compatibility-note"><strong>Compatibility runtime</strong><span>The resident browser kernel remains available only during migration. It is not substituted for daemon authority when this connection is unavailable.</span></div>
    </div>
  </section>`;
}

export function compactConnectionMarkup(status) {
  const state = connectionStateView(status);
  return `<button type="button" class="gw-daemon-status" data-daemon-open aria-label="Open Connections: ${escapeHtml(state.label)}"><span class="gw-status-dot" data-tone="${escapeHtml(state.tone)}"></span><span>${escapeHtml(state.label)}</span></button>`;
}

export function createDaemonConnectionSurface({
  bridge = new DaemonNativeBridge(),
  documentValue = globalThis.document,
  runtime = globalThis.chrome?.runtime,
} = {}) {
  if (!documentValue || !runtime?.id) {
    throw new TypeError("Connection surface requires the packaged extension document");
  }
  let status = bridge.snapshot();
  let rendering = false;

  function render() {
    if (rendering) return;
    rendering = true;
    try {
      const signature = `${status.state}:${status.observedAtUnixMs}`;
      const settings = documentValue.querySelector('[data-page="connections"] .gw-settings');
      if (settings) {
        const existing = settings.querySelector("[data-daemon-connection-center]");
        if (existing?.dataset.connectionRender !== signature) {
          const wrapper = documentValue.createElement("div");
          wrapper.innerHTML = connectionCardMarkup(status, runtime.id);
          const card = wrapper.firstElementChild;
          card.dataset.connectionRender = signature;
          if (existing) existing.replaceWith(card);
          else settings.prepend(card);
          card.querySelectorAll("[data-daemon-action]").forEach((button) => {
            button.addEventListener("click", () => perform(button.dataset.daemonAction));
          });
        }
      }

      const footer = documentValue.querySelector(".gw-sidebar footer");
      if (footer) {
        const existing = footer.querySelector("[data-daemon-open]");
        if (existing?.dataset.connectionRender !== signature) {
          const wrapper = documentValue.createElement("div");
          wrapper.innerHTML = compactConnectionMarkup(status);
          const control = wrapper.firstElementChild;
          control.dataset.connectionRender = signature;
          existing?.remove();
          footer.append(control);
          control.addEventListener("click", () => {
            const target = new URL("launcher.html#connections", documentValue.baseURI);
            if (documentValue.location.href === target.href) render();
            else documentValue.location.href = target.href;
          });
        }
      }
    } finally {
      rendering = false;
    }
  }

  async function perform(action) {
    try {
      if (action === "connect") await bridge.connect();
      else if (action === "refresh") await bridge.refresh();
      else if (action === "disconnect") await bridge.disconnect();
    } catch {
      // The bridge publishes the bounded failure state to subscribers.
    }
  }

  const unsubscribe = bridge.subscribe((next) => {
    status = next;
    render();
  });
  const observer = new MutationObserver(() => render());
  observer.observe(documentValue.body, { childList: true, subtree: true });
  globalThis.addEventListener?.("hashchange", render);
  render();
  bridge.connect().catch(() => {});

  return Object.freeze({
    bridge,
    render,
    async connect() { return bridge.connect(); },
    async refresh() { return bridge.refresh(); },
    async disconnect() { return bridge.disconnect(); },
    close() {
      observer.disconnect();
      unsubscribe();
    },
  });
}

if (globalThis.document && globalThis.chrome?.runtime?.id) {
  createDaemonConnectionSurface();
}
