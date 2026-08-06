const APP_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const ACTION = /^[a-z][a-z0-9.-]*(?:\/[a-z][a-z0-9.-]*)+$/;
const FIELD_NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const INPUT_KINDS = new Set(["text", "email", "number", "checkbox"]);
const STATUS_TONES = new Set(["neutral", "success", "warning", "error"]);

export const HAL_VIEW_LIMITS = Object.freeze({
  depth: 12,
  nodes: 256,
  text: 4096,
  payloadBytes: 16 * 1024,
  options: 100,
});

const NODE_KEYS = Object.freeze({
  view: new Set(["type", "children"]),
  section: new Set(["type", "title", "children"]),
  heading: new Set(["type", "level", "text"]),
  text: new Set(["type", "text"]),
  list: new Set(["type", "ordered", "children"]),
  item: new Set(["type", "children"]),
  button: new Set(["type", "label", "action", "payload", "disabled"]),
  form: new Set(["type", "action", "submitLabel", "payload", "children"]),
  input: new Set(["type", "name", "label", "kind", "value", "required", "placeholder"]),
  select: new Set(["type", "name", "label", "value", "required", "options"]),
  status: new Set(["type", "tone", "text"]),
});

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function text(value, label, { optional = false, maximum = HAL_VIEW_LIMITS.text } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return value;
}

function boolean(value, label, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function action(value, label) {
  const output = text(value, label, { maximum: 128 });
  if (!ACTION.test(output)) throw new Error(`${label} must be a namespace-qualified action id`);
  return output;
}

function fieldName(value, label) {
  const output = text(value, label, { maximum: 64 });
  if (!FIELD_NAME.test(output)) throw new Error(`${label} is invalid`);
  return output;
}

function normalizePayload(value, label, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${label} must contain JSON data only`);
  if (seen.has(value)) throw new Error(`${label} cannot contain cyclic data`);
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    output = value.map((entry, index) => normalizePayload(entry, `${label}[${index}]`, seen));
  } else {
    plainObject(value, label);
    output = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error(`${label} contains a forbidden object key`);
      }
      output[key] = normalizePayload(entry, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
  if (new TextEncoder().encode(JSON.stringify(output)).byteLength > HAL_VIEW_LIMITS.payloadBytes) {
    throw new Error(`${label} exceeds ${HAL_VIEW_LIMITS.payloadBytes} bytes`);
  }
  return output;
}

function normalizeChildren(value, context, label, depth) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return Object.freeze(value.map((entry, index) => normalizeNode(entry, context, `${label}[${index}]`, depth)));
}

function normalizeOptions(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > HAL_VIEW_LIMITS.options) throw new Error(`${label} cannot exceed ${HAL_VIEW_LIMITS.options} entries`);
  return Object.freeze(value.map((entry, index) => {
    const input = plainObject(entry, `${label}[${index}]`);
    exactKeys(input, new Set(["label", "value"]), `${label}[${index}]`);
    return Object.freeze({
      label: text(input.label, `${label}[${index}].label`, { maximum: 240 }),
      value: text(input.value, `${label}[${index}].value`, { maximum: 240 }),
    });
  }));
}

function normalizeNode(value, context, label, depth = 0) {
  if (depth > HAL_VIEW_LIMITS.depth) throw new Error(`HAL view exceeds depth ${HAL_VIEW_LIMITS.depth}`);
  context.nodes += 1;
  if (context.nodes > HAL_VIEW_LIMITS.nodes) throw new Error(`HAL view exceeds ${HAL_VIEW_LIMITS.nodes} nodes`);
  const input = plainObject(value, label);
  const type = text(input.type, `${label}.type`, { maximum: 32 });
  const allowed = NODE_KEYS[type];
  if (!allowed) throw new Error(`${label}.type is not in the HAL surface vocabulary`);
  exactKeys(input, allowed, label);
  const childDepth = depth + 1;

  if (type === "view") {
    return Object.freeze({ type, children: normalizeChildren(input.children, context, `${label}.children`, childDepth) });
  }
  if (type === "section") {
    return Object.freeze({
      type,
      title: text(input.title, `${label}.title`, { optional: true, maximum: 240 }),
      children: normalizeChildren(input.children, context, `${label}.children`, childDepth),
    });
  }
  if (type === "heading") {
    if (!Number.isInteger(input.level) || input.level < 1 || input.level > 4) {
      throw new Error(`${label}.level must be an integer from 1 to 4`);
    }
    return Object.freeze({ type, level: input.level, text: text(input.text, `${label}.text`) });
  }
  if (type === "text") return Object.freeze({ type, text: text(input.text, `${label}.text`) });
  if (type === "list") {
    return Object.freeze({
      type,
      ordered: boolean(input.ordered, `${label}.ordered`),
      children: normalizeChildren(input.children, context, `${label}.children`, childDepth),
    });
  }
  if (type === "item") {
    return Object.freeze({ type, children: normalizeChildren(input.children, context, `${label}.children`, childDepth) });
  }
  if (type === "button") {
    return Object.freeze({
      type,
      label: text(input.label, `${label}.label`, { maximum: 240 }),
      action: action(input.action, `${label}.action`),
      payload: normalizePayload(input.payload, `${label}.payload`),
      disabled: boolean(input.disabled, `${label}.disabled`),
    });
  }
  if (type === "form") {
    return Object.freeze({
      type,
      action: action(input.action, `${label}.action`),
      submitLabel: text(input.submitLabel ?? "Submit", `${label}.submitLabel`, { maximum: 240 }),
      payload: normalizePayload(input.payload, `${label}.payload`),
      children: normalizeChildren(input.children, context, `${label}.children`, childDepth),
    });
  }
  if (type === "input") {
    const kind = text(input.kind ?? "text", `${label}.kind`, { maximum: 20 });
    if (!INPUT_KINDS.has(kind)) throw new Error(`${label}.kind is not supported`);
    const rawValue = input.value ?? (kind === "checkbox" ? false : "");
    if (kind === "checkbox" && typeof rawValue !== "boolean") throw new TypeError(`${label}.value must be boolean`);
    if (kind !== "checkbox" && typeof rawValue !== "string" && typeof rawValue !== "number") {
      throw new TypeError(`${label}.value must be text or number`);
    }
    return Object.freeze({
      type,
      name: fieldName(input.name, `${label}.name`),
      label: text(input.label, `${label}.label`, { maximum: 240 }),
      kind,
      value: rawValue,
      required: boolean(input.required, `${label}.required`),
      placeholder: text(input.placeholder, `${label}.placeholder`, { optional: true, maximum: 240 }),
    });
  }
  if (type === "select") {
    return Object.freeze({
      type,
      name: fieldName(input.name, `${label}.name`),
      label: text(input.label, `${label}.label`, { maximum: 240 }),
      value: text(input.value ?? "", `${label}.value`, { maximum: 240 }),
      required: boolean(input.required, `${label}.required`),
      options: normalizeOptions(input.options, `${label}.options`),
    });
  }
  const tone = text(input.tone ?? "neutral", `${label}.tone`, { maximum: 20 });
  if (!STATUS_TONES.has(tone)) throw new Error(`${label}.tone is not supported`);
  return Object.freeze({ type, tone, text: text(input.text, `${label}.text`) });
}

export function validateHalViewTree(value) {
  const context = { nodes: 0 };
  const output = normalizeNode(value, context, "HAL view", 0);
  if (output.type !== "view") throw new Error("HAL view root must have type view");
  return output;
}

function appendText(document, parent, tag, value, className) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function renderNode(document, node, dispatch) {
  if (node.type === "view") {
    const element = document.createElement("div");
    element.className = "gw-hal-view";
    for (const child of node.children) element.append(renderNode(document, child, dispatch));
    return element;
  }
  if (node.type === "section") {
    const element = document.createElement("section");
    element.className = "gw-hal-section";
    if (node.title !== undefined) appendText(document, element, "h2", node.title, "gw-hal-section-title");
    for (const child of node.children) element.append(renderNode(document, child, dispatch));
    return element;
  }
  if (node.type === "heading") {
    const element = document.createElement(`h${node.level}`);
    element.className = "gw-hal-heading";
    element.textContent = node.text;
    return element;
  }
  if (node.type === "text") {
    const element = document.createElement("p");
    element.className = "gw-hal-text";
    element.textContent = node.text;
    return element;
  }
  if (node.type === "list") {
    const element = document.createElement(node.ordered ? "ol" : "ul");
    element.className = "gw-hal-list";
    for (const child of node.children) element.append(renderNode(document, child, dispatch));
    return element;
  }
  if (node.type === "item") {
    const element = document.createElement("li");
    element.className = "gw-hal-item";
    for (const child of node.children) element.append(renderNode(document, child, dispatch));
    return element;
  }
  if (node.type === "button") {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "gw-hal-button";
    element.textContent = node.label;
    element.disabled = node.disabled;
    element.addEventListener("click", () => dispatch(node.action, node.payload, null));
    return element;
  }
  if (node.type === "form") {
    const element = document.createElement("form");
    element.className = "gw-hal-form";
    for (const child of node.children) element.append(renderNode(document, child, dispatch));
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "gw-hal-submit";
    submit.textContent = node.submitLabel;
    element.append(submit);
    element.addEventListener("submit", (event) => {
      event.preventDefault();
      const fields = {};
      for (const control of element.elements) {
        if (!control.name) continue;
        fields[control.name] = control.type === "checkbox" ? Boolean(control.checked) : control.value;
      }
      dispatch(node.action, node.payload, fields);
    });
    return element;
  }
  if (node.type === "input") {
    const wrapper = document.createElement("label");
    wrapper.className = "gw-hal-field";
    appendText(document, wrapper, "span", node.label, "gw-hal-field-label");
    const control = document.createElement("input");
    control.name = node.name;
    control.type = node.kind;
    control.required = node.required;
    if (node.placeholder !== undefined) control.placeholder = node.placeholder;
    if (node.kind === "checkbox") control.checked = node.value;
    else control.value = String(node.value);
    wrapper.append(control);
    return wrapper;
  }
  if (node.type === "select") {
    const wrapper = document.createElement("label");
    wrapper.className = "gw-hal-field";
    appendText(document, wrapper, "span", node.label, "gw-hal-field-label");
    const control = document.createElement("select");
    control.name = node.name;
    control.required = node.required;
    for (const option of node.options) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      element.selected = option.value === node.value;
      control.append(element);
    }
    wrapper.append(control);
    return wrapper;
  }
  const element = document.createElement("div");
  element.className = `gw-hal-status gw-hal-status-${node.tone}`;
  element.setAttribute("role", node.tone === "error" ? "alert" : "status");
  element.textContent = node.text;
  return element;
}

export function renderHalViewTree(value, {
  document = globalThis.document,
  onAction = () => {},
} = {}) {
  if (!document?.createElement) throw new Error("HAL surface requires a DOM document");
  if (typeof onAction !== "function") throw new TypeError("HAL surface onAction must be a function");
  const tree = validateHalViewTree(value);
  return renderNode(document, tree, onAction);
}

export class HalSurfaceHost {
  constructor({ document = globalThis.document, onAction } = {}) {
    if (!document?.createElement) throw new Error("HAL surface host requires a DOM document");
    if (typeof onAction !== "function") throw new TypeError("HAL surface host requires onAction");
    this.document = document;
    this.onAction = onAction;
    this.mounts = new Map();
  }

  register(appId, mount) {
    if (typeof appId !== "string" || !APP_ID.test(appId)) throw new Error("HAL surface app id is invalid");
    if (!mount?.replaceChildren) throw new TypeError("HAL surface mount must be a DOM element");
    if (this.mounts.has(appId)) throw new Error(`HAL surface is already registered: ${appId}`);
    this.mounts.set(appId, mount);
    return () => this.unregister(appId);
  }

  unregister(appId) {
    const mount = this.mounts.get(appId);
    if (!mount) return false;
    mount.replaceChildren();
    this.mounts.delete(appId);
    return true;
  }

  render(appId, tree) {
    const mount = this.mounts.get(appId);
    if (!mount) throw new Error(`HAL surface is not registered: ${appId}`);
    const node = renderHalViewTree(tree, {
      document: this.document,
      onAction: (actionId, payload, fields) => this.onAction({
        appId,
        action: actionId,
        payload,
        fields,
      }),
    });
    mount.replaceChildren(node);
    return node;
  }
}
