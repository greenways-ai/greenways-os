import {
  SITE_DRIVER_CONTENT_MESSAGE_TYPE,
  SITE_DRIVER_REQUEST_PROTOCOL,
  TRIPO_STUDIO_DRIVER_ID,
  TRIPO_STUDIO_ORIGIN,
  createSiteDriverResult,
  normalizeSiteDriverContentCommand,
  normalizeSiteDriverPrompt,
  siteDriverPromptRoot,
} from "../site-driver-protocol.js";

const INSTALLATION_KEY = "__GREENWAYS_TRIPO_STUDIO_DRIVER_V1__";
const GENERATE_ROUTE = "/workspace/generate";
const SUBMIT_LABEL = "Generate Model";
const MAX_TEXT_SCAN = 60000;

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function lowerText(value) {
  return normalizedText(value).toLowerCase();
}

function elementText(element) {
  return normalizedText(element?.innerText || element?.textContent || element?.value || "");
}

function all(documentValue, selector) {
  try {
    return [...(documentValue?.querySelectorAll?.(selector) ?? [])];
  } catch {
    return [];
  }
}

function computedStyle(element, windowValue) {
  try {
    return windowValue?.getComputedStyle?.(element) ?? null;
  } catch {
    return null;
  }
}

export function isVisibleElement(element, windowValue = globalThis.window) {
  if (!element || element.hidden || element.disabled) return false;
  if (element.getAttribute?.("aria-hidden") === "true") return false;
  const style = computedStyle(element, windowValue);
  if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) return false;
  if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
  return true;
}

function buttonCandidates(documentValue, windowValue) {
  return all(documentValue, "button,[role='button']")
    .filter((element) => isVisibleElement(element, windowValue));
}

export function findVisibleButton(documentValue, label, windowValue = globalThis.window) {
  const expected = lowerText(label);
  const buttons = buttonCandidates(documentValue, windowValue);
  return buttons.find((button) => lowerText(elementText(button)) === expected)
    ?? buttons.find((button) => lowerText(elementText(button)).includes(expected))
    ?? null;
}

function promptCandidateScore(element) {
  const type = lowerText(element?.getAttribute?.("type") || element?.type || "");
  if (["file", "password", "email", "number", "checkbox", "radio", "submit", "button", "search"].includes(type)) {
    return -100;
  }
  const tag = lowerText(element?.tagName);
  const role = lowerText(element?.getAttribute?.("role"));
  const attributes = lowerText([
    element?.getAttribute?.("placeholder"),
    element?.getAttribute?.("aria-label"),
    element?.getAttribute?.("name"),
    element?.getAttribute?.("data-placeholder"),
  ].join(" "));
  let score = 0;
  if (tag === "textarea") score += 8;
  if (role === "textbox") score += 4;
  if (element?.isContentEditable || element?.getAttribute?.("contenteditable") === "true") score += 4;
  if (/prompt|describe|description|text to 3d|what.*create|model/.test(attributes)) score += 12;
  if (/search|invite|code/.test(attributes)) score -= 12;
  return score;
}

export function findPromptInput(documentValue, windowValue = globalThis.window) {
  const candidates = all(
    documentValue,
    "textarea,input[type='text'],input:not([type]),[contenteditable='true'],[role='textbox']",
  ).filter((element) => isVisibleElement(element, windowValue));
  return candidates
    .map((element, index) => ({ element, index, score: promptCandidateScore(element) }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.element ?? null;
}

function pageText(documentValue) {
  return normalizedText(documentValue?.body?.innerText || documentValue?.body?.textContent || "")
    .slice(0, MAX_TEXT_SCAN);
}

function routeCompatible(locationValue) {
  return locationValue?.origin === TRIPO_STUDIO_ORIGIN
    && (locationValue?.pathname === GENERATE_ROUTE || locationValue?.pathname?.startsWith(`${GENERATE_ROUTE}/`));
}

function eventConstructor(documentValue, name) {
  return documentValue?.defaultView?.[name] ?? globalThis[name] ?? null;
}

function dispatchInputEvents(element, value, documentValue) {
  const InputEventConstructor = eventConstructor(documentValue, "InputEvent");
  const EventConstructor = eventConstructor(documentValue, "Event");
  if (InputEventConstructor) {
    element.dispatchEvent?.(new InputEventConstructor("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: value,
    }));
  } else if (EventConstructor) {
    element.dispatchEvent?.(new EventConstructor("input", { bubbles: true, composed: true }));
  }
  if (EventConstructor) {
    element.dispatchEvent?.(new EventConstructor("change", { bubbles: true, composed: true }));
  }
}

function propertySetter(element, name) {
  let prototype = element;
  while (prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.set === "function") return descriptor.set;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
}

export function writePromptInput(element, prompt, documentValue = globalThis.document) {
  const value = normalizeSiteDriverPrompt(prompt);
  if (!element) throw new Error("Tripo Studio prompt field was not found");
  if (element.isContentEditable || element.getAttribute?.("contenteditable") === "true") {
    element.focus?.();
    element.textContent = value;
  } else {
    const setter = propertySetter(element, "value");
    element.focus?.();
    if (setter) setter.call(element, value);
    else element.value = value;
  }
  dispatchInputEvents(element, value, documentValue);
  return readPromptInput(element);
}

export function readPromptInput(element) {
  if (!element) return "";
  return String(
    element.isContentEditable || element.getAttribute?.("contenteditable") === "true"
      ? element.textContent
      : element.value,
  ).trim();
}

function explicitCreditLabel(value) {
  const text = normalizedText(value);
  const match = text.match(/\b(\d[\d,]*)\s*(credits?)\b/i);
  return match ? `${match[1]} ${match[2].toLowerCase()}` : null;
}

export function readVisibleCreditCost(button) {
  if (!button) return null;
  const direct = explicitCreditLabel([
    elementText(button),
    button.getAttribute?.("aria-label"),
    button.getAttribute?.("title"),
  ].join(" "));
  if (direct) return direct;
  let parent = button.parentElement;
  for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
    const label = explicitCreditLabel(elementText(parent));
    if (label) return label;
  }
  return null;
}

export function probeTripoStudio({
  document: documentValue = globalThis.document,
  location: locationValue = globalThis.location,
  window: windowValue = globalThis.window,
} = {}) {
  const origin = String(locationValue?.origin ?? "");
  const route = String(locationValue?.pathname ?? "");
  if (origin !== TRIPO_STUDIO_ORIGIN) {
    return createSiteDriverResult({
      driverId: TRIPO_STUDIO_DRIVER_ID,
      operation: "probe",
      state: "incompatible",
      message: "This tab is not Tripo Studio.",
      origin,
      route,
      anchors: Object.freeze({}),
      canStagePrompt: false,
      canSubmit: false,
    });
  }
  if (!routeCompatible(locationValue)) {
    return createSiteDriverResult({
      driverId: TRIPO_STUDIO_DRIVER_ID,
      operation: "probe",
      state: "wrong-route",
      message: "Open the Tripo Studio Generate Model workspace.",
      origin,
      route,
      anchors: Object.freeze({}),
      canStagePrompt: false,
      canSubmit: false,
    });
  }

  const text = pageText(documentValue);
  const prompt = findPromptInput(documentValue, windowValue);
  const submit = findVisibleButton(documentValue, SUBMIT_LABEL, windowValue);
  const login = findVisibleButton(documentValue, "Sign up/Log in", windowValue);
  const anchors = Object.freeze({
    generateModel: lowerText(text).includes("generate model"),
    generalSettings: lowerText(text).includes("general settings"),
    geometryTexture: lowerText(text).includes("geometry & texture")
      || lowerText(text).includes("geometry and texture"),
  });
  const complete = Object.values(anchors).every(Boolean) && Boolean(prompt) && Boolean(submit);
  const loggedOut = Boolean(login) && !prompt;
  return createSiteDriverResult({
    driverId: TRIPO_STUDIO_DRIVER_ID,
    operation: "probe",
    state: loggedOut ? "logged-out" : complete ? "compatible" : "degraded",
    message: loggedOut
      ? "Sign in to Tripo Studio before staging a model."
      : complete
        ? "Tripo Studio is ready for a foreground Greenways operation."
        : "Tripo Studio is open, but the expected generation controls are incomplete.",
    origin,
    route,
    anchors,
    canStagePrompt: Boolean(prompt),
    canSubmit: Boolean(submit && !submit.disabled),
  });
}

function progressValue(documentValue) {
  const element = all(documentValue, "[role='progressbar'][aria-valuenow]")
    .find((candidate) => isVisibleElement(candidate));
  const value = Number(element?.getAttribute?.("aria-valuenow"));
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function completionButton(documentValue, windowValue) {
  for (const label of ["Download", "Export", "Edit Model", "Open Model"]) {
    const button = findVisibleButton(documentValue, label, windowValue);
    if (button) return button;
  }
  return null;
}

export function createTripoStudioDriverEnvironment({
  document: documentValue = globalThis.document,
  location: locationValue = globalThis.location,
  window: windowValue = globalThis.window,
} = {}) {
  let staged = null;
  const submitted = new Set();

  async function stage(command) {
    const probe = probeTripoStudio({ document: documentValue, location: locationValue, window: windowValue });
    if (!probe.canStagePrompt) throw new Error(probe.message || "Tripo Studio prompt field is unavailable");
    const input = findPromptInput(documentValue, windowValue);
    const actual = writePromptInput(input, command.args.prompt, documentValue);
    const promptRoot = await siteDriverPromptRoot({
      driverId: command.driverId,
      requestId: command.requestId,
      prompt: actual,
    });
    if (promptRoot !== command.args.promptRoot) {
      throw new Error("Tripo Studio changed the prompt while it was being staged");
    }
    staged = { requestId: command.requestId, promptRoot };
    return createSiteDriverResult({
      driverId: command.driverId,
      operation: "stage-prompt",
      requestId: command.requestId,
      state: "staged",
      message: "Prompt staged in Tripo Studio.",
      promptRoot,
      promptLength: actual.length,
    });
  }

  async function review(command) {
    if (!staged || staged.requestId !== command.requestId) {
      throw new Error("This Tripo page has not staged the requested Greenways prompt");
    }
    const input = findPromptInput(documentValue, windowValue);
    const prompt = readPromptInput(input);
    const promptRoot = await siteDriverPromptRoot({
      driverId: command.driverId,
      requestId: command.requestId,
      prompt,
    });
    const submit = findVisibleButton(documentValue, SUBMIT_LABEL, windowValue);
    const canSubmit = promptRoot === staged.promptRoot && Boolean(submit && !submit.disabled);
    return createSiteDriverResult({
      driverId: command.driverId,
      operation: "review",
      requestId: command.requestId,
      state: canSubmit ? "ready" : "blocked",
      message: canSubmit
        ? "The staged prompt matches and Tripo Studio is ready to generate."
        : "The prompt changed or Tripo Studio is not ready to generate.",
      promptRoot,
      canSubmit,
      submitLabel: elementText(submit) || SUBMIT_LABEL,
      visibleCreditCost: readVisibleCreditCost(submit),
    });
  }

  async function submit(command) {
    if (submitted.has(command.requestId)) {
      throw new Error("This Greenways request was already submitted from this Tripo page");
    }
    const reviewed = await review({ ...command, operation: "review", args: {} });
    if (!reviewed.canSubmit || reviewed.promptRoot !== command.args.promptRoot) {
      throw new Error(reviewed.message || "Tripo Studio is not ready to submit this request");
    }
    const button = findVisibleButton(documentValue, SUBMIT_LABEL, windowValue);
    if (!button || button.disabled) throw new Error("Tripo Studio Generate Model is unavailable");
    submitted.add(command.requestId);
    button.click?.();
    return createSiteDriverResult({
      driverId: command.driverId,
      operation: "submit",
      requestId: command.requestId,
      state: "submitted",
      message: "Generate Model was activated once in Tripo Studio.",
      promptRoot: command.args.promptRoot,
    });
  }

  function observe(command) {
    const text = lowerText(pageText(documentValue));
    const progress = progressValue(documentValue);
    let state = "ready";
    let message = "Tripo Studio is ready.";
    if (/generation failed|failed to generate|could not generate|generation error/.test(text)) {
      state = "failed";
      message = "Tripo Studio reports that generation failed.";
    } else if (command.args.submitted
        && (completionButton(documentValue, windowValue)
          || (/model info/.test(text) && !/generating|processing|creating model/.test(text)))) {
      state = "completed";
      message = "A generated model is available in Tripo Studio.";
    } else if (command.args.submitted
        && (progress !== null || /generating|generation in progress|creating model|processing model|queued/.test(text))) {
      state = "running";
      message = progress === null
        ? "Tripo Studio is generating the model."
        : `Tripo Studio generation is ${Math.round(progress)}% complete.`;
    } else if (command.args.submitted || (command.requestId && submitted.has(command.requestId))) {
      state = "submitted";
      message = "The generation was submitted; Tripo Studio has not exposed progress yet.";
    }
    return createSiteDriverResult({
      driverId: command.driverId,
      operation: "observe",
      requestId: command.requestId,
      state,
      message,
      progress,
    });
  }

  return Object.freeze({
    async handle(value) {
      const command = normalizeSiteDriverContentCommand(value);
      if (command.driverId !== TRIPO_STUDIO_DRIVER_ID) throw new Error("This content driver only supports Tripo Studio");
      if (command.operation === "probe") {
        return probeTripoStudio({ document: documentValue, location: locationValue, window: windowValue });
      }
      if (command.operation === "stage-prompt") return stage(command);
      if (command.operation === "review") return review(command);
      if (command.operation === "submit") return submit(command);
      if (command.operation === "observe") return observe(command);
      if (command.operation === "detach") {
        staged = null;
        submitted.clear();
        return createSiteDriverResult({
          driverId: command.driverId,
          operation: "detach",
          state: "detached",
          message: "Tripo Studio content driver detached.",
        });
      }
      throw new Error(`Unsupported Tripo Studio operation: ${command.operation}`);
    },
  });
}

export function installTripoStudioContentDriver({
  chrome: chromeValue = globalThis.chrome,
  document: documentValue = globalThis.document,
  location: locationValue = globalThis.location,
  window: windowValue = globalThis.window,
  global: globalValue = globalThis,
} = {}) {
  if (!chromeValue?.runtime?.onMessage?.addListener) {
    throw new Error("Chrome content-script messaging is unavailable");
  }
  if (globalValue[INSTALLATION_KEY]) return globalValue[INSTALLATION_KEY];
  const environment = createTripoStudioDriverEnvironment({
    document: documentValue,
    location: locationValue,
    window: windowValue,
  });
  let active = true;
  const listener = (message, _sender, sendResponse) => {
    if (!active || message?.type !== SITE_DRIVER_CONTENT_MESSAGE_TYPE) return false;
    Promise.resolve()
      .then(() => environment.handle(message.command))
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }))
      .finally(() => {
        if (message?.command?.operation === "detach") api.destroy();
      });
    return true;
  };
  const api = Object.freeze({
    environment,
    destroy() {
      if (!active) return;
      active = false;
      chromeValue.runtime.onMessage.removeListener?.(listener);
      delete globalValue[INSTALLATION_KEY];
    },
  });
  globalValue[INSTALLATION_KEY] = api;
  chromeValue.runtime.onMessage.addListener(listener);
  return api;
}
