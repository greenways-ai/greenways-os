import {
  actionBody,
  canonical,
  createEvidenceBundle,
  createFurnishingBundle,
  createIdentity,
  includeAction,
  randomId,
  sha256,
  signAction,
  verifyEvidenceBundle,
  verifyFurnishingBundle,
  verifyPublicCredential
} from "./protocol.js";
import {
  acceptIdeaArrangement,
  acceptProposal,
  addIdea,
  addArtifact,
  addRepositoryMap,
  classifyArtifact,
  createPublicationCheckpoint,
  createProject,
  moveIdea,
  proposeIdeaArrangement,
  readiness,
  runReleaseSteward,
  updateArtifactDescription,
  workflowRoot
} from "./workflow.js";
import { migrateLegacyIdentityAndPersonalChain } from "./identity-migration.js";
import { store, withOriginLock } from "./storage.js";

const app = document.getElementById("app");
const view = document.body.dataset.view;
const state = {
  identityRecord: null,
  project: null,
  actions: [],
  inclusions: [],
  workflowRoot: await workflowRoot(),
  hestiaConnected: false,
  spaceMode: "home",
  note: ""
};
let recordPending = Promise.resolve();

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
})[character]);

async function load() {
  const migration = await withOriginLock(
    "personal-chain",
    () => migrateLegacyIdentityAndPersonalChain(store),
  );
  state.identityRecord = await store.get("identity", "owner") ?? null;
  state.project = await store.get("projects", "active") ?? null;
  state.actions = await store.values("actions");
  state.inclusions = (await store.values("inclusions")).sort((a, b) => a.sequence - b.sequence);
  state.hestiaConnected = Boolean(await store.get("settings", "hestia"));
  if (migration.migrated && migration.inclusionCount > 0) {
    state.note = `Your local evidence chain was upgraded with a signed audit bridge; ${migration.queuedRoots.length} record${migration.queuedRoots.length === 1 ? " is" : "s are"} ready for Hestia.`;
  }
  render();
}

async function persistProject() {
  if (state.project) await store.put("projects", "active", state.project);
}

function serializeRecord(operation) {
  const current = recordPending.then(() => withOriginLock("personal-chain", operation));
  recordPending = current.catch(() => {});
  return current;
}

async function storedSignedRecords() {
  const [actions, inclusions] = await Promise.all([
    store.values("actions"),
    store.values("inclusions"),
  ]);
  inclusions.sort((a, b) => a.sequence - b.sequence);
  return { actions, inclusions };
}

function record(type, payload, subject = state.project?.id ?? null) {
  return serializeRecord(async () => {
    const persisted = await storedSignedRecords();
    const { identity, privateKey } = state.identityRecord;
    const body = actionBody({
      type, actor: identity, workflowRoot: state.workflowRoot, subject, payload
    });
    const action = await signAction(body, privateKey);
    const previous = persisted.inclusions.at(-1) ?? null;
    const inclusion = await includeAction(identity, privateKey, previous, action);
    await store.putSignedRecord(action, inclusion);
    state.actions = [...persisted.actions, action];
    state.inclusions = [...persisted.inclusions, inclusion];
    return action;
  });
}

function retainSignedAction(action) {
  return serializeRecord(async () => {
    const persisted = await storedSignedRecords();
    const { identity, privateKey } = state.identityRecord;
    const previous = persisted.inclusions.at(-1) ?? null;
    const inclusion = await includeAction(identity, privateKey, previous, action);
    await store.putSignedRecord(action, inclusion);
    state.actions = [...persisted.actions, action];
    state.inclusions = [...persisted.inclusions, inclusion];
  });
}

function header() {
  const pending = state.actions.length - state.inclusions.length;
  const protection = state.hestiaConnected ? "Hestia connected" : "Protected locally";
  return `<header class="topbar">
    <div class="brand"><span class="brand-mark">g</span><span><strong>Greenways OS</strong><small>Creative confidence layer</small></span></div>
    <span class="health"><i></i>${escapeHtml(protection)}${pending > 0 ? ` · ${pending} pending` : ""}</span>
  </header>`;
}

function onboarding() {
  return `${header()}<main class="content">
    <section class="hero"><p class="eyebrow">Private by default</p><h1>Your space.<br>Your imagination.</h1>
    <p class="lede">Create a key-controlled home for ideas, projects, repositories, collaborators, and AI services. Your handle is an alias; your keys remain yours.</p></section>
    <section class="card"><h2>Create your Greenways identity</h2>
      <form data-form="identity"><label>Creative handle<input name="handle" required placeholder="river.studio" autocomplete="nickname"></label>
      <p class="muted">A signing key is created in this browser. Greenways never receives the private key.</p>
      <button class="primary" type="submit">Create identity</button></form>
      <button class="world-link" data-action="open-world">Open a GitHub world →</button>
    </section></main>${footer()}`;
}

function projectEmpty() {
  const identity = state.identityRecord.identity;
  return `${header()}<main class="content">
    <section class="hero"><p class="eyebrow">@${escapeHtml(identity.handle)}</p><h1>Make a space<br>that thinks with you.</h1>
    <p class="lede">Your home can hold ideas, code, research, visual work, plans, and tools. Add services only when they help.</p></section>
    <section class="card"><h2>Create your home space</h2>
      <form data-form="project"><label>Space name<input name="title" required placeholder="Chris's workshop"></label>
      <button class="primary" type="submit">Create private space</button></form>
      <button class="world-link" data-action="open-world">Open a GitHub world →</button>
    </section></main>${footer()}`;
}

function projectSummary() {
  const status = readiness(state.project);
  const identity = state.identityRecord.identity;
  return `${header()}<main class="content">
    ${view === "panel" ? `<section class="panel-home"><p class="eyebrow">@${escapeHtml(identity.handle)}</p><h1>${escapeHtml(state.project.title)}</h1><p class="muted">Your private spatial home.</p><button class="primary" data-action="open-studio">Enter space →</button><button class="world-link" data-action="open-world">Open a GitHub world →</button><button class="credential-link" data-action="proof">Credentials · ${state.actions.length} signatures</button></section>` : studioSpace(status)}
    </main>${dialogs()}${footer()}`;
}

function studioSpace(status) {
  const modes = [["home", "Home"], ["ideas", "Ideas"], ["repositories", "Repos"], ["friends", "Friends"], ["credentials", "Credentials"]];
  return `<section class="space-frame">
    <nav class="space-switcher" aria-label="Space views">${modes.map(([mode, label]) => `<button class="${state.spaceMode === mode ? "active" : ""}" data-space-mode="${mode}">${label}</button>`).join("")}<i></i><button class="icon-button" data-action="publish-furnishing-shared" aria-label="Publish shareable furnishing">↗</button></nav>
    ${state.note ? `<div class="glass-toast">${escapeHtml(state.note)}</div>` : ""}
    ${state.spaceMode === "ideas" ? ideaSpace() : state.spaceMode === "repositories" ? repositorySpace() : state.spaceMode === "friends" ? friendsSpace() : state.spaceMode === "credentials" ? credentialsSpace() : homeRoom(status)}
    <footer class="space-dock"><span><i></i>${state.hestiaConnected ? "Backed up" : "Local"}</span><button data-action="publish-furnishing-personal">Keep on chain</button><button data-action="import-furnishing">Import</button><button data-action="connect-hestia">${state.hestiaConnected ? "Hestia" : "Pair Hestia"}</button></footer>
  </section>`;
}

function friendsSpace() {
  const friends = state.project.friends ?? [];
  return `<section class="friends-space" aria-label="Friends">
    <div class="friends-head"><div><p class="eyebrow">Your circle</p><h2>Friends</h2><p>People you recognise by identity and key—not followers, suggestions, or engagement scores.</p></div><button class="primary" data-action="import-friend">＋ Add credential</button></div>
    ${friends.length ? `<div class="friend-grid">${friends.map((friend) => `<article class="friend-card"><div class="friend-avatar">${escapeHtml(friend.handle.slice(0, 1).toUpperCase())}</div><div><strong>@${escapeHtml(friend.handle)}</strong><span>Key verified locally</span></div><i></i><code>${escapeHtml(friend.keyId)}</code><button data-copy="${escapeHtml(friend.identityId)}">Copy identity</button></article>`).join("")}</div>` : `<div class="friends-empty"><div>◎</div><strong>Your circle is private and empty.</strong><span>Import a friend’s public Greenways credential to recognise their key.</span><button data-action="import-friend">Add your first friend</button></div>`}
    <p class="friends-note">Adding a friend records who you intend to recognise. It does not grant access to your room or automatically share anything.</p>
  </section>`;
}

function credentialsSpace() {
  const identity = state.identityRecord.identity;
  return `<section class="credentials-space" aria-label="Credentials">
    <div class="credential-hero"><div class="credential-orb">${escapeHtml(identity.handle.slice(0, 1).toUpperCase())}</div><div><p class="eyebrow">Key-controlled identity</p><h2>@${escapeHtml(identity.handle)}</h2><span>Created ${escapeHtml(new Date(identity.createdAt).toLocaleDateString())}</span></div><b>VERIFIED LOCALLY</b></div>
    <div class="credential-glass"><label>Identity</label><code>${escapeHtml(identity.identityId)}</code><button data-copy="${escapeHtml(identity.identityId)}">Copy</button></div>
    <div class="credential-glass"><label>Controller key</label><code>${escapeHtml(identity.keyId)}</code><button data-copy="${escapeHtml(identity.keyId)}">Copy</button></div>
    <div class="credential-stats"><div><strong>${state.actions.length}</strong><span>signed actions</span></div><div><strong>${state.inclusions.length}</strong><span>chain entries</span></div><div><strong>${(state.project.personalFurnishings ?? []).length}</strong><span>furnishings</span></div></div>
    <div class="credential-actions"><button class="primary" data-action="export-credential">Export public credential</button><button data-action="proof">Inspect proof</button><button data-action="export">Export evidence</button><button data-action="connect-hestia">${state.hestiaConnected ? "Manage Hestia" : "Back up with Hestia"}</button></div>
    <p class="credential-warning">Your private signing key never appears here and is never included in an export.</p>
  </section>`;
}

function homeRoom(status) {
  return `<section class="home-space" aria-label="Your home space">
    <div class="room-shell">
      <div class="room-scene" aria-hidden="true">
        <div class="room-wall room-wall-back"></div><div class="room-wall room-wall-left"></div><div class="room-wall room-wall-right"></div><div class="room-floor"></div>
        <div class="room-window"><i></i><i></i><i></i><i></i></div>
        <div class="room-sun"></div><div class="room-plant"><i></i><b></b><b></b><b></b></div>
        <div class="room-desk"><i></i><b></b><b></b></div><div class="room-console"><i></i><i></i><i></i></div>
        <div class="room-archive"><i></i><i></i><i></i></div><div class="room-door"></div>
      </div>
      <nav class="room-nav" aria-label="Home space stations">
        <button class="room-station station-ideas" data-space-mode="ideas" aria-label="Open idea space"><span>Ideas</span><strong>${(state.project.ideas ?? []).length || "Empty"}</strong></button>
        <button class="room-station station-work" data-space-mode="repositories" aria-label="Open repository space"><span>Repositories</span><strong>${(state.project.repositories ?? []).length || "Map one"}</strong></button>
        <button class="room-station station-steward" data-action="add-idea" aria-label="Add an idea"><span>New</span><strong>Add idea</strong></button>
        <button class="room-station station-hestia" data-space-mode="credentials" aria-label="Open credentials"><span>Identity</span><strong>@${escapeHtml(state.identityRecord.identity.handle)}</strong></button>
      </nav>
      <div class="room-caption"><span class="live-dot"></span> Local room · private by default <b>${(state.project.ideas ?? []).length} ideas · ${(state.project.repositories ?? []).length} repositories</b></div>
    </div>
  </section>`;
}

function ideaSpace() {
  const ideas = state.project.ideas ?? [];
  const proposal = state.project.ideaLayoutProposal;
  return `<section class="idea-room" aria-label="3D idea space">
    <div class="card-head"><div><p class="eyebrow">Spatial thinking</p><h2>Arrange ideas in the room</h2><p class="muted">Move thoughts across the wall and nearer or farther in depth. AI can propose a layout; only your acceptance applies it.</p></div>
      <div class="actions"><button data-action="add-idea">＋ Add idea</button><button data-action="arrange-ideas" ${ideas.length < 2 ? "disabled" : ""}>Ask AI to arrange</button></div></div>
    <div class="idea-stage" aria-label="Idea canvas">
      <div class="idea-grid"></div>
      ${ideas.length ? ideas.map((idea) => `<article class="idea-note idea-${escapeHtml(idea.color)}" style="--idea-x:${idea.position.x}%;--idea-y:${idea.position.y}%;--idea-z:${idea.position.z}px" data-idea="${escapeHtml(idea.id)}">
        <span>${idea.position.z > 8 ? "foreground" : idea.position.z < -8 ? "background" : "middle"}</span><strong>${escapeHtml(idea.title)}</strong>${idea.body ? `<p>${escapeHtml(idea.body)}</p>` : ""}
        <div class="idea-controls" aria-label="Move ${escapeHtml(idea.title)}"><button data-move="left" data-idea-id="${escapeHtml(idea.id)}" aria-label="Move left">←</button><button data-move="right" data-idea-id="${escapeHtml(idea.id)}" aria-label="Move right">→</button><button data-move="back" data-idea-id="${escapeHtml(idea.id)}" aria-label="Move farther">−</button><button data-move="forward" data-idea-id="${escapeHtml(idea.id)}" aria-label="Move nearer">＋</button></div>
      </article>`).join("") : `<div class="idea-empty"><strong>The room is waiting for its first idea.</strong><span>Add a thought, fragment, reference, question, or possibility.</span></div>`}
    </div>
    ${proposal?.status === "proposed" ? `<div class="arrangement-proposal"><div><span>AI ARRANGEMENT PROPOSAL</span><strong>${escapeHtml(proposal.summary)}</strong><small>Intent: ${escapeHtml(proposal.intent)} · ${escapeHtml(proposal.limitations[0])}</small></div><button class="primary" data-action="accept-arrangement">Accept layout</button></div>` : proposal?.status === "accepted" ? `<div class="arrangement-accepted">✓ AI layout accepted by your key. You can continue moving every idea.</div>` : ""}
  </section>`;
}

function repositorySpace() {
  const repositories = state.project.repositories ?? [];
  const repository = repositories.at(-1);
  return `<section class="repository-space" aria-label="Repository space"><div class="card-head"><div><p class="eyebrow">Project landscape</p><h2>${repository ? escapeHtml(repository.name) : "Visualize a repository"}</h2><p class="muted">Folder structure stays local. Contents are never uploaded.</p></div><button data-action="map-repository">${repository ? "Map another" : "Choose folder"}</button></div>
    ${repository ? `<div class="repo-stage"><div class="repo-origin"><strong>${escapeHtml(repository.name)}</strong><span>${repository.fileCount} files</span></div>${repository.nodes.map((node) => `<article class="repo-node" style="--repo-x:${node.position.x}%;--repo-y:${node.position.y}%;--repo-z:${node.position.z}px"><i></i><strong>${escapeHtml(node.label)}</strong><small>${node.count} file${node.count === 1 ? "" : "s"}</small></article>`).join("")}</div>` : `<div class="repo-empty">A repository becomes a landscape of folders, systems, and relationships.</div>`}
  </section>`;
}

function qualityList() {
  if (!state.project.results.length) return `<div class="empty">Run Release Steward when you want a readiness check.</div>`;
  return `<div class="list">${state.project.results.map((item) => `<div class="row">
    <span class="status-icon ${item.status === "passed" ? "" : "attention"}">${item.status === "passed" ? "✓" : "!"}</span>
    <div class="row-main"><strong>${escapeHtml(item.service.replaceAll("-", " "))}</strong><small>${escapeHtml(item.summary)}</small>
    ${item.limitations.length ? `<small>Limit: ${escapeHtml(item.limitations.join(" "))}</small>` : ""}</div>
    <span class="pill ${item.status === "passed" ? "good" : "attention"}">${escapeHtml(item.class)}</span></div>`).join("")}</div>`;
}

function artifactList() {
  if (!state.project.artifacts.length) return `<div class="empty">Add audio, artwork, video, or text to begin.</div>`;
  return `<div class="list">${state.project.artifacts.map((artifact) => `<div class="row"><span class="status-icon">${artifact.kind.slice(0,1).toUpperCase()}</span>
    <div class="row-main"><strong>${escapeHtml(artifact.name)}</strong><small>${escapeHtml(artifact.kind)} · ${artifact.size} bytes · @${escapeHtml(artifact.contributorHandle)}</small>
    <small class="proof">${escapeHtml(artifact.root)}</small>
    ${["artwork", "video"].includes(artifact.kind) ? `<form data-description="${escapeHtml(artifact.id)}"><label>Accessible description<input name="description" value="${escapeHtml(artifact.description)}" placeholder="Describe the visual work"><button type="submit">Save description</button></label></form>` : ""}
    </div></div>`).join("")}</div>`;
}

function proposalList() {
  if (!state.project.proposals.length) return `<div class="empty">No proposals waiting.</div>`;
  return `<div class="list">${state.project.proposals.map((proposal) => `<div class="row"><div class="row-main"><strong>${escapeHtml(proposal.service)}</strong>
    <small>${escapeHtml(proposal.summary)}</small></div>${proposal.status === "proposed" ? `<button data-accept="${escapeHtml(proposal.id)}">Accept</button>` : `<span class="pill good">accepted</span>`}</div>`).join("")}</div>`;
}

function dialogs() {
  return `<dialog data-dialog="idea"><form method="dialog" data-form="idea"><h2>Place an idea</h2><p class="muted">It begins as a private object in this project room.</p>
    <label>Idea title<input name="title" required placeholder="A repository map I can walk through"></label>
    <label>Notes<textarea name="body" placeholder="Fragments, questions, connections…"></textarea></label>
    <label>Colour<select name="color"><option value="fern">Fern</option><option value="sun">Sun</option><option value="sky">Sky</option><option value="clay">Clay</option></select></label>
    <menu><button value="cancel">Cancel</button><button class="primary" value="default">Place in room</button></menu></form></dialog>
    <dialog data-dialog="arranger"><form method="dialog" data-form="arranger"><h2>Ask the idea arranger</h2><p class="muted">Describe the relationship you want to see. The agent may propose positions, but cannot apply them.</p>
    <label>Arrangement intent<textarea name="intent" required>Group related ideas and make the creative journey easy to read.</textarea></label>
    <menu><button value="cancel">Cancel</button><button class="primary" value="default">Create proposal</button></menu></form></dialog>
    <dialog data-dialog="proof"><h2>Proof, when you need it</h2><p class="muted">These are personal-chain records, not a global blockchain or legal-title declaration.</p>
      <div class="metric-row"><div class="metric"><strong>${state.actions.length}</strong><small>signed actions</small></div><div class="metric"><strong>${state.inclusions.length}</strong><small>inclusions</small></div><div class="metric"><strong>1</strong><small>controller key</small></div></div>
      <p class="proof">Identity: ${escapeHtml(state.identityRecord.identity.identityId)}<br>Key: ${escapeHtml(state.identityRecord.identity.keyId)}<br>Policy: ${escapeHtml(state.workflowRoot)}</p>
      <menu><button value="cancel">Close</button><button class="primary" data-action="export">Export evidence</button></menu></dialog>
    <input data-file-input type="file" multiple hidden accept="audio/*,image/*,video/*,text/*,.md,.json,.csv">
    <input data-repository-input type="file" webkitdirectory directory multiple hidden>
    <input data-furnishing-input type="file" accept="application/json,.json" hidden>
    <input data-friend-input type="file" accept="application/json,.json" hidden>`;
}

function footer() {
  return `<footer class="footer">GREENWAYS OS 0.2 · LOCAL FIRST · KEYS STAY WITH YOU</footer>`;
}

function render() {
  app.innerHTML = !state.identityRecord ? onboarding() : !state.project ? projectEmpty() : projectSummary();
  bind();
}

function bind() {
  app.querySelector('[data-form="identity"]')?.addEventListener("submit", createIdentitySubmit);
  app.querySelector('[data-form="project"]')?.addEventListener("submit", createProjectSubmit);
  app.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => dispatch(button.dataset.action, button)));
  app.querySelectorAll("[data-space-mode]").forEach((button) => button.addEventListener("click", () => { state.spaceMode = button.dataset.spaceMode; render(); }));
  app.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => { await navigator.clipboard.writeText(button.dataset.copy); button.textContent = "Copied"; }));
  app.querySelectorAll("[data-accept]").forEach((button) => button.addEventListener("click", () => acceptServiceProposal(button.dataset.accept)));
  app.querySelectorAll("[data-description]").forEach((form) => form.addEventListener("submit", saveDescription));
  app.querySelectorAll("[data-move]").forEach((button) => button.addEventListener("click", () => moveIdeaInRoom(button.dataset.ideaId, button.dataset.move)));
  app.querySelector("[data-file-input]")?.addEventListener("change", importFiles);
  app.querySelector("[data-repository-input]")?.addEventListener("change", mapRepository);
  app.querySelector("[data-furnishing-input]")?.addEventListener("change", importFurnishing);
  app.querySelector("[data-friend-input]")?.addEventListener("change", importFriend);
  app.querySelector('[data-form="idea"]')?.addEventListener("submit", addIdeaSubmit);
  app.querySelector('[data-form="arranger"]')?.addEventListener("submit", arrangeIdeasSubmit);
}

async function createIdentitySubmit(event) {
  event.preventDefault();
  const identityRecord = await createIdentity(new FormData(event.currentTarget).get("handle"));
  state.identityRecord = identityRecord;
  await store.put("identity", "owner", identityRecord);
  render();
}

async function createProjectSubmit(event) {
  event.preventDefault();
  state.project = createProject(new FormData(event.currentTarget).get("title"), state.identityRecord.identity);
  await record("@greenways/project-created", { title: state.project.title, workflowRoot: state.workflowRoot });
  await persistProject();
  render();
}

async function dispatch(action) {
  if (action === "open-studio") {
    if (globalThis.chrome?.runtime) await chrome.runtime.sendMessage({ type: "greenways/open-studio" });
    else location.href = "studio.html";
  } else if (action === "open-world") {
    if (globalThis.chrome?.runtime) await chrome.runtime.sendMessage({ type: "greenways/open-world" });
    else location.href = "world.html";
  } else if (action === "import") {
    app.querySelector("[data-file-input]").click();
  } else if (action === "map-repository") {
    app.querySelector("[data-repository-input]").click();
  } else if (action === "publish-furnishing-personal") {
    await publishFurnishing("personal");
  } else if (action === "publish-furnishing-shared") {
    await publishFurnishing("shared");
  } else if (action === "import-furnishing") {
    app.querySelector("[data-furnishing-input]").click();
  } else if (action === "import-friend") {
    app.querySelector("[data-friend-input]").click();
  } else if (action === "add-idea") {
    app.querySelector('[data-dialog="idea"]').showModal();
  } else if (action === "arrange-ideas") {
    app.querySelector('[data-dialog="arranger"]').showModal();
  } else if (action === "accept-arrangement") {
    state.project = acceptIdeaArrangement(state.project);
    await record("@greenways/idea-arrangement-accepted", { proposalId: state.project.ideaLayoutProposal.id });
    await persistProject();
    state.note = "The proposed arrangement was applied by your acceptance.";
    render();
  } else if (action === "run-steward") {
    state.project = await runReleaseSteward(state.project);
    await record("@greenways/service-completed", {
      service: "release-steward", results: state.project.results.map(({ service, class: resultClass, status }) => ({ service, class: resultClass, status }))
    });
    await persistProject();
    state.note = "Workspace checks completed without changing anything in your space.";
    render();
  } else if (action === "proof") {
    app.querySelector('[data-dialog="proof"]').showModal();
  } else if (action === "connect-hestia") {
    location.assign("launcher.html#app-hestia-connector");
  } else if (action === "publish") {
    await publishCheckpoint();
  } else if (action === "verify") {
    location.href = "verifier.html";
  } else if (action === "export") {
    await exportEvidence();
  } else if (action === "export-credential") {
    const identity = state.identityRecord.identity;
    downloadJson({ protocol: "greenways-public-credential/1", identity, exportedAt: new Date().toISOString() }, `${slug(identity.handle)}-credential.json`);
    state.note = "Public credential exported without your private key.";
    render();
  }
}

async function importFriend(event) {
  try {
    const credential = JSON.parse(await event.target.files[0].text());
    if (!await verifyPublicCredential(credential)) throw new Error("Public credential or key ID is invalid");
    const friend = credential.identity;
    state.project = { ...state.project, friends: [...(state.project.friends ?? []).filter((item) => item.identityId !== friend.identityId), friend] };
    await record("@greenways/friend-recognised", { identityId: friend.identityId, handle: friend.handle, keyId: friend.keyId }, friend.identityId);
    await persistProject();
    state.spaceMode = "friends";
    state.note = `@${friend.handle} added to your private circle.`;
  } catch (error) {
    state.note = `Friend credential rejected: ${error.message}`;
  }
  event.target.value = "";
  render();
}

async function publishFurnishing(visibility) {
  const { identity, privateKey } = state.identityRecord;
  const bundle = await createFurnishingBundle({
    identity, privateKey, title: state.project.title,
    ideas: state.project.ideas ?? [], repositories: state.project.repositories ?? [],
    parents: state.project.furnishingParents ?? [], visibility
  });
  await retainSignedAction(bundle.publication);
  state.project = { ...state.project, personalFurnishings: [...(state.project.personalFurnishings ?? []), bundle.root] };
  await persistProject();
  if (visibility === "shared") downloadJson(bundle, `${slug(state.project.title)}-furnishing.json`);
  state.note = visibility === "shared"
    ? "Signed furnishing published as a shareable download."
    : "Signed furnishing retained on your personal chain.";
  render();
}

async function importFurnishing(event) {
  try {
    const bundle = JSON.parse(await event.target.files[0].text());
    const verification = await verifyFurnishingBundle(bundle);
    if (!verification.valid) throw new Error(verification.errors.join(", "));
    const furnishing = bundle.furnishing;
    state.project = {
      ...state.project,
      ideas: [...(state.project.ideas ?? []), ...(furnishing.ideas ?? []).map((idea) => ({ ...idea, id: randomId("idea"), importedFrom: furnishing.id }))],
      repositories: [...(state.project.repositories ?? []), ...(furnishing.repositories ?? []).map((repo) => ({ ...repo, id: randomId("repository"), importedFrom: furnishing.id }))],
      furnishingParents: [...new Set([...(state.project.furnishingParents ?? []), bundle.root])]
    };
    await record("@greenways/furnishing-imported", { furnishingId: furnishing.id, publicationRoot: bundle.publication.root, creator: bundle.creator.identityId }, furnishing.id);
    await persistProject();
    state.note = `Verified furnishing “${furnishing.title}” added to your room.`;
  } catch (error) {
    state.note = `Furnishing import rejected: ${error.message}`;
  }
  event.target.value = "";
  render();
}

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "greenways-room";

function downloadJson(value, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function mapRepository(event) {
  state.project = addRepositoryMap(state.project, event.target.files);
  state.spaceMode = "repositories";
  const repository = state.project.repositories.at(-1);
  await record("@greenways/repository-mapped", { repositoryId: repository.id, name: repository.name, fileCount: repository.fileCount, nodes: repository.nodes.map(({ label, count }) => ({ label, count })) }, repository.id);
  event.target.value = "";
  await persistProject();
  state.note = `${repository.name} is now mapped in your room. File contents stayed local.`;
  render();
}

async function addIdeaSubmit(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  state.project = addIdea(state.project, { title: data.get("title"), body: data.get("body"), color: data.get("color") });
  state.spaceMode = "ideas";
  const idea = state.project.ideas.at(-1);
  await record("@greenways/idea-created", { ideaId: idea.id, title: idea.title, position: idea.position }, idea.id);
  await persistProject();
  state.note = "Idea placed in your private room.";
  render();
}

async function arrangeIdeasSubmit(event) {
  event.preventDefault();
  const intent = new FormData(event.currentTarget).get("intent");
  state.project = proposeIdeaArrangement(state.project, intent);
  await record("@greenways/service-proposal-created", { service: "idea-arranger", proposal: state.project.ideaLayoutProposal });
  await persistProject();
  state.note = "The idea arranger proposed a layout. Nothing moved yet.";
  render();
}

async function moveIdeaInRoom(ideaId, direction) {
  const deltas = { left: { x: -7 }, right: { x: 7 }, back: { z: -14 }, forward: { z: 14 } };
  state.project = moveIdea(state.project, ideaId, deltas[direction] ?? {});
  await record("@greenways/idea-positioned", { ideaId, position: state.project.ideas.find((idea) => idea.id === ideaId).position }, ideaId);
  await persistProject();
  render();
}

async function importFiles(event) {
  const identity = state.identityRecord.identity;
  for (const file of event.target.files) {
    const root = await sha256(new Uint8Array(await file.arrayBuffer()));
    const action = await record("@greenways/contribution-claimed", {
      artifactRoot: root, name: file.name, mediaType: file.type || "application/octet-stream", action: "created"
    }, root);
    state.project = addArtifact(state.project, {
      id: randomId("artifact"), root, name: file.name, kind: classifyArtifact(file),
      size: file.size, mediaType: file.type || "application/octet-stream",
      contributor: identity.identityId, contributorHandle: identity.handle,
      claimActionRoot: action.root, description: ""
    });
  }
  event.target.value = "";
  state.project.results = [];
  state.project.proposals = [];
  await persistProject();
  render();
}

async function acceptServiceProposal(proposalId) {
  state.project = acceptProposal(state.project, proposalId);
  await record("@greenways/proposal-accepted", { proposalId });
  await persistProject();
  state.note = "Proposal accepted by your key. No artifact was changed automatically.";
  render();
}

async function saveDescription(event) {
  event.preventDefault();
  const description = new FormData(event.currentTarget).get("description");
  state.project = updateArtifactDescription(state.project, event.currentTarget.dataset.description, description);
  await record("@greenways/artifact-metadata-updated", {
    artifactId: event.currentTarget.dataset.description,
    fields: ["description"]
  });
  await persistProject();
  state.note = "Description saved. Run Release Steward again to refresh readiness.";
  render();
}

async function publishCheckpoint() {
  try {
    const checkpoint = createPublicationCheckpoint(state.project, state.workflowRoot);
    const action = await record("@greenways/checkpoint-published", checkpoint, checkpoint.id);
    state.project = {
      ...state.project,
      state: "published",
      publication: { checkpoint, actionRoot: action.root, publishedAt: new Date().toISOString() }
    };
    await persistProject();
    state.note = "Release checkpoint signed, recorded, and ready for evidence export.";
  } catch (error) {
    state.note = error.message;
  }
  render();
}

async function exportEvidence() {
  const bundle = await createEvidenceBundle({
    identity: state.identityRecord.identity,
    actions: state.actions,
    inclusions: state.inclusions,
    project: state.project,
    personalChainMigrations: state.identityRecord.personalChainMigrations ?? [],
  });
  const verification = await verifyEvidenceBundle(bundle);
  if (!verification.valid) throw new Error(`Evidence verification failed: ${verification.errors.join(", ")}`);
  downloadJson(bundle, `${slug(state.project.title)}-evidence.json`);
  state.note = "Portable evidence verified and exported.";
  render();
}

async function exportLocalRecovery() {
  const [identityRecord, project, actions, inclusions, outbox] = await Promise.all([
    store.get("identity", "owner"),
    store.get("projects", "active"),
    store.values("actions"),
    store.values("inclusions"),
    store.values("outbox"),
  ]);
  const body = {
    protocol: "greenways-local-recovery/1",
    exportedAt: new Date().toISOString(),
    identity: identityRecord?.identity ?? null,
    personalChainMigrations: identityRecord?.personalChainMigrations ?? [],
    project: project ?? null,
    actions,
    inclusions,
    outbox,
  };
  downloadJson({ ...body, root: await sha256(canonical(body)) }, "greenways-local-recovery.json");
}

load().catch((error) => {
  app.innerHTML = `${header()}<main class="content"><section class="card"><h2>Greenways needs recovery</h2><p class="muted">${escapeHtml(error.message)}</p><p class="muted">Recovery mode will not reset or delete local records. Export a public-key evidence snapshot before repairing this profile.</p><button class="primary" type="button" data-export-recovery>Export recovery evidence</button><p class="muted" data-recovery-status></p></section></main>`;
  app.querySelector("[data-export-recovery]").addEventListener("click", async () => {
    const status = app.querySelector("[data-recovery-status]");
    try {
      await exportLocalRecovery();
      status.textContent = "Recovery evidence exported without the private key or Hestia token.";
    } catch (recoveryError) {
      status.textContent = recoveryError?.message || "Recovery evidence could not be exported.";
    }
  });
  console.error(error);
});
