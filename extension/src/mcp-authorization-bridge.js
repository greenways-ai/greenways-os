import {
  MCP_ACCESS_MESSAGE_TYPE,
  MCP_ACCESS_PROTOCOL,
  MCP_PAIRING_CHALLENGE_PROTOCOL,
} from "./mcp-access-protocol.js";

const CHALLENGE_SELECTOR = "#greenways-mcp-pairing-challenge[type='application/json']";
const ASSERTION_SELECTOR = "textarea[data-greenways-mcp-assertion]";
const SURFACE_ID = "greenways-mcp-browser-approval";

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    globalThis.chrome.runtime.sendMessage(message, (response) => {
      const lastError = globalThis.chrome.runtime.lastError;
      if (lastError) return reject(new Error(lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "Greenways MCP approval failed"));
      resolve(response);
    });
  });
}

function challengeFromPage() {
  const node = document.querySelector(CHALLENGE_SELECTOR);
  if (!node) throw new Error("This page does not contain a Greenways MCP pairing challenge");
  let challenge;
  try {
    challenge = JSON.parse(node.textContent || "");
  } catch {
    throw new Error("The Greenways MCP pairing challenge is not valid JSON");
  }
  if (challenge?.protocol !== MCP_PAIRING_CHALLENGE_PROTOCOL || typeof challenge?.id !== "string") {
    throw new Error("The Greenways MCP pairing challenge is unsupported");
  }
  return challenge;
}

function approvedForm() {
  const assertion = document.querySelector(ASSERTION_SELECTOR);
  const form = assertion?.form;
  if (!assertion || !form) throw new Error("This page does not contain the Greenways MCP authorization form");
  const action = new URL(form.action, location.href);
  if (action.origin !== "https://mcp.greenways.ai" || action.pathname !== "/authorize") {
    throw new Error("The Greenways MCP authorization form is not on the approved origin");
  }
  if (String(form.method || "").toLowerCase() !== "post") {
    throw new Error("The Greenways MCP authorization form must use POST");
  }
  return { assertion, form };
}

function createSurface() {
  let surface = document.getElementById(SURFACE_ID);
  if (surface) return surface;
  surface = document.createElement("section");
  surface.id = SURFACE_ID;
  surface.setAttribute("aria-label", "Greenways OS MCP approval");
  surface.style.cssText = "display:grid;gap:10px;margin:18px 0;padding:16px;border:1px solid color-mix(in srgb, CanvasText 20%, transparent);border-radius:12px;background:color-mix(in srgb, Canvas 92%, CanvasText 8%);color:CanvasText;font:14px/1.45 ui-sans-serif,system-ui,sans-serif";
  surface.innerHTML = `<strong>Greenways OS</strong><span data-greenways-mcp-status>Checking local pairing authority…</span><button type="button" data-greenways-mcp-approve disabled style="min-height:42px;border:0;border-radius:9px;padding:0 16px;background:#176b52;color:#fff;font-weight:700;cursor:pointer">Approve with Greenways OS</button><small>Greenways signs only this exact read-only connection. It never exports your controller key or submits the authorization form for you.</small>`;
  const { assertion } = approvedForm();
  assertion.closest("form")?.insertAdjacentElement("beforebegin", surface);
  return surface;
}

function setStatus(surface, message, { error = false } = {}) {
  const status = surface.querySelector("[data-greenways-mcp-status]");
  if (!status) return;
  status.textContent = message;
  status.setAttribute("data-tone", error ? "error" : "quiet");
}

async function initialize() {
  const challenge = challengeFromPage();
  const { assertion } = approvedForm();
  const surface = createSurface();
  const button = surface.querySelector("[data-greenways-mcp-approve]");
  try {
    const hello = await runtimeMessage({
      type: MCP_ACCESS_MESSAGE_TYPE,
      protocol: MCP_ACCESS_PROTOCOL,
      operation: "hello",
      challenge,
    });
    if (!hello.ready) {
      setStatus(surface, "Open Greenways MCP Access and enable its local controller approval.", { error: true });
      return;
    }
    button.disabled = false;
    setStatus(surface, "Ready. Review the client and tool list, then approve this exact connection.");
  } catch (error) {
    setStatus(surface, error?.message || "Greenways OS could not validate this page.", { error: true });
    return;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    setStatus(surface, "Requesting one local signature…");
    try {
      const response = await runtimeMessage({
        type: MCP_ACCESS_MESSAGE_TYPE,
        protocol: MCP_ACCESS_PROTOCOL,
        operation: "approve",
        challenge,
      });
      assertion.value = JSON.stringify(response.assertion);
      assertion.dispatchEvent(new Event("input", { bubbles: true }));
      assertion.dispatchEvent(new Event("change", { bubbles: true }));
      setStatus(surface, "Approval is ready. Review it, then press the page’s Authorize read access button.");
    } catch (error) {
      setStatus(surface, error?.message || "Greenways OS did not approve this connection.", { error: true });
      button.disabled = false;
    }
  });
}

initialize().catch(() => {});
