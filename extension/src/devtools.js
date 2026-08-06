import { KernelClient } from "./kernel-client.js";
import { DEVTOOLS_BRIDGE_PROTOCOL, DEVTOOLS_DEFAULT_PORT } from "./devtools-bridge.js";

const root = document.documentElement;
const kernelState = document.querySelector("[data-kernel-state]");
const currentNamespace = document.querySelector("[data-current-namespace]");
const moduleCount = document.querySelector("[data-module-count]");
const bridgeSummary = document.querySelector("[data-bridge-summary]");
const moduleList = document.querySelector("[data-module-list]");
const serviceList = document.querySelector("[data-service-list]");
const consoleOutput = document.querySelector("[data-console-output]");
const callResult = document.querySelector("[data-call-result]");
const bridgeState = document.querySelector("[data-bridge-state]");
const bridgeSecret = document.querySelector("[data-bridge-secret]");
const bridgeToken = document.querySelector("[data-bridge-token]");
const bridgeNote = document.querySelector("[data-bridge-note]");
const bridgeStart = document.querySelector("[data-bridge-start]");
const bridgeStop = document.querySelector("[data-bridge-stop]");
const bridgeExample = document.querySelector("[data-bridge-example]");

const effects = Object.freeze({
  async run(entries) {
    if (!Array.isArray(entries) || entries.length) {
      throw new Error("DevTools does not accept page effects");
    }
  },
});

const client = new KernelClient({ clientKind: "devtools", effects });
let bridge = { protocol: DEVTOOLS_BRIDGE_PROTOCOL, state: "stopped", port: null, token: null, clients: 0, error: null };

function pretty(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function bridgeMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "DevTools bridge request failed"));
        return;
      }
      resolve(response.bridge);
    });
  });
}

function addConsole(value, tone = "output") {
  const item = document.createElement("li");
  item.dataset.tone = tone;
  const time = document.createElement("time");
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const output = document.createElement("pre");
  output.textContent = pretty(value);
  item.append(time, output);
  consoleOutput.prepend(item);
}

function inventoryItem(name, detail) {
  const item = document.createElement("li");
  const title = document.createElement("strong");
  const metadata = document.createElement("span");
  title.textContent = name;
  metadata.textContent = detail;
  item.append(title, metadata);
  return item;
}

function renderBridge() {
  const active = bridge.state === "active";
  bridgeState.textContent = bridge.state.toUpperCase();
  bridgeState.style.color = active ? "var(--accent)" : bridge.state === "failed" ? "var(--error)" : "";
  bridgeSummary.textContent = active ? `127.0.0.1:${bridge.port} · ${bridge.clients ?? 0} client${bridge.clients === 1 ? "" : "s"}` : bridge.state;
  bridgeStart.disabled = active || bridge.state === "starting";
  bridgeStop.disabled = !active && bridge.state !== "starting" && bridge.state !== "failed";
  bridgeSecret.hidden = !active || !bridge.token;
  bridgeToken.textContent = bridge.token || "";
  bridgeNote.textContent = bridge.error
    ? bridge.error
    : active
      ? "The token exists only for this bridge session. Stop the bridge to invalidate it."
      : "Install the Greenways DevTools native host before starting the bridge.";
  const port = bridge.port || Number(document.querySelector("[data-bridge-form] [name=port]").value) || DEVTOOLS_DEFAULT_PORT;
  bridgeExample.textContent = `redis-cli -h 127.0.0.1 -p ${port}\nAUTH <session-token>\nGW.STATUS\nGW.EVAL gw.devtools \"(+ 20 22)\"`;
}

async function refresh() {
  const [status, services, bridgeStatus] = await Promise.all([
    client.call("devtools/status"),
    client.call("core/services"),
    bridgeMessage("greenways/devtools-bridge/status").catch((error) => ({ ...bridge, state: "failed", error: error.message })),
  ]);
  currentNamespace.textContent = status.currentNamespace;
  moduleCount.textContent = String(status.modules.length);

  moduleList.replaceChildren();
  if (!status.modules.length) moduleList.append(inventoryItem("No optional modules", "root kernel only"));
  for (const module of status.modules) {
    moduleList.append(inventoryItem(module.id, `g${module.generation} · ${module.root}`));
  }

  serviceList.replaceChildren();
  for (const service of services) {
    serviceList.append(inventoryItem(service.name, `${service.id} · ${service.status}`));
  }
  bridge = bridgeStatus;
  renderBridge();
}

document.querySelector("[data-eval-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const request = { namespace: String(form.get("namespace")), source: String(form.get("source")) };
  addConsole(`${request.namespace}> ${request.source}`, "input");
  try {
    const result = await client.call("devtools/eval", [request]);
    addConsole(result.output);
    currentNamespace.textContent = result.namespace;
  } catch (error) {
    addConsole(error?.message || String(error), "error");
  }
});

document.querySelector("[data-clear-output]").addEventListener("click", () => consoleOutput.replaceChildren());

document.querySelector("[data-call-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const method = String(form.get("method")).trim();
    const args = JSON.parse(String(form.get("args")) || "[]");
    if (!Array.isArray(args)) throw new Error("Kernel arguments must be a JSON array");
    callResult.textContent = "Calling…";
    callResult.textContent = pretty(await client.call("devtools/call", [method, args]));
  } catch (error) {
    callResult.textContent = `ERROR: ${error?.message || error}`;
  }
});

document.querySelector("[data-bridge-form]").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  bridge = { ...bridge, state: "starting", error: null };
  renderBridge();
  try {
    bridge = await bridgeMessage("greenways/devtools-bridge/start", { port: Number(form.get("port")) });
  } catch (error) {
    bridge = { ...bridge, state: "failed", token: null, error: error?.message || String(error) };
  }
  renderBridge();
});

bridgeStop.addEventListener("click", async () => {
  try {
    bridge = await bridgeMessage("greenways/devtools-bridge/stop");
  } catch (error) {
    bridge = { ...bridge, state: "failed", token: null, error: error?.message || String(error) };
  }
  renderBridge();
});

document.querySelector("[data-copy-token]").addEventListener("click", async () => {
  if (!bridge.token) return;
  await navigator.clipboard.writeText(bridge.token);
  bridgeNote.textContent = "Session token copied. It remains valid only while this bridge is active.";
});

document.querySelector("[data-refresh]").addEventListener("click", () => refresh().catch((error) => addConsole(error.message, "error")));

window.addEventListener("beforeunload", () => client.destroy(), { once: true });

(async () => {
  try {
    await client.start();
    root.querySelector(".devtools-state").dataset.ready = "true";
    kernelState.textContent = "Resident kernel ready";
    await refresh();
    addConsole("Kernel DevTools attached to the service-worker runtime.");
  } catch (error) {
    kernelState.textContent = "Kernel unavailable";
    addConsole(error?.message || String(error), "error");
  }
})();
