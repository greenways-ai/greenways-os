const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const iconButton = (icon, label, action) => {
  const button = el("button", "hara-studio-icon", icon);
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.haraStudioAction = action;
  return button;
};

const detail = (label, key) => {
  const row = el("div", "hara-studio-health-row");
  const term = el("span", "hara-studio-health-label", label);
  const value = el("strong", "hara-studio-health-value", "—");
  value.dataset.haraStudio = key;
  row.append(term, value);
  return { row, value };
};

/**
 * Mount the host-independent Studio chrome. Runtime and persistence remain in
 * the host; actions are emitted as `hara:studio-action` events.
 */
export function createStudioShell(root) {
  if (!root) throw new Error("createStudioShell requires a root element");

  const shell = el("div", "hara-studio");
  shell.dataset.haraStudio = "shell";
  const bar = el("header", "hara-studio-project-bar");
  bar.dataset.haraStudio = "project-bar";
  const project = el("button", "hara-studio-project-button");
  project.type = "button";
  project.title = "Choose project";
  project.setAttribute("aria-label", "Choose project");
  project.dataset.haraStudioAction = "project/select";
  const projectTitle = el("span", "hara-studio-project-title", "Choose project");
  project.append(projectTitle, el("span", "hara-studio-project-chevron", "⌄"));

  const actions = el("div", "hara-studio-project-actions");
  const fileNew = iconButton("＋", "New Hara file", "file/new");
  const projectImport = iconButton("⇩", "Import project", "project/import");
  const consoleToggle = iconButton(">_", "Show console", "console/toggle");
  consoleToggle.setAttribute("aria-pressed", "false");
  const healthButton = iconButton("", "Runtime details", "runtime/details");
  healthButton.classList.add("hara-studio-health-button");
  healthButton.dataset.haraStudio = "runtime-status";
  healthButton.setAttribute("aria-expanded", "false");

  const popover = el("section", "hara-studio-health-popover");
  popover.dataset.haraStudio = "runtime-details";
  popover.hidden = true;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "Runtime details");
  const runtime = detail("Runtime", "runtime");
  const kernel = detail("Kernel", "kernel");
  const space = detail("Space", "space");
  const files = detail("Files", "file-count");
  const state = detail("State", "state");
  const kernelActions = el("div", "hara-studio-health-actions");
  const kernelNew = iconButton("＋", "Create kernel", "kernel/new");
  const kernelClose = iconButton("×", "Close kernel", "kernel/close");
  kernelActions.append(kernelNew, kernelClose);
  popover.append(runtime.row, kernel.row, space.row, files.row, state.row, kernelActions);
  actions.append(fileNew, projectImport, consoleToggle, healthButton, popover);
  bar.append(project, actions);

  const mobileTabs = el("nav", "hara-studio-mobile-tabs");
  mobileTabs.setAttribute("aria-label", "Workspace panels");
  const mobileExplorer = iconButton("▤", "Explorer", "view/explorer");
  const mobileSource = iconButton("⌘", "Source", "view/source");
  const mobileOutput = iconButton("◫", "Output", "view/output");
  const mobileConsole = iconButton(">_", "Console", "view/console");
  mobileSource.setAttribute("aria-pressed", "true");
  mobileTabs.append(mobileExplorer, mobileSource, mobileOutput, mobileConsole);
  const main = el("div", "hara-studio-main");
  main.classList.add("mobile-view-source");
  shell.append(bar, mobileTabs, main);
  root.appendChild(shell);

  const dispatch = (action, source) => shell.dispatchEvent(new CustomEvent("hara:studio-action", {
    bubbles: true,
    detail: { action, source }
  }));
  shell.addEventListener("click", (event) => {
    const button = event.target.closest("[data-hara-studio-action]");
    if (!button || !shell.contains(button)) return;
    const action = button.dataset.haraStudioAction;
    if (action === "runtime/details") {
      popover.hidden = !popover.hidden;
      healthButton.setAttribute("aria-expanded", String(!popover.hidden));
    }
    dispatch(action, button);
  });
  shell.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) {
      popover.hidden = true;
      healthButton.setAttribute("aria-expanded", "false");
      healthButton.focus();
    }
  });

  return {
    shell,
    main,
    projectButton: project,
    fileNewButton: fileNew,
    importButton: projectImport,
    consoleButton: consoleToggle,
    mobileOutputButton: mobileOutput,
    healthButton,
    statusPopover: popover,
    update({ project: projectName = "Choose project", runtime: runtimeValue = "Booting",
      kernel: kernelValue = "ROOT", space: spaceValue = "—", files: fileCount = 0,
      state: stateValue = "Busy", consoleOpen = false, outputAvailable = false,
      mobileView = "source" } = {}) {
      projectTitle.textContent = projectName;
      runtime.value.textContent = runtimeValue;
      kernel.value.textContent = kernelValue;
      space.value.textContent = spaceValue;
      files.value.textContent = String(fileCount);
      state.value.textContent = stateValue;
      const health = String(stateValue).toLowerCase() === "error" ? "error"
        : String(stateValue).toLowerCase() === "busy" || String(runtimeValue).toLowerCase() === "booting" ? "busy" : "live";
      healthButton.dataset.state = health;
      healthButton.title = health === "live" ? "Runtime ready" : health === "busy" ? "Runtime busy" : "Runtime error";
      consoleToggle.setAttribute("aria-pressed", String(consoleOpen));
      consoleToggle.title = consoleOpen ? "Hide console" : "Show console";
      mobileOutput.disabled = !outputAvailable;
      for (const button of [mobileExplorer, mobileSource, mobileOutput, mobileConsole]) {
        button.setAttribute("aria-pressed", String(button.dataset.haraStudioAction === `view/${mobileView}`));
      }
    },
    closeStatus() {
      popover.hidden = true;
      healthButton.setAttribute("aria-expanded", "false");
    },
    setProject(name) { projectTitle.textContent = name || "Choose project"; },
    destroy() { shell.remove(); }
  };
}
