import { GITHUB_ORIGINS, PublicGitHubClient, requestGitHubAccess, resolveWorldGraph, searchGreenwaysWorlds } from "./github-worlds.js";
import { FEATURED_WORLDS, featuredWorld } from "./featured-worlds.js";
import { invokeGreenways } from "./greenways-runtime.js";
import { WorldRenderer } from "./world-renderer.js";

const appRoot = document.querySelector("#world-app");
let renderer;

const GREENWAYS_MARK = ["0011100", "0100010", "1000001", "1001111", "1000001", "0100010", "0011100"];

function mosaicMark() {
  return `<span class="gw-mosaic-logo gw-mosaic-logo--greenways" role="img" aria-label="Greenways mosaic mark">${GREENWAYS_MARK.join("").split("").map((cell, index) => `<i data-on="${cell === "1"}" style="--gw-tone:${(Math.floor(index / 7) + index) % 5}"></i>`).join("")}</span>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function queryState() {
  const query = new URLSearchParams(location.search);
  return { repository: query.get("repo") || "", ref: query.get("ref") || "", mode: query.get("mode") === "strict" ? "strict" : "dev" };
}

function navigate(state) {
  const query = new URLSearchParams();
  if (state.repository) query.set("repo", state.repository);
  if (state.ref) query.set("ref", state.ref);
  if (state.mode === "strict") query.set("mode", "strict");
  const search = query.toString();
  location.assign(`${location.pathname}${search ? `?${search}` : ""}`);
}

function applyThemePreference(preference) {
  if (globalThis.GreenwaysTheme?.apply) return globalThis.GreenwaysTheme.apply(preference, true);
  const theme = preference === "auto"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : preference;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("greenways-theme", preference);
}

function renderWelcome(error = "") {
  const state = queryState();
  appRoot.innerHTML = `<section class="world-welcome"><div class="welcome-frame">
    <header class="welcome-header"><a href="./" class="welcome-brand">${mosaicMark()}<span>Greenways <em>Worlds</em></span></a><button class="welcome-theme" type="button" data-theme-toggle>Appearance</button></header>
    <div class="world-card welcome-card"><section class="welcome-hero">
      <div class="welcome-hero-art" role="img" aria-label="A curious young teenager entering a Greenways mosaic world"></div>
      <div class="welcome-hero-veil"></div><div class="welcome-hero-copy">
        <p class="eyebrow">OPEN WORLDS · HARA IN THE BROWSER</p><h1>Enter a<br><i>living world.</i></h1>
        <p>Follow a curious young explorer into places built and shared in the open. Hara reads each project graph; the browser opens its Gaussian-splat world.</p>
        <a class="hero-action" href="#world-collection">Discover the collection ↓</a>
      </div>
    </section><section class="world-browser" id="world-collection">
    <div class="section-intro"><p class="eyebrow">THE COLLECTION</p><h2>Three places.<br>One open garden.</h2></div>
    ${error ? `<p role="alert"><code>${escapeHtml(error)}</code></p>` : ""}
    <section class="featured-worlds" aria-label="Featured worlds">
      ${FEATURED_WORLDS.map((world) => `<article class="featured-world">
        <span>${escapeHtml(world.format)}</span><h2>${escapeHtml(world.title)}</h2>
        <p>${escapeHtml(world.description)}</p>
        <div><button type="button" data-featured-world="${escapeHtml(world.id)}">Open world</button>
        <a href="${escapeHtml(world.attribution)}" target="_blank" rel="noreferrer">Source & attribution</a></div>
      </article>`).join("")}
    </section>
    <p class="world-divider"><span>Find another place</span></p>
    <form class="catalog-form" role="search">
      <label>Search greenways-worlds<input name="query" type="search" placeholder="garden, apartment, gaussian splat"></label>
      <button type="submit">Search worlds</button>
    </form>
    <div class="catalog-results" aria-live="polite"></div>
    <form class="world-form">
      <label>GitHub repository<input name="repo" type="url" required placeholder="https://github.com/owner/world" value="${escapeHtml(state.repository)}"></label>
      <label>Ref (optional)<input name="ref" placeholder="main, tag, or commit SHA" value="${escapeHtml(state.ref)}"></label>
      <label class="mode-control"><input name="strict" type="checkbox" ${state.mode === "strict" ? "checked" : ""}> Strict commits</label>
      <button type="submit">Allow GitHub & open world</button>
    </form>
  </section></div><footer class="welcome-footer"><span>GREENWAYS / WORLDS</span><span>Repository-defined places · embedded Hara</span></footer></div></section>`;
  const worldForm = appRoot.querySelector(".world-form");
  const catalogForm = appRoot.querySelector(".catalog-form");
  const catalogResults = appRoot.querySelector(".catalog-results");
  appRoot.querySelector("[data-theme-toggle]").addEventListener("click", () => {
    const current = document.documentElement.dataset.themePreference || "auto";
    const next = current === "auto" ? "light" : current === "light" ? "dark" : "auto";
    applyThemePreference(next);
  });
  catalogForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    catalogResults.innerHTML = "<p>Searching…</p>";
    try {
      await requestGitHubAccess();
      const matches = await searchGreenwaysWorlds(new FormData(catalogForm).get("query"));
      catalogResults.innerHTML = matches.length ? matches.map((repository) => `<article>
        <div><strong>${escapeHtml(repository.name)}</strong><span>${escapeHtml(repository.description || "Gaussian splat world")}</span></div>
        <button type="button" data-catalog-repo="${escapeHtml(repository.html_url)}">Open</button>
      </article>`).join("") : "<p>No matching worlds.</p>";
      catalogResults.querySelectorAll("[data-catalog-repo]").forEach((button) => button.addEventListener("click", () => {
        navigate({ repository: button.dataset.catalogRepo, ref: "", mode: "dev" });
      }));
    } catch (searchError) {
      console.error("Greenways world search failed", searchError);
      catalogResults.innerHTML = `<p role="alert">${escapeHtml(searchError.message)}</p>`;
    }
  });
  worldForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const submit = event.currentTarget.querySelector("button");
    submit.disabled = true;
    submit.textContent = "Requesting access…";
    try {
      await requestGitHubAccess();
      navigate({ repository: data.get("repo"), ref: data.get("ref"), mode: data.has("strict") ? "strict" : "dev" });
    } catch (requestError) {
      console.error("Greenways GitHub permission request failed", requestError);
      renderWelcome(requestError.message);
    }
  });
  appRoot.querySelectorAll("[data-featured-world]").forEach((button) => button.addEventListener("click", async () => {
    const world = featuredWorld(button.dataset.featuredWorld);
    if (!world) return;
    button.disabled = true;
    button.textContent = "Requesting access…";
    try {
      await requestGitHubAccess();
      navigate({ repository: world.repository, ref: "", mode: "dev" });
    } catch (requestError) {
      console.error("Greenways GitHub permission request failed", requestError);
      renderWelcome(requestError.message);
    }
  }));
}

async function hasGitHubAccess() {
  if (!globalThis.chrome?.permissions) return true;
  return chrome.permissions.contains({ origins: [...GITHUB_ORIGINS] });
}

function renderPermission(state) {
  renderWelcome();
  const form = appRoot.querySelector(".world-form");
  const button = form.querySelector('button[type="submit"]');
  button.textContent = "Allow GitHub & load";
  form.elements.repo.value = state.repository;
  form.elements.ref.value = state.ref;
}

function renderShell(state) {
  appRoot.innerHTML = `<section class="world-shell">
    <div class="world-canvas"><canvas aria-label="Gaussian splat world"></canvas></div>
    <div class="world-overlay">
      <div class="world-status" role="status"><strong>Reading world…</strong><span>${escapeHtml(state.repository)}${state.ref ? ` @ ${escapeHtml(state.ref)}` : ""}</span></div>
      <nav class="world-controls" aria-label="World controls">
        <button data-action="reset">Reset view</button><button data-action="mode">${state.mode === "strict" ? "Dev mode" : "Strict mode"}</button><button data-action="change">Change world</button>
      </nav>
    </div><div class="diagnostic-slot"></div>
  </section>`;
  appRoot.querySelector('[data-action="change"]').addEventListener("click", () => { location.search = ""; });
  appRoot.querySelector('[data-action="mode"]').addEventListener("click", () => navigate({ ...state, mode: state.mode === "strict" ? "dev" : "strict" }));
  appRoot.querySelector('[data-action="reset"]').addEventListener("click", () => renderer?.resetCamera());
  return {
    canvas: appRoot.querySelector("canvas"),
    title: appRoot.querySelector(".world-status strong"),
    detail: appRoot.querySelector(".world-status span"),
    diagnostics: appRoot.querySelector(".diagnostic-slot"),
  };
}

function showDiagnostics(slot, diagnostics) {
  if (!diagnostics.length) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<details class="world-diagnostics" open><summary>World incomplete — ${diagnostics.length} issue${diagnostics.length === 1 ? "" : "s"}</summary><ul>${diagnostics.map((item) => `<li>${escapeHtml(item.path || "render")}: ${escapeHtml(item.message)}</li>`).join("")}</ul></details>`;
}

function renderFatal(error, state) {
  renderer?.destroy();
  renderer = undefined;
  appRoot.innerHTML = `<section class="world-fatal"><div class="world-card"><p class="eyebrow">World could not open</p><h1>Load failed</h1><code>${escapeHtml(error.message || error)}</code><form class="world-form"><button type="submit">Edit source</button></form></div></section>`;
  appRoot.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); renderWelcome(error.message); });
}

async function loadWorld(state) {
  const view = renderShell(state);
  let stage = "HAL world/open";
  try {
    const opening = invokeGreenways("world/open", [state.repository, state.ref, state.mode]);
    const resolveEffect = opening.effects.find(({ effect, method }) => effect === "github" && method === "resolve-world");
    if (!resolveEffect) throw new Error("HAL world/open did not request a repository graph");
    const [repository, ref, mode] = resolveEffect.args;
    stage = "GitHub world graph resolution";
    const graph = await resolveWorldGraph({ repository, ref, mode, client: new PublicGitHubClient() });
    stage = "HAL world/render";
    const rendering = invokeGreenways("world/render", [graph]);
    const renderEffect = rendering.effects.find(({ effect, method }) => effect === "scene" && method === "render-world");
    if (!renderEffect) throw new Error("HAL world/render did not produce a scene command");
    const diagnostics = [...graph.diagnostics];
    let loaded = 0;
    renderer = new WorldRenderer(view.canvas, {
      background: graph.project.background,
      camera: graph.project.camera,
      onLayer: ({ layer, status, error }) => {
        if (status === "loaded") loaded += 1;
        else {
          console.error(`Greenways Gaussian splat layer failed: ${layer.id}`, error, { layer });
          diagnostics.push({ path: layer.id, message: error?.message || "Gaussian splat failed to load" });
        }
        view.title.textContent = `${loaded}/${graph.layers.length} layers loaded${diagnostics.length ? " — incomplete" : ""}`;
        showDiagnostics(view.diagnostics, diagnostics);
      },
    });
    view.title.textContent = `Loading ${graph.layers.length} layer${graph.layers.length === 1 ? "" : "s"}…`;
    view.detail.textContent = `${graph.repository.owner}/${graph.repository.repo} @ ${graph.commit.slice(0, 12)} · ${state.mode}`;
    showDiagnostics(view.diagnostics, diagnostics);
    stage = "Gaussian splat rendering";
    await renderer.loadLayers(graph.layers);
    view.title.textContent = `${loaded}/${graph.layers.length} layers loaded${diagnostics.length ? " — incomplete" : ""}`;
  } catch (error) {
    const failure = new Error(`${stage}: ${error?.message || error}`, { cause: error });
    console.error(`Greenways world load failed during ${stage}`, failure, { ...state, originalError: error });
    renderFatal(failure, state);
  }
}

async function start() {
  const state = queryState();
  if (!state.repository) return renderWelcome();
  if (await hasGitHubAccess()) return loadWorld(state);
  renderPermission(state);
}

window.addEventListener("beforeunload", () => renderer?.destroy(), { once: true });
start().catch((error) => {
  const state = queryState();
  console.error("Greenways world startup failed", error, state);
  renderFatal(new Error(`World startup: ${error?.message || error}`, { cause: error }), state);
});
