import assert from "node:assert/strict";
import test from "node:test";
import {
  createTripoStudioDriverEnvironment,
  findPromptInput,
  probeTripoStudio,
  readVisibleCreditCost,
} from "../src/site-drivers/tripo-studio-driver.js";
import {
  SITE_DRIVER_REQUEST_PROTOCOL,
  TRIPO_STUDIO_DRIVER_ID,
  siteDriverPromptRoot,
} from "../src/site-driver-protocol.js";

const requestId = "site-request/abcdefgh12345678";

class FakeEvent {
  constructor(type) { this.type = type; }
}

class FakeElement {
  constructor({ tagName = "DIV", text = "", value = "", attributes = {}, disabled = false } = {}) {
    this.tagName = tagName;
    this.textContent = text;
    this.innerText = text;
    this.value = value;
    this.attributes = { ...attributes };
    this.disabled = disabled;
    this.hidden = false;
    this.parentElement = null;
    this.clicked = 0;
    this.events = [];
    this.isContentEditable = attributes.contenteditable === "true";
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getClientRects() { return [{}]; }
  dispatchEvent(event) { this.events.push(event.type); return true; }
  focus() {}
  click() { this.clicked += 1; }
}

class FakeDocument {
  constructor({ bodyText, buttons = [], inputs = [], progress = [] }) {
    this.body = { innerText: bodyText, textContent: bodyText };
    this.buttons = buttons;
    this.inputs = inputs;
    this.progress = progress;
    this.defaultView = { Event: FakeEvent, InputEvent: FakeEvent };
  }
  querySelectorAll(selector) {
    if (selector === "button,[role='button']") return this.buttons;
    if (selector.includes("textarea,input")) return this.inputs;
    if (selector === "[role='progressbar'][aria-valuenow]") return this.progress;
    return [];
  }
}

function command(operation, { prompt, promptRoot } = {}) {
  const args = operation === "stage-prompt"
    ? { prompt, promptRoot }
    : operation === "submit"
      ? { promptRoot }
      : operation === "observe"
        ? { submitted: true }
        : {};
  return {
    protocol: SITE_DRIVER_REQUEST_PROTOCOL,
    driverId: TRIPO_STUDIO_DRIVER_ID,
    operation,
    requestId: ["stage-prompt", "review", "submit", "observe"].includes(operation) ? requestId : null,
    args,
  };
}

test("probes the semantic Tripo Generate Model anchors", () => {
  const prompt = new FakeElement({
    tagName: "TEXTAREA",
    attributes: { placeholder: "Describe the model you want to create" },
  });
  const generate = new FakeElement({ tagName: "BUTTON", text: "Generate Model" });
  const document = new FakeDocument({
    bodyText: "Generate Model General Settings Geometry & Texture Privacy AI Model",
    buttons: [generate],
    inputs: [prompt],
  });
  const result = probeTripoStudio({
    document,
    location: { origin: "https://studio.tripo3d.ai", pathname: "/workspace/generate" },
    window: {},
  });
  assert.equal(result.state, "compatible");
  assert.equal(result.canStagePrompt, true);
  assert.equal(findPromptInput(document, {}), prompt);
});

test("stages, reviews, and submits the exact prompt only once", async () => {
  const prompt = new FakeElement({
    tagName: "TEXTAREA",
    attributes: { placeholder: "Prompt" },
  });
  const container = new FakeElement({ text: "Generate Model 55 credits" });
  const generate = new FakeElement({ tagName: "BUTTON", text: "Generate Model" });
  generate.parentElement = container;
  const document = new FakeDocument({
    bodyText: "Generate Model General Settings Geometry & Texture",
    buttons: [generate],
    inputs: [prompt],
  });
  const environment = createTripoStudioDriverEnvironment({
    document,
    location: { origin: "https://studio.tripo3d.ai", pathname: "/workspace/generate" },
    window: {},
  });
  const text = "A translucent glass mosaic sculpture";
  const root = await siteDriverPromptRoot({ driverId: TRIPO_STUDIO_DRIVER_ID, requestId, prompt: text });
  const staged = await environment.handle(command("stage-prompt", { prompt: text, promptRoot: root }));
  assert.equal(staged.promptRoot, root);
  assert.equal(prompt.value, text);
  assert.ok(prompt.events.includes("input"));

  const reviewed = await environment.handle(command("review"));
  assert.equal(reviewed.canSubmit, true);
  assert.equal(reviewed.visibleCreditCost, "55 credits");
  assert.equal(readVisibleCreditCost(generate), "55 credits");

  const submitted = await environment.handle(command("submit", { promptRoot: root }));
  assert.equal(submitted.state, "submitted");
  assert.equal(generate.clicked, 1);
  await assert.rejects(environment.handle(command("submit", { promptRoot: root })), /already submitted/);
  assert.equal(generate.clicked, 1);
});

test("observes bounded running and completed states without returning page text", async () => {
  const prompt = new FakeElement({ tagName: "TEXTAREA", attributes: { placeholder: "Prompt" } });
  const generate = new FakeElement({ tagName: "BUTTON", text: "Generate Model" });
  const progress = new FakeElement({ attributes: { role: "progressbar", "aria-valuenow": "42" } });
  const document = new FakeDocument({
    bodyText: "Generate Model General Settings Geometry & Texture Generating model",
    buttons: [generate],
    inputs: [prompt],
    progress: [progress],
  });
  const environment = createTripoStudioDriverEnvironment({
    document,
    location: { origin: "https://studio.tripo3d.ai", pathname: "/workspace/generate" },
    window: {},
  });
  const running = await environment.handle(command("observe"));
  assert.equal(running.state, "running");
  assert.equal(running.progress, 42);
  assert.equal("pageText" in running, false);

  document.body.innerText = "Model Info";
  document.body.textContent = "Model Info";
  document.progress = [];
  document.buttons.push(new FakeElement({ tagName: "BUTTON", text: "Download" }));
  const completed = await environment.handle(command("observe"));
  assert.equal(completed.state, "completed");
});
