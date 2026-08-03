import { GITHUB_ORIGINS, PublicGitHubClient, requestGitHubAccess, resolveWorldGraph, searchGreenwaysWorlds } from "./github-worlds.js";
import { FEATURED_WORLDS, featuredWorld } from "./featured-worlds.js";
import { invokeGreenways } from "./greenways-runtime.js";
import { WorldRenderer } from "./world-renderer.js";

const appRoot = document.querySelector("#world-app");
let renderer;

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
  location.search = query.toString();
}

function renderWelcome(error = "") {
  const state = queryState();
  appRoot.innerHTML = `<section class="world-welcome"><div class="world-card">
    <p class="eyebrow">Repo-first worlds</p><h1>Open a world</h1>
    <p>Load a public GitHub repository whose root <code>project.edn</code> describes one or more Gaussian splats.</p>
    ${error ? `<p role="alert"><code>${escapeHtml(error)}</code></p>` : ""}
    <section class="featured-worlds" aria-label="Featured worlds">
      ${FEATURED_WORLDS.map((world) => `<article class="featured-world">
        <span>${escapeHtml(world.format)}</span><h2>${escapeHtml(world.title)}</h2>
        <p>${escapeHtml(world.description)}</p>
        <div><button type="button" data-featured-world="${escapeHtml(world.id)}">Open world</button>
        <a href="${escapeHtml(world.attribution)}" target="_blank" rel="noreferrer">Source & attribution</a></div>
      </article>`).join("")}
    </section>
    <p class="world-divider"><span>or open any public repository</span></p>
    <form class="catalog-form" role="search">
      <label>Search greenways-worlds<input name="query" type="search" placeholder="garden, apartment, gaussian splat"></label>
      <button type="submit">Search worlds</button>
    </form>
    <div class="catalog-results" aria-live="polite"></div>
    <form class="world-form">
      <label>GitHub repository<input name="repo" type="url" required placeholder="https://github.com/owner/world" value="${escapeHtml(state.repository)}"></label>
      <label>Ref (optional)<input name="ref" placeholder="main, tag, or commit SHA" value="${escapeHtml(state.ref)}"></label>
      <label class="mode-control"><input name="strict" type="checkbox" ${state.mode === "strict" ? "checked" : ""}> Strict commits</label>
      <button type="submit">Allow GitHub & load</button>
    </form>
  </div></section>`;
  const worldForm = appRoot.querySelector(".world-form");
  const catalogForm = appRoot.querySelector(".catalog-form");
  const catalogResults = appRoot.querySelector(".catalog-results");
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
  const button = appRoot.querySelector("button");
  button.textContent = "Allow GitHub & load";
  appRoot.querySelector("form").repo.value = state.repository;
  appRoot.querySelector("form").ref.value = state.ref;
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
