export const MODEL_GENERATION_REQUEST_PROTOCOL = "greenways-model-generation-request/1";
export const MODEL_GENERATION_TASK_PROTOCOL = "greenways-model-generation-task/1";
export const MODEL_GENERATION_PROVIDER = "tripo";
export const DEFAULT_TRIPO_MODEL_VERSION = "v3.1-20260211";
export const TRIPO_MODEL_VERSIONS = Object.freeze([
  DEFAULT_TRIPO_MODEL_VERSION,
  "v3.0-20250812",
]);
export const MODEL_GENERATION_OPERATIONS = Object.freeze([
  "text-to-model",
  "image-to-model",
  "multiview-to-model",
]);
export const MODEL_GENERATION_TERMINAL_STATUSES = Object.freeze([
  "success",
  "failed",
  "banned",
  "expired",
  "cancelled",
  "unknown",
]);

const OPERATIONS = new Set(MODEL_GENERATION_OPERATIONS);
const MODEL_VERSIONS = new Set(TRIPO_MODEL_VERSIONS);
const TERMINAL_STATUSES = new Set(MODEL_GENERATION_TERMINAL_STATUSES);
const TASK_STATUSES = new Set(["queued", "running", ...MODEL_GENERATION_TERMINAL_STATUSES]);
const REQUEST_ID = /^[a-z0-9][a-z0-9._:/-]{7,127}$/i;
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const PROVIDER_TASK_ID = /^[a-z0-9][a-z0-9-]{7,127}$/i;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SECRET_FIELD = /(?:secret|password|token|api[-_]?key|authorization|bearer)/i;
const IMAGE_TYPES = new Set(["png", "jpg", "jpeg"]);
const VIEW_NAMES = Object.freeze(["front", "left", "back", "right"]);
const DEFAULT_FACE_LIMIT = 250_000;
const MAX_FACE_LIMIT = 250_000;

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
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`${label} contains a forbidden field`);
    if (SECRET_FIELD.test(key)) throw new Error(`${label} cannot contain credential material in ${key}`);
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function requiredString(value, label, maximum) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function optionalString(value, label, maximum) {
  return value === undefined || value === null || value === ""
    ? null
    : requiredString(value, label, maximum);
}

function matchingString(value, pattern, label, maximum) {
  const output = requiredString(value, label, maximum);
  if (!pattern.test(output)) throw new Error(`${label} is invalid`);
  return output;
}

function optionalBoolean(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

function optionalInteger(value, fallback, label, minimum, maximum) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function imageType(value, url, label) {
  if (value !== undefined && value !== null && value !== "") {
    const output = requiredString(value, `${label} type`, 8).toLowerCase();
    if (!IMAGE_TYPES.has(output)) throw new Error(`${label} type must be png, jpg, or jpeg`);
    return output === "jpeg" ? "jpg" : output;
  }
  const extension = url.pathname.split(".").pop()?.toLowerCase();
  if (!IMAGE_TYPES.has(extension)) {
    throw new Error(`${label} URL must end in .png, .jpg, or .jpeg when type is omitted`);
  }
  return extension === "jpeg" ? "jpg" : extension;
}

function directImageUrl(value, label) {
  const raw = requiredString(value, `${label} URL`, 2048);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} URL must use HTTPS`);
  if (url.username || url.password) throw new Error(`${label} URL cannot contain credentials`);
  if (url.hash) throw new Error(`${label} URL cannot contain a fragment`);
  return url;
}

function normalizeImage(value, label) {
  const input = plainObject(value, label);
  closedKeys(input, new Set(["url", "type"]), label);
  const url = directImageUrl(input.url, label);
  return Object.freeze({
    url: url.href,
    type: imageType(input.type, url, label),
  });
}

function normalizeViews(value) {
  const input = plainObject(value, "Model generation views");
  closedKeys(input, new Set(VIEW_NAMES), "Model generation views");
  const views = {};
  let count = 0;
  for (const name of VIEW_NAMES) {
    const candidate = input[name];
    views[name] = candidate === null || candidate === undefined
      ? null
      : normalizeImage(candidate, `${name} view`);
    if (views[name]) count += 1;
  }
  if (!views.front) throw new Error("Multiview generation requires a front view");
  if (count < 2) throw new Error("Multiview generation requires at least two images");
  return Object.freeze(views);
}

function normalizeOptions(value = {}, operation) {
  const input = plainObject(value, "Model generation options");
  closedKeys(
    input,
    new Set([
      "modelSeed",
      "texture",
      "pbr",
      "geometryQuality",
      "faceLimit",
      "enableImageAutofix",
      "exportUv",
    ]),
    "Model generation options",
  );
  const pbr = optionalBoolean(input.pbr, false, "Model generation pbr");
  const texture = pbr
    ? true
    : optionalBoolean(input.texture, false, "Model generation texture");
  const geometryQuality = input.geometryQuality === undefined
    ? "standard"
    : requiredString(input.geometryQuality, "Model generation geometry quality", 16);
  if (!["standard", "detailed"].includes(geometryQuality)) {
    throw new Error("Model generation geometry quality must be standard or detailed");
  }
  const enableImageAutofix = optionalBoolean(
    input.enableImageAutofix,
    false,
    "Model generation image autofix",
  );
  if (operation === "text-to-model" && enableImageAutofix) {
    throw new Error("Image autofix is not available for text-to-model requests");
  }
  return Object.freeze({
    modelSeed: optionalInteger(input.modelSeed, null, "Model generation seed", 0, 2_147_483_647),
    texture,
    pbr,
    geometryQuality,
    faceLimit: optionalInteger(
      input.faceLimit,
      DEFAULT_FACE_LIMIT,
      "Model generation face limit",
      1_000,
      MAX_FACE_LIMIT,
    ),
    enableImageAutofix,
    exportUv: optionalBoolean(input.exportUv, false, "Model generation UV export"),
  });
}

export function normalizeModelGenerationRequest(value) {
  const input = plainObject(value, "Model generation request");
  closedKeys(
    input,
    new Set([
      "protocol",
      "id",
      "provider",
      "profileId",
      "operation",
      "modelVersion",
      "prompt",
      "negativePrompt",
      "image",
      "views",
      "options",
    ]),
    "Model generation request",
  );
  if (input.protocol !== MODEL_GENERATION_REQUEST_PROTOCOL) {
    throw new Error(`Model generation request protocol must be ${MODEL_GENERATION_REQUEST_PROTOCOL}`);
  }
  if (input.provider !== MODEL_GENERATION_PROVIDER) {
    throw new Error(`Model generation provider must be ${MODEL_GENERATION_PROVIDER}`);
  }
  const operation = requiredString(input.operation, "Model generation operation", 40);
  if (!OPERATIONS.has(operation)) throw new Error(`Unsupported model generation operation: ${operation}`);
  const modelVersion = input.modelVersion === undefined
    ? DEFAULT_TRIPO_MODEL_VERSION
    : requiredString(input.modelVersion, "Model generation model version", 40);
  if (!MODEL_VERSIONS.has(modelVersion)) {
    throw new Error(`Unsupported Tripo model version: ${modelVersion}`);
  }

  const prompt = optionalString(input.prompt, "Model generation prompt", 1024);
  const negativePrompt = optionalString(input.negativePrompt, "Model generation negative prompt", 255);
  const image = input.image === undefined || input.image === null
    ? null
    : normalizeImage(input.image, "Model generation image");
  const views = input.views === undefined || input.views === null
    ? null
    : normalizeViews(input.views);

  if (operation === "text-to-model") {
    if (!prompt) throw new Error("Text-to-model generation requires a prompt");
    if (image || views) throw new Error("Text-to-model generation cannot include image inputs");
  } else if (operation === "image-to-model") {
    if (!image) throw new Error("Image-to-model generation requires one image");
    if (prompt || negativePrompt || views) {
      throw new Error("Image-to-model generation accepts only one image input");
    }
  } else if (operation === "multiview-to-model") {
    if (!views) throw new Error("Multiview generation requires ordered views");
    if (prompt || negativePrompt || image) {
      throw new Error("Multiview generation accepts only ordered view inputs");
    }
  }

  return Object.freeze({
    protocol: MODEL_GENERATION_REQUEST_PROTOCOL,
    id: matchingString(input.id, REQUEST_ID, "Model generation request id", 128),
    provider: MODEL_GENERATION_PROVIDER,
    profileId: matchingString(
      String(input.profileId ?? "").toLowerCase(),
      PROFILE_ID,
      "Model generation profile id",
      64,
    ),
    operation,
    modelVersion,
    prompt,
    negativePrompt,
    image,
    views,
    options: normalizeOptions(input.options ?? {}, operation),
  });
}

function tripoFile(image) {
  return { type: image.type, url: image.url };
}

export function createTripoTaskPayload(value) {
  const request = normalizeModelGenerationRequest(value);
  const payload = {
    type: request.operation.replaceAll("-", "_"),
    model_version: request.modelVersion,
    texture: request.options.texture,
    pbr: request.options.pbr,
    geometry_quality: request.options.geometryQuality,
    face_limit: request.options.faceLimit,
    export_uv: request.options.exportUv,
    smart_low_poly: false,
    quad: false,
    generate_parts: false,
    auto_size: false,
  };
  if (request.options.modelSeed !== null) payload.model_seed = request.options.modelSeed;
  if (request.operation === "text-to-model") {
    payload.prompt = request.prompt;
    if (request.negativePrompt) payload.negative_prompt = request.negativePrompt;
  } else if (request.operation === "image-to-model") {
    payload.file = tripoFile(request.image);
    payload.enable_image_autofix = request.options.enableImageAutofix;
  } else {
    payload.files = VIEW_NAMES.map((name) => request.views[name] ? tripoFile(request.views[name]) : {});
    payload.enable_image_autofix = request.options.enableImageAutofix;
  }
  return Object.freeze(payload);
}

function nullableInteger(value, label, minimum = -1, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizeOutputUrl(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const url = directImageUrl(value, label);
  return url.href;
}

function providerTime(value) {
  if (value === undefined || value === null || value === "") return null;
  let date;
  if (typeof value === "number" && Number.isFinite(value)) {
    date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  } else {
    date = new Date(value);
  }
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function normalizeTaskContext(value) {
  const input = plainObject(value, "Model generation task context");
  closedKeys(
    input,
    new Set(["profileId", "requestId", "providerTaskId", "operation"]),
    "Model generation task context",
  );
  const operation = requiredString(input.operation, "Model generation task operation", 40);
  if (!OPERATIONS.has(operation)) throw new Error(`Unsupported model generation operation: ${operation}`);
  return Object.freeze({
    profileId: matchingString(
      String(input.profileId ?? "").toLowerCase(),
      PROFILE_ID,
      "Model generation task profile id",
      64,
    ),
    requestId: matchingString(input.requestId, REQUEST_ID, "Model generation task request id", 128),
    providerTaskId: matchingString(
      input.providerTaskId,
      PROVIDER_TASK_ID,
      "Tripo task id",
      128,
    ),
    operation,
  });
}

export function createPendingModelGenerationTask(contextValue) {
  const context = normalizeTaskContext(contextValue);
  return Object.freeze({
    protocol: MODEL_GENERATION_TASK_PROTOCOL,
    provider: MODEL_GENERATION_PROVIDER,
    profileId: context.profileId,
    requestId: context.requestId,
    providerTaskId: context.providerTaskId,
    operation: context.operation,
    status: "queued",
    terminal: false,
    progress: 0,
    consumedCredits: null,
    queuePosition: null,
    secondsRemaining: null,
    createdAt: null,
    output: Object.freeze({
      modelUrl: null,
      baseModelUrl: null,
      pbrModelUrl: null,
      renderedImageUrl: null,
    }),
  });
}

export function normalizeModelGenerationTask(value, contextValue) {
  const input = plainObject(value, "Tripo task result");
  const context = normalizeTaskContext(contextValue);
  const providerTaskId = matchingString(input.task_id, PROVIDER_TASK_ID, "Tripo task id", 128);
  if (providerTaskId !== context.providerTaskId) throw new Error("Tripo task result does not match its request");
  const status = requiredString(input.status, "Tripo task status", 32);
  if (!TASK_STATUSES.has(status)) throw new Error(`Unsupported Tripo task status: ${status}`);
  const output = input.output === undefined || input.output === null
    ? {}
    : plainObject(input.output, "Tripo task output");
  return Object.freeze({
    protocol: MODEL_GENERATION_TASK_PROTOCOL,
    provider: MODEL_GENERATION_PROVIDER,
    profileId: context.profileId,
    requestId: context.requestId,
    providerTaskId,
    operation: context.operation,
    status,
    terminal: TERMINAL_STATUSES.has(status),
    progress: nullableInteger(input.progress, "Tripo task progress", 0, 100),
    consumedCredits: nullableInteger(input.consumed_credit, "Tripo consumed credits", 0),
    queuePosition: nullableInteger(input.queuing_num, "Tripo queue position"),
    secondsRemaining: nullableInteger(input.running_left_time, "Tripo running time"),
    createdAt: providerTime(input.create_time),
    output: Object.freeze({
      modelUrl: normalizeOutputUrl(output.model, "Tripo model output"),
      baseModelUrl: normalizeOutputUrl(output.base_model, "Tripo base model output"),
      pbrModelUrl: normalizeOutputUrl(output.pbr_model, "Tripo PBR model output"),
      renderedImageUrl: normalizeOutputUrl(output.rendered_image, "Tripo rendered image output"),
    }),
  });
}

export function modelGenerationTaskReference(taskValue) {
  const task = plainObject(taskValue, "Model generation task");
  return normalizeTaskContext({
    profileId: task.profileId,
    requestId: task.requestId,
    providerTaskId: task.providerTaskId,
    operation: task.operation,
  });
}
