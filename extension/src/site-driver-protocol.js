import { canonical, sha256 } from "./protocol.js";

export const SITE_DRIVER_PROTOCOL = "greenways-site-driver/1";
export const SITE_DRIVER_REQUEST_PROTOCOL = "greenways-site-driver-request/1";
export const SITE_DRIVER_RESULT_PROTOCOL = "greenways-site-driver-result/1";
export const SITE_DRIVER_CONTENT_MESSAGE_TYPE = "greenways/site-driver/content-command";

export const TRIPO_STUDIO_DRIVER_ID = "tripo-studio";
export const TRIPO_STUDIO_ORIGIN = "https://studio.tripo3d.ai";
export const TRIPO_STUDIO_ORIGIN_PATTERN = "https://studio.tripo3d.ai/*";
export const TRIPO_STUDIO_GENERATE_URL = "https://studio.tripo3d.ai/workspace/generate";

const DRIVER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REQUEST_ID = /^[a-z][a-z0-9-]*\/[A-Za-z0-9_-]{8,160}$/;
const CONFIRMATION_TOKEN = /^site-confirmation\/[A-Za-z0-9_-]{8,160}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const MAX_PROMPT_LENGTH = 4000;
const MAX_RESULT_MESSAGE = 320;

const OPERATION_SET = new Set([
  "attach",
  "status",
  "stage-prompt",
  "review",
  "submit",
  "observe",
  "detach",
]);

const CONTENT_OPERATION_SET = new Set([
  "probe",
  "stage-prompt",
  "review",
  "submit",
  "observe",
  "detach",
]);

export const SITE_DRIVER_OPERATIONS = Object.freeze([...OPERATION_SET]);

const descriptor = Object.freeze({
  protocol: SITE_DRIVER_PROTOCOL,
  id: TRIPO_STUDIO_DRIVER_ID,
  name: "Tripo Studio",
  origin: TRIPO_STUDIO_ORIGIN,
  originPattern: TRIPO_STUDIO_ORIGIN_PATTERN,
  routes: Object.freeze(["/workspace/generate"]),
  contentScript: "dist/tripo-studio-content.js",
  operations: Object.freeze([...CONTENT_OPERATION_SET]),
});

export const SITE_DRIVER_DESCRIPTORS = Object.freeze([descriptor]);
const DESCRIPTORS_BY_ID = new Map(SITE_DRIVER_DESCRIPTORS.map((entry) => [entry.id, entry]));

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

function closedKeys(value, allowed, label) {
  for (const key of Object.keys(plainObject(value, label))) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function requiredString(value, label, maximum = 240) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function matchingString(value, pattern, label, maximum = 240) {
  const output = requiredString(value, label, maximum);
  if (!pattern.test(output)) throw new Error(`${label} is invalid`);
  return output;
}

function optionalRequestId(value, label = "Site-driver request id") {
  return value === undefined || value === null
    ? null
    : matchingString(value, REQUEST_ID, label, 180);
}

function exactDriverId(value) {
  const id = matchingString(value, DRIVER_ID, "Site-driver id", 80);
  if (!DESCRIPTORS_BY_ID.has(id)) throw new Error(`Unknown site driver: ${id}`);
  return id;
}

function operationName(value, allowed = OPERATION_SET) {
  const operation = requiredString(value, "Site-driver operation", 40);
  if (!allowed.has(operation)) throw new Error(`Unsupported site-driver operation: ${operation}`);
  return operation;
}

function tabId(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error("Site-driver tab id is required");
    return null;
  }
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Site-driver tab id must be a positive integer");
  return value;
}

export function normalizeSiteDriverPrompt(value) {
  const prompt = requiredString(value, "Model prompt", MAX_PROMPT_LENGTH);
  if (/\u0000/.test(prompt)) throw new Error("Model prompt cannot contain null characters");
  return prompt;
}

function normalizeArgs(operation, value) {
  const args = value === undefined ? {} : plainObject(value, "Site-driver arguments");
  if (operation === "stage-prompt") {
    closedKeys(args, new Set(["prompt"]), "Site-driver arguments");
    return Object.freeze({ prompt: normalizeSiteDriverPrompt(args.prompt) });
  }
  if (operation === "submit") {
    closedKeys(args, new Set(["confirmationToken"]), "Site-driver arguments");
    return Object.freeze({
      confirmationToken: matchingString(
        args.confirmationToken,
        CONFIRMATION_TOKEN,
        "Site-driver confirmation token",
        190,
      ),
    });
  }
  closedKeys(args, new Set(), "Site-driver arguments");
  return Object.freeze({});
}

export function getSiteDriverDescriptor(id) {
  return DESCRIPTORS_BY_ID.get(String(id)) ?? null;
}

export function siteDriverSupportsUrl(descriptorValue, urlValue) {
  const candidate = descriptorValue ?? null;
  if (!candidate || !SITE_DRIVER_DESCRIPTORS.includes(candidate)) return false;
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    return false;
  }
  return url.origin === candidate.origin
    && candidate.routes.some((route) => url.pathname === route || url.pathname.startsWith(`${route}/`));
}

export function normalizeSiteDriverRequest(value) {
  const input = plainObject(value, "Site-driver request");
  closedKeys(
    input,
    new Set(["protocol", "driverId", "operation", "requestId", "tabId", "args"]),
    "Site-driver request",
  );
  if (input.protocol !== SITE_DRIVER_REQUEST_PROTOCOL) {
    throw new Error(`Site-driver request protocol must be ${SITE_DRIVER_REQUEST_PROTOCOL}`);
  }
  const operation = operationName(input.operation);
  const requestId = optionalRequestId(input.requestId);
  if (["stage-prompt", "review", "submit"].includes(operation) && !requestId) {
    throw new Error(`Site-driver operation ${operation} requires a request id`);
  }
  return Object.freeze({
    protocol: SITE_DRIVER_REQUEST_PROTOCOL,
    driverId: exactDriverId(input.driverId),
    operation,
    requestId,
    tabId: tabId(input.tabId, { required: operation === "attach" }),
    args: normalizeArgs(operation, input.args),
  });
}

export function normalizeSiteDriverContentCommand(value) {
  const input = plainObject(value, "Site-driver content command");
  closedKeys(
    input,
    new Set(["protocol", "driverId", "operation", "requestId", "args"]),
    "Site-driver content command",
  );
  if (input.protocol !== SITE_DRIVER_REQUEST_PROTOCOL) {
    throw new Error(`Site-driver content command protocol must be ${SITE_DRIVER_REQUEST_PROTOCOL}`);
  }
  const operation = operationName(input.operation, CONTENT_OPERATION_SET);
  const requestId = optionalRequestId(input.requestId, "Site-driver content request id");
  if (["stage-prompt", "review", "submit"].includes(operation) && !requestId) {
    throw new Error(`Site-driver content operation ${operation} requires a request id`);
  }
  const args = input.args === undefined ? {} : plainObject(input.args, "Site-driver content arguments");
  if (operation === "stage-prompt") {
    closedKeys(args, new Set(["prompt", "promptRoot"]), "Site-driver content arguments");
    return Object.freeze({
      protocol: SITE_DRIVER_REQUEST_PROTOCOL,
      driverId: exactDriverId(input.driverId),
      operation,
      requestId,
      args: Object.freeze({
        prompt: normalizeSiteDriverPrompt(args.prompt),
        promptRoot: matchingString(args.promptRoot, SHA256, "Staged prompt root", 80),
      }),
    });
  }
  if (operation === "submit") {
    closedKeys(args, new Set(["promptRoot"]), "Site-driver content arguments");
    return Object.freeze({
      protocol: SITE_DRIVER_REQUEST_PROTOCOL,
      driverId: exactDriverId(input.driverId),
      operation,
      requestId,
      args: Object.freeze({
        promptRoot: matchingString(args.promptRoot, SHA256, "Submitted prompt root", 80),
      }),
    });
  }
  if (operation === "observe") {
    closedKeys(args, new Set(["submitted"]), "Site-driver content arguments");
    if (args.submitted !== undefined && typeof args.submitted !== "boolean") {
      throw new TypeError("Site-driver observation submitted flag must be a boolean");
    }
    return Object.freeze({
      protocol: SITE_DRIVER_REQUEST_PROTOCOL,
      driverId: exactDriverId(input.driverId),
      operation,
      requestId,
      args: Object.freeze({ submitted: args.submitted === true }),
    });
  }
  closedKeys(args, new Set(), "Site-driver content arguments");
  return Object.freeze({
    protocol: SITE_DRIVER_REQUEST_PROTOCOL,
    driverId: exactDriverId(input.driverId),
    operation,
    requestId,
    args: Object.freeze({}),
  });
}

export async function siteDriverPromptRoot({ driverId, requestId, prompt }) {
  return sha256(canonical({
    protocol: "greenways-site-driver-staged-prompt/1",
    driverId: exactDriverId(driverId),
    requestId: matchingString(requestId, REQUEST_ID, "Staged prompt request id", 180),
    prompt: normalizeSiteDriverPrompt(prompt),
  }));
}

export function createSiteDriverResult({ driverId, operation, requestId = null, state, message = "", ...extra }) {
  const output = {
    protocol: SITE_DRIVER_RESULT_PROTOCOL,
    driverId: exactDriverId(driverId),
    operation: operationName(operation, new Set([...OPERATION_SET, ...CONTENT_OPERATION_SET])),
    requestId: optionalRequestId(requestId, "Site-driver result request id"),
    state: requiredString(state, "Site-driver result state", 40),
    message: message ? requiredString(message, "Site-driver result message", MAX_RESULT_MESSAGE) : "",
    ...extra,
  };
  return Object.freeze(output);
}
