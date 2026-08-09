import {
  getAppManifest,
} from "./app-catalog.js";
import { sameManifestApproval } from "./app-launch.js";
import { activeCapabilityGrant } from "./core-services.js";
import {
  GreenwaysKeyring,
  KEYRING_PROVIDERS,
  createProviderProfileId,
} from "./keyring.js";
import { getModelProviderPolicy } from "./model-provider-policy.js";
import { KernelClient } from "./kernel-client.js";
import { MODEL_GENERATE_CAPABILITY } from "./ai-service.js";
import {
  PLAYGROUND_AI_ORIGIN,
  PLAYGROUND_APP_ID,
} from "./playground-ai-protocol.js";

const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = globalThis.chrome.runtime.getURL("src/playground-consent.css");
document.head.append(stylesheet);

const root = document.querySelector("#launcher-app");
const keyring = new GreenwaysKeyring();
const session = new KernelClient({
  clientKind: "launcher",
  effects: { async run() {} },
});

let keyringStatus = null;
let busy = false;
let notice = "";
let noticeTone = "quiet";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function secureId(prefix) {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `${prefix}/${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  }
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
  if (!bytes) throw new Error("Web Crypto is required to create a capability grant");
  return `${prefix}/${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function currentManifest() {
  const manifest = getAppManifest(PLAYGROUND_APP_ID);
  if (!manifest) throw new Error("This Greenways OS build does not include Hara Playground");
  return manifest;
}

function approvedManifest() {
  return session.state?.apps?.installed?.find(({ id }) => id === PLAYGROUND_APP_ID) ?? null;
}

function currentGrant() {
  const approved = approvedManifest();
  if (!approved || !sameManifestApproval(approved, currentManifest())) return null;
  try {
    return activeCapabilityGrant(
      session.state?.capabilities?.grants ?? [],
      approved,
      MODEL_GENERATE_CAPABILITY,
    );
  } catch {
    return null;
  }
}

function approvalState() {
  const approved = approvedManifest();
  if (!approved) return { label: "Not installed", tone: "quiet" };
  if (!sameManifestApproval(approved, currentManifest())) {
    return { label: "Update approval required", tone: "warn" };
  }
  if (!currentGrant()) return { label: "AI permission required", tone: "warn" };
  return { label: "Connected", tone: "good" };
}

async function providerAccess(provider) {
  if (!globalThis.chrome?.permissions?.contains) return false;
  return globalThis.chrome.permissions.contains({
    origins: [getModelProviderPolicy(provider)?.permissionOrigin],
  });
}

async function profileRows() {
  const profiles = keyringStatus?.providerProfiles ?? [];
  if (!profiles.length) {
    return '<p class="consent-empty">No provider keys are installed for this browser session.</p>';
  }
  const access = Object.fromEntries(await Promise.all(
    KEYRING_PROVIDERS.map(async ({ id }) => [id, await providerAccess(id).catch(() => false)]),
  ));
  return profiles.map((profile) => `
    <article class="consent-profile">
      <span class="consent-profile__mark">${escapeHtml(profile.provider.slice(0, 1).toUpperCase())}</span>
      <div><strong>${escapeHtml(profile.label)}</strong><small>${escapeHtml(profile.provider)} · session only · ${access[profile.provider] ? "network approved" : "network approval required"}</small></div>
      <button type="button" data-remove-profile="${escapeHtml(profile.id)}" ${busy ? "disabled" : ""}>Remove</button>
    </article>`).join("");
}

async function render() {
  const state = approvalState();
  const grant = currentGrant();
  root.innerHTML = `<div class="playground-consent-shell">
    <header class="playground-consent-header">
      <div><span class="consent-mark">GW</span><span><strong>Greenways OS</strong><small>HARA PLAYGROUND · AI CONNECTION</small></span></div>
      <a href="${PLAYGROUND_AI_ORIGIN}/">Return to Playground</a>
    </header>

    <main class="playground-consent-main">
      <section class="consent-hero">
        <p>LOCAL KEY AUTHORITY</p>
        <h1>Let Playground use AI<br><em>without giving it your key.</em></h1>
        <p>Greenways OS keeps provider credentials in session storage, checks the Hara Playground approval, and sends only bounded model requests to an approved provider.</p>
        <div class="consent-state" data-tone="${escapeHtml(state.tone)}"><i></i><strong>${escapeHtml(state.label)}</strong><span>${grant ? "model/generate is active for playground.hara-lang.org" : "No model call can leave the browser until you approve it here."}</span></div>
      </section>

      <section class="consent-card">
        <header><div><p>01 · APPLICATION AUTHORITY</p><h2>Hara Playground</h2></div><span>https://playground.hara-lang.org</span></header>
        <div class="consent-capability">
          <div><strong>model/generate</strong><span>Bounded prompts and text responses through a selected Keyring profile.</span></div>
          ${grant
            ? `<button type="button" class="consent-secondary" data-revoke-grant="${escapeHtml(grant.id)}" ${busy ? "disabled" : ""}>Revoke AI access</button>`
            : `<button type="button" class="consent-primary" data-enable-playground ${busy ? "disabled" : ""}>${busy ? "Working…" : "Enable in Playground"}</button>`}
        </div>
        <ul class="consent-boundaries">
          <li>Exact caller origin only</li>
          <li>Maximum 256 KB context</li>
          <li>Maximum 4,096 output tokens</li>
          <li>No arbitrary URLs, headers, tools, or credential export</li>
        </ul>
      </section>

      <section class="consent-card">
        <header><div><p>02 · PROVIDER KEYS</p><h2>Session profiles</h2></div><span>Cleared when the browser session ends</span></header>
        <div class="consent-profiles">${await profileRows()}</div>
        <form class="consent-provider-form" data-provider-form>
          <label><span>Provider</span><select name="provider">${KEYRING_PROVIDERS.map(({ id, name }) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("")}</select></label>
          <label><span>Label</span><input name="label" maxlength="80" autocomplete="off" placeholder="Personal coding" required></label>
          <label class="consent-secret"><span>API key</span><input name="secret" type="password" minlength="8" maxlength="8192" autocomplete="off" placeholder="Stored only for this browser session" required></label>
          <button type="submit" class="consent-secondary" ${busy ? "disabled" : ""}>Add provider key</button>
        </form>
      </section>

      ${notice ? `<p class="consent-notice" data-tone="${escapeHtml(noticeTone)}" role="status">${escapeHtml(notice)}</p>` : ""}
    </main>

    <footer class="playground-consent-footer"><span>GREENWAYS / KEYRING</span><span>Keys stay local · requests stay typed · access stays revocable</span></footer>
  </div>`;
  bindEvents();
}

function setNotice(message, tone = "quiet") {
  notice = message;
  noticeTone = tone;
  return render();
}

async function refresh() {
  await session.refresh();
  keyringStatus = await keyring.status();
}

async function enablePlayground() {
  if (busy) return;
  busy = true;
  notice = "Checking the current Playground approval…";
  await render();
  try {
    await session.refresh();
    const current = currentManifest();
    const approved = approvedManifest();
    if (!approved) {
      await session.dispatch("apps/install", [current]);
    } else if (!sameManifestApproval(approved, current)) {
      await session.dispatch("apps/update", [current]);
    }
    await session.refresh();
    if (!currentGrant()) {
      await session.dispatch("capabilities/grant", [{
        id: secureId("grant/hara-playground/model-generate"),
        appId: PLAYGROUND_APP_ID,
        capability: MODEL_GENERATE_CAPABILITY,
        constraints: {
          origins: [PLAYGROUND_AI_ORIGIN],
          maxInputBytes: 256 * 1024,
          maxOutputTokens: 4096,
          timeoutMs: 120000,
        },
      }]);
    }
    await refresh();
    notice = "Hara Playground is connected. Return to Playground and open the AI assistant.";
    noticeTone = "good";
  } catch (error) {
    notice = error?.message || "Playground AI access could not be enabled.";
    noticeTone = "error";
  } finally {
    busy = false;
    await render();
  }
}

async function revokeGrant(grantId) {
  if (busy) return;
  busy = true;
  await render();
  try {
    await session.dispatch("capabilities/revoke", [grantId]);
    await refresh();
    notice = "Hara Playground AI access was revoked.";
    noticeTone = "good";
  } catch (error) {
    notice = error?.message || "The capability grant could not be revoked.";
    noticeTone = "error";
  } finally {
    busy = false;
    await render();
  }
}

async function addProvider(form) {
  if (busy) return;
  const data = new FormData(form);
  const provider = String(data.get("provider") ?? "");
  const label = String(data.get("label") ?? "").trim();
  const secret = String(data.get("secret") ?? "").trim();
  if (!globalThis.chrome?.permissions?.request) {
    await setNotice("Chrome provider permissions are unavailable", "error");
    return;
  }
  // Request the exact provider origin while the form submit still carries user activation.
  const permission = globalThis.chrome.permissions.request({
    origins: [getModelProviderPolicy(provider)?.permissionOrigin],
  });
  busy = true;
  notice = `Requesting network access for ${provider}…`;
  await render();
  try {
    const granted = await permission;
    if (!granted) throw new Error(`Network access for ${provider} was not approved`);
    await keyring.addProviderProfile({
      id: createProviderProfileId(provider, label),
      provider,
      label,
      secret,
    });
    keyringStatus = await keyring.status();
    notice = `${label} was added for this browser session.`;
    noticeTone = "good";
  } catch (error) {
    notice = error?.message || "The provider key could not be added.";
    noticeTone = "error";
  } finally {
    busy = false;
    await render();
  }
}

async function removeProvider(profileId) {
  if (busy) return;
  busy = true;
  await render();
  try {
    await keyring.removeProviderProfile(profileId);
    keyringStatus = await keyring.status();
    notice = "The session provider key was removed.";
    noticeTone = "good";
  } catch (error) {
    notice = error?.message || "The provider key could not be removed.";
    noticeTone = "error";
  } finally {
    busy = false;
    await render();
  }
}

function bindEvents() {
  root.querySelector("[data-enable-playground]")?.addEventListener("click", enablePlayground);
  root.querySelector("[data-revoke-grant]")?.addEventListener("click", (event) => revokeGrant(event.currentTarget.dataset.revokeGrant));
  root.querySelector("[data-provider-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    addProvider(event.currentTarget);
  });
  root.querySelectorAll("[data-remove-profile]").forEach((button) => {
    button.addEventListener("click", () => removeProvider(button.dataset.removeProfile));
  });
}

async function start() {
  if (!root) throw new Error("Greenways launcher root is unavailable");
  root.innerHTML = '<section class="launcher-fatal"><p>GREENWAYS KEYRING</p><h1>Opening Playground access…</h1></section>';
  await session.start();
  keyringStatus = await keyring.status();
  await render();
}

globalThis.addEventListener("beforeunload", () => session.destroy(), { once: true });
start().catch((error) => {
  root.innerHTML = `<section class="launcher-fatal"><p>GREENWAYS KEYRING</p><h1>Playground access could not open.</h1><code>${escapeHtml(error?.message || error)}</code></section>`;
});
