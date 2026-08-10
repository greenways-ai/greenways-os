import { KernelClient } from "./kernel-client.js";
import { DEVTOOLS_BRIDGE_PROTOCOL, DEVTOOLS_DEFAULT_PORT } from "./devtools-bridge.js";
import { DEVTOOLS_ROUTES, appShellMarkup, routeFromHash } from "./app-shell.js";

const appRoot = document.querySelector("#devtools-app");
const effects = Object.freeze({
  async run(entries) {
    if (!Array.isArray(entries) || entries.length) throw new Error("DevTools does not accept page effects");
  },
});
const client = new KernelClient({ clientKind: "devtools", effects });

let kernelReady = false;
let kernelError = null;
let status = { currentNamespace: "—", modules: [] };
let services = [];
let bridge = { protocol: DEVTOOLS_BRIDGE_PROTOCOL, state: "stopped", port: null, token: null, clients: 0, error: null };
let consoleEntries = [];
let callResult = "Kernel methods return here.";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

function pretty(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function bridgeMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "DevTools bridge request failed"));
      return resolve(response.bridge);
    });
  });
}

function addConsole(value, tone = "output") {
  consoleEntries = [{
    at: new Date().toLocaleTimeString([], { hour12: false }),
    value: pretty(value),
    tone,
  }, ...consoleEntries].slice(0, 100);
}

function pageHeader(title, description) {
  return `<header class="gw-page__header"><h2>${title}</h2><p>${description}</p></header>`;
}

function inventoryRows(items, emptyLabel) {
  if (!items.length) return `<p class="gw-empty">${emptyLabel}</p>`;
  return items.map(({ name, detail, icon = "·" }) => `<div class="gw-row"><div class="gw-row__main"><span class="gw-row__icon">${escapeHtml(icon)}</span><div class="gw-row__copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(detail)}</span></div></div></div>`).join("");
}

function kernelPage() {
  const modules = status.modules.map((module) => ({ name: module.id, detail: `Generation ${module.generation} · ${module.root}`, icon: "M" }));
  const serviceRows = services.map((service) => ({ name: service.name, detail: `${service.id} · ${service.status}`, icon: "S" }));
  return `${pageHeader("Kernel", "Inspect the browser-resident Hara runtime.")}<div class="gw-settings">
    <section><h3>Status</h3><div class="gw-group">
      <div class="gw-row"><div class="gw-row__copy"><strong>Resident kernel</strong><span>Runs in the extension service worker</span></div><span class="gw-row__value">${kernelReady ? "Ready" : "Starting…"}</span></div>
      <div class="gw-row"><div class="gw-row__copy"><strong>Current namespace</strong><span>Evaluation context</span></div><code class="gw-row__value" data-current-namespace>${escapeHtml(status.currentNamespace)}</code></div>
      <div class="gw-row"><div class="gw-row__copy"><strong>Installed modules</strong><span>Verified HAL generations</span></div><span class="gw-row__value" data-module-count>${status.modules.length}</span></div>
      <div class="gw-row"><div class="gw-row__copy"><strong>RESP bridge</strong><span>Authenticated local programming endpoint</span></div><span class="gw-row__value" data-bridge-summary>${escapeHtml(bridge.state === "active" ? `127.0.0.1:${bridge.port}` : bridge.state)}</span></div>
    </div></section>
    <section><h3>HAL modules</h3><div class="gw-group" data-module-list>${inventoryRows(modules, "No optional modules · root kernel only")}</div></section>
    <section><h3>Core services</h3><div class="gw-group" data-service-list>${inventoryRows(serviceRows, "No services reported")}</div></section>
    <button class="gw-button devtools-refresh" type="button" data-refresh>Refresh</button>
  </div>`;
}

function consoleMarkup() {
  if (!consoleEntries.length) return '<p class="gw-empty">Evaluation output appears here.</p>';
  return consoleEntries.map((entry) => `<li data-tone="${entry.tone}"><time>${escapeHtml(entry.at)}</time><pre>${escapeHtml(entry.value)}</pre></li>`).join("");
}

function developerPage() {
  return `${pageHeader("Developer", "Evaluate Hara and call reviewed kernel methods.")}<div class="gw-settings developer-settings">
    <section><h3>Kernel REPL</h3><div class="gw-group devtools-form-group">
      <form data-eval-form><label><span>Namespace</span><input name="namespace" value="gw.devtools" spellcheck="false" autocomplete="off"></label><label><span>Expression</span><textarea name="source" spellcheck="false" rows="5">(+ 20 22)</textarea></label><div class="devtools-actions"><button class="gw-button gw-button--primary" type="submit">Evaluate</button><button class="gw-button" type="button" data-clear-output>Clear</button></div></form>
      <ol class="devtools-console" data-console-output aria-live="polite">${consoleMarkup()}</ol>
    </div></section>
    <section><h3>Kernel dispatch</h3><div class="gw-group devtools-form-group">
      <form data-call-form><div class="devtools-inline-fields"><label><span>Method</span><input name="method" value="core/services" spellcheck="false"></label><label><span>Arguments</span><input name="args" value="[]" spellcheck="false"></label></div><div class="devtools-actions"><button class="gw-button" type="submit">Call</button></div></form>
      <pre class="devtools-result" data-call-result>${escapeHtml(callResult)}</pre>
    </div></section>
  </div>`;
}

function bridgePage() {
  const active = bridge.state === "active";
  const busy = bridge.state === "starting";
  const port = bridge.port || DEVTOOLS_DEFAULT_PORT;
  const note = bridge.error || (active ? "The session token is invalidated when the bridge stops." : "Install the Greenways DevTools native host before starting the bridge.");
  return `${pageHeader("RESP Bridge", "Connect local editors and REPL clients to this kernel session.")}<div class="gw-settings">
    <section><h3>Local programming port</h3><div class="gw-group">
      <div class="gw-row"><div class="gw-row__copy"><strong>Status</strong><span>The listener is owned by the separately installed native host.</span></div><span class="bridge-state" data-state="${escapeHtml(bridge.state)}" data-bridge-state>${escapeHtml(bridge.state)}</span></div>
      <form class="bridge-settings" data-bridge-form><label><span>Loopback port</span><input name="port" type="number" min="1024" max="65535" value="${escapeHtml(port)}"></label><div class="devtools-actions"><button class="gw-button gw-button--primary" type="submit" data-bridge-start ${active || busy ? "disabled" : ""}>Start</button><button class="gw-button" type="button" data-bridge-stop ${active || busy ? "" : "disabled"}>Stop</button></div></form>
      ${active && bridge.token ? `<div class="gw-row" data-bridge-secret><div class="gw-row__copy"><strong>Session AUTH token</strong><code data-bridge-token>${escapeHtml(bridge.token)}</code></div><button class="gw-button" type="button" data-copy-token>Copy</button></div>` : ""}
      <p class="bridge-note" data-tone="${bridge.error ? "error" : "quiet"}" data-bridge-note>${escapeHtml(note)}</p>
      <details class="gw-disclosure"><summary>Connection example</summary><pre data-bridge-example>redis-cli -h 127.0.0.1 -p ${escapeHtml(port)}
AUTH &lt;session-token&gt;
GW.STATUS
GW.EVAL gw.devtools "(+ 20 22)"</pre></details>
    </div></section>
  </div>`;
}

function render() {
  const route = routeFromHash(location.hash, DEVTOOLS_ROUTES, "kernel");
  const pages = {
    kernel: ["Kernel", "Resident runtime", kernelPage()],
    developer: ["Developer", "Root authority", developerPage()],
    bridge: ["RESP Bridge", "Local programming port", bridgePage()],
  };
  const [title, detail, content] = pages[route];
  appRoot.innerHTML = appShellMarkup({
    activeRoute: route,
    title,
    detail,
    content,
    state: kernelError ? "Unavailable" : kernelReady ? "Kernel ready" : "Starting",
    tone: kernelError ? "error" : kernelReady ? "good" : "quiet",
  });
  attachPageActions(route);
}

function attachPageActions(route) {
  if (route === "kernel") {
    appRoot.querySelector("[data-refresh]")?.addEventListener("click", () => refresh().catch((error) => { kernelError = error; render(); }));
  }
  if (route === "developer") {
    appRoot.querySelector("[data-eval-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const request = { namespace: String(form.get("namespace")), source: String(form.get("source")) };
      addConsole(`${request.namespace}> ${request.source}`, "input");
      try {
        const result = await client.call("devtools/eval", [request]);
        status.currentNamespace = result.namespace;
        addConsole(result.output);
      } catch (error) { addConsole(error?.message || String(error), "error"); }
      render();
    });
    appRoot.querySelector("[data-clear-output]")?.addEventListener("click", () => { consoleEntries = []; render(); });
    appRoot.querySelector("[data-call-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      try {
        const method = String(form.get("method")).trim();
        const args = JSON.parse(String(form.get("args")) || "[]");
        if (!Array.isArray(args)) throw new Error("Kernel arguments must be a JSON array");
        callResult = pretty(await client.call("devtools/call", [method, args]));
      } catch (error) { callResult = `ERROR: ${error?.message || error}`; }
      render();
    });
  }
  if (route === "bridge") {
    appRoot.querySelector("[data-bridge-form]")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      bridge = { ...bridge, state: "starting", error: null };
      render();
      try { bridge = await bridgeMessage("greenways/devtools-bridge/start", { port: Number(form.get("port")) }); }
      catch (error) { bridge = { ...bridge, state: "failed", token: null, error: error?.message || String(error) }; }
      render();
    });
    appRoot.querySelector("[data-bridge-stop]")?.addEventListener("click", async () => {
      try { bridge = await bridgeMessage("greenways/devtools-bridge/stop"); }
      catch (error) { bridge = { ...bridge, state: "failed", token: null, error: error?.message || String(error) }; }
      render();
    });
    appRoot.querySelector("[data-copy-token]")?.addEventListener("click", async () => {
      if (!bridge.token) return;
      await navigator.clipboard.writeText(bridge.token);
      const note = appRoot.querySelector("[data-bridge-note]");
      if (note) note.textContent = "Session token copied.";
    });
  }
}

async function refresh() {
  const [nextStatus, nextServices, bridgeStatus] = await Promise.all([
    client.call("devtools/status"),
    client.call("core/services"),
    bridgeMessage("greenways/devtools-bridge/status").catch((error) => ({ ...bridge, state: "failed", error: error.message })),
  ]);
  status = nextStatus;
  services = nextServices;
  bridge = bridgeStatus;
  kernelError = null;
  render();
}

window.addEventListener("hashchange", render);
window.addEventListener("beforeunload", () => client.destroy(), { once: true });

render();
(async () => {
  try {
    await client.start();
    kernelReady = true;
    await refresh();
    addConsole("Kernel DevTools attached to the service-worker runtime.");
    render();
  } catch (error) {
    kernelError = error;
    addConsole(error?.message || String(error), "error");
    render();
  }
})();
