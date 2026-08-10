import { getAppManifest, getBuiltinAppCatalog } from "./app-catalog.js";
import { GreenwaysKeyring } from "./keyring.js";
import { openKeyringSurface } from "./keyring-surface.js";
import { packageKindLabel, projectPackage } from "./package-manager.js";

const appRoot = document.querySelector("#launcher-app");
const surfaceRoot = document.querySelector("#launcher-surfaces");
const keyring = new GreenwaysKeyring();
let snapshot = null;
let keyringError = null;
let scheduledTimer = null;

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);

const setText = (node, value) => {
  if (node && node.textContent !== value) node.textContent = value;
};

function elementFrom(markup) {
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  return template.content.firstElementChild;
}

function packageCounts(shell) {
  return {
    installed: shell.querySelectorAll(".app-section:not(.catalog-section) [data-app-card]").length,
    available: shell.querySelectorAll(".catalog-section [data-app-card]").length,
  };
}

function coreMarkup(shell) {
  const packages = packageCounts(shell);
  const controller = snapshot?.controller;
  const profiles = snapshot?.providerProfiles ?? [];
  const state = keyringError ? "NEEDS ATTENTION" : controller || profiles.length ? "READY" : "SET UP";
  return `<section class="core-products" data-core-products>
    <header class="core-heading"><div><p>GREENWAYS OS / CORE</p><h2>Keys first. Packages second.</h2></div><span>Local Hara kernel</span></header>
    <div class="core-grid">
      <article class="core-card core-card--keyring"><b>01</b><i>⌁</i><div><p>KEYRING · ${state}</p><h3>Own the keys your tools use.</h3><span>${controller ? `@${escapeHtml(controller.handle)} · ` : "Controller not created · "}${profiles.length} session model profile${profiles.length === 1 ? "" : "s"}</span></div><button type="button" data-open-keyring>Open keyring</button></article>
      <article class="core-card core-card--packages"><b>02</b><i>▦</i><div><p>PACKAGE MANAGER · LOCAL APPROVALS</p><h3>Add capabilities without surrendering the kernel.</h3><span>${packages.installed} installed · ${packages.available} available · executable extension code stays bundled</span></div><button type="button" data-manage-packages>Manage packages</button></article>
    </div>
    <p class="core-boundary">Packages may request typed keyring operations. They are never given a readable provider credential or private signing key.</p>
  </section>`;
}

function connectionsMarkup() {
  return `<section class="core-connections" data-core-connections>
    <header class="core-heading"><div><p>OPTIONAL CONNECTIONS</p><h2>Homes, gateways, and migration</h2></div><span>Network by consent</span></header>
    <p>Hestia, Tahto, and legacy Home Link extend Greenways OS. They do not sit above local keys or package approvals.</p>
  </section>`;
}

function attachCoreActions(core, shell) {
  core.querySelector("[data-open-keyring]")?.addEventListener("click", () => {
    openKeyringSurface({
      root: surfaceRoot,
      keyring,
      onChanged(status) {
        snapshot = status;
        keyringError = null;
        schedule();
      },
    }).catch((error) => {
      keyringError = error;
      schedule();
    });
  });
  core.querySelector("[data-manage-packages]")?.addEventListener("click", () => {
    shell.querySelector(".app-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

function decorate() {
  scheduledTimer = null;
  const shell = appRoot?.querySelector(".launcher-shell");
  const intro = shell?.querySelector(".launcher-intro");
  if (!shell || !intro) return;

  // Legacy connection decorators retain their compatibility surfaces, but the
  // first-product shell no longer renders their network-led hero. We never
  // rewrite its children, so independent observers converge instead of fighting.
  if (!intro.hidden) intro.hidden = true;
  setText(shell.querySelector(".launcher-brand small"), "LOCAL KEYRING + PACKAGE MANAGER");

  const signature = JSON.stringify([
    snapshot?.controller?.keyId,
    snapshot?.providerProfiles?.map(({ id }) => id),
    Boolean(keyringError),
    packageCounts(shell),
  ]);
  let core = shell.querySelector(":scope > [data-core-products]");
  if (!core || core.dataset.signature !== signature) {
    const next = elementFrom(coreMarkup(shell));
    next.dataset.signature = signature;
    attachCoreActions(next, shell);
    if (core) core.replaceWith(next);
    else shell.append(next);
    core = next;
  }

  if (!shell.querySelector(":scope > [data-core-connections]")) {
    shell.append(elementFrom(connectionsMarkup()));
  }

  const sections = [...shell.querySelectorAll(":scope > .app-section")];
  const installed = sections.find((section) => !section.classList.contains("catalog-section"));
  const catalog = sections.find((section) => section.classList.contains("catalog-section"));
  if (installed) {
    installed.setAttribute("aria-label", "Installed apps");
    setText(installed.querySelector(".section-heading p"), "PACKAGE MANAGER");
    setText(installed.querySelector(".section-heading h2"), "Installed apps");
  }
  if (catalog) {
    setText(catalog.querySelector(".section-heading p"), "PACKAGE CATALOGUE");
    setText(catalog.querySelector(".section-heading h2"), "Available packages");
  }
  shell.querySelectorAll("[data-app-card]").forEach((card) => {
    const manifest = getAppManifest(card.dataset.appCard);
    if (manifest) {
      setText(card.querySelector(".app-copy p"), packageKindLabel(projectPackage(manifest).kind));
    }
  });

  // Visual order is CSS-owned. Home Link, app sections, and core
  // sections remain stable direct children; this decorator never reparents them.
}

function schedule() {
  if (scheduledTimer !== null) return;
  scheduledTimer = setTimeout(decorate, 0);
}

async function refresh() {
  try {
    snapshot = await keyring.status();
    keyringError = null;
  } catch (error) {
    keyringError = error;
  }
  schedule();
}

if (appRoot && surfaceRoot) {
  new MutationObserver(schedule).observe(appRoot, { childList: true, subtree: true });
  new MutationObserver(schedule).observe(surfaceRoot, { childList: true, subtree: true });
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
  getBuiltinAppCatalog().then(() => {
    refresh();
    schedule();
  }).catch((error) => {
    keyringError = error;
  });
}
