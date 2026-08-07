import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TRIPO_MODEL_VERSION,
  MODEL_GENERATION_REQUEST_PROTOCOL,
  MODEL_GENERATION_TASK_PROTOCOL,
  createTripoTaskPayload,
  normalizeModelGenerationRequest,
  normalizeModelGenerationTask,
} from "../src/model-generation.js";

const base = {
  protocol: MODEL_GENERATION_REQUEST_PROTOCOL,
  id: "request/hestia-001",
  provider: "tripo",
  profileId: "tripo.personal.abc123",
};

const png = (name) => ({ url: `https://assets.greenways.ai/${name}.png` });

test("normalizes a bounded geometry-first H3 text request", () => {
  const request = normalizeModelGenerationRequest({
    ...base,
    operation: "text-to-model",
    prompt: "A shallow eight-point mosaic sigil",
    negativePrompt: "coin, plaque, text",
  });
  assert.equal(request.modelVersion, DEFAULT_TRIPO_MODEL_VERSION);
  assert.deepEqual(request.options, {
    modelSeed: null,
    texture: false,
    pbr: false,
    geometryQuality: "standard",
    faceLimit: 250_000,
    enableImageAutofix: false,
    exportUv: false,
  });
  assert.deepEqual(createTripoTaskPayload(request), {
    type: "text_to_model",
    model_version: DEFAULT_TRIPO_MODEL_VERSION,
    texture: false,
    pbr: false,
    geometry_quality: "standard",
    face_limit: 250_000,
    export_uv: false,
    smart_low_poly: false,
    quad: false,
    generate_parts: false,
    auto_size: false,
    prompt: "A shallow eight-point mosaic sigil",
    negative_prompt: "coin, plaque, text",
  });
});

test("maps image and ordered multiview inputs to the closed Tripo payload", () => {
  const image = createTripoTaskPayload({
    ...base,
    operation: "image-to-model",
    image: png("hestia-front"),
    options: { modelSeed: 42, enableImageAutofix: true, faceLimit: 80_000 },
  });
  assert.equal(image.type, "image_to_model");
  assert.deepEqual(image.file, {
    type: "png",
    url: "https://assets.greenways.ai/hestia-front.png",
  });
  assert.equal(image.model_seed, 42);
  assert.equal(image.enable_image_autofix, true);
  assert.equal(image.face_limit, 80_000);

  const multiview = createTripoTaskPayload({
    ...base,
    id: "request/hestia-views-001",
    operation: "multiview-to-model",
    views: {
      front: png("hestia-front"),
      left: png("hestia-left"),
      back: null,
      right: png("hestia-right"),
    },
  });
  assert.equal(multiview.type, "multiview_to_model");
  assert.deepEqual(multiview.files, [
    { type: "png", url: "https://assets.greenways.ai/hestia-front.png" },
    { type: "png", url: "https://assets.greenways.ai/hestia-left.png" },
    {},
    { type: "png", url: "https://assets.greenways.ai/hestia-right.png" },
  ]);
});

test("rejects arbitrary provider payloads, secrets, unsafe URLs, and malformed views", () => {
  assert.throws(() => normalizeModelGenerationRequest({
    ...base,
    operation: "text-to-model",
    prompt: "sigil",
    providerPayload: { arbitrary: true },
  }), /unsupported field providerPayload/);
  assert.throws(() => normalizeModelGenerationRequest({
    ...base,
    operation: "text-to-model",
    prompt: "sigil",
    apiKey: "tsk_not-allowed-here",
  }), /credential material/);
  assert.throws(() => normalizeModelGenerationRequest({
    ...base,
    operation: "image-to-model",
    image: { url: "http://assets.greenways.ai/hestia.png" },
  }), /must use HTTPS/);
  assert.throws(() => normalizeModelGenerationRequest({
    ...base,
    operation: "multiview-to-model",
    views: { front: png("front") },
  }), /at least two images/);
  assert.throws(() => normalizeModelGenerationRequest({
    ...base,
    operation: "multiview-to-model",
    views: { left: png("left"), right: png("right") },
  }), /front view/);
});

test("projects Tripo task results without raw provider input or undocumented output", () => {
  const task = normalizeModelGenerationTask({
    task_id: "07764597-9c93-4eb9-92b6-4ea96a8c7d1a",
    type: "image_to_model",
    status: "success",
    input: { authorization: "must-not-project" },
    output: {
      model: "https://cdn.tripo3d.ai/models/model.glb?signature=short-lived",
      base_model: "https://cdn.tripo3d.ai/models/base.glb?signature=short-lived",
      rendered_image: "https://cdn.tripo3d.ai/renders/preview.png?signature=short-lived",
      undocumented: "https://example.com/ignore",
    },
    progress: 100,
    consumed_credit: 20,
    queuing_num: -1,
    running_left_time: -1,
    create_time: 1_786_080_000,
  }, {
    profileId: base.profileId,
    requestId: base.id,
    providerTaskId: "07764597-9c93-4eb9-92b6-4ea96a8c7d1a",
    operation: "image-to-model",
  });
  assert.equal(task.protocol, MODEL_GENERATION_TASK_PROTOCOL);
  assert.equal(task.terminal, true);
  assert.equal(task.output.modelUrl, "https://cdn.tripo3d.ai/models/model.glb?signature=short-lived");
  assert.equal(task.output.pbrModelUrl, null);
  assert.equal("input" in task, false);
  assert.equal("undocumented" in task.output, false);
  assert.doesNotMatch(JSON.stringify(task), /must-not-project/);
});
