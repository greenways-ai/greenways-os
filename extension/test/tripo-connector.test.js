import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_GENERATION_REQUEST_PROTOCOL,
} from "../src/model-generation.js";
import {
  TRIPO_API_ORIGIN,
  TripoConnector,
  TripoConnectorError,
  requestTripoAccess,
} from "../src/tripo-connector.js";

const request = {
  protocol: MODEL_GENERATION_REQUEST_PROTOCOL,
  id: "request/hestia-001",
  provider: "tripo",
  profileId: "tripo.personal.abc123",
  operation: "image-to-model",
  image: { url: "https://assets.greenways.ai/hestia-front.png" },
};

class FakeKeyring {
  constructor(secret = "tsk_testing-secret-value") {
    this.secret = secret;
    this.calls = [];
  }

  async withProviderCredential(profileId, provider, operation) {
    this.calls.push({ profileId, provider });
    return operation(this.secret, { id: profileId, provider });
  }
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

test("creates a Tripo task through the exact OpenAPI boundary", async () => {
  const keyring = new FakeKeyring();
  const calls = [];
  const connector = new TripoConnector({
    keyring,
    request: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ code: 0, data: { task_id: "07764597-9c93-4eb9-92b6-4ea96a8c7d1a" } });
    },
  });
  const task = await connector.createTask(request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${TRIPO_API_ORIGIN}/v2/openapi/task`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, "Bearer tsk_testing-secret-value");
  assert.deepEqual(JSON.parse(calls[0].options.body).file, {
    type: "png",
    url: "https://assets.greenways.ai/hestia-front.png",
  });
  assert.deepEqual(keyring.calls, [{ profileId: request.profileId, provider: "tripo" }]);
  assert.equal(task.status, "queued");
  assert.doesNotMatch(JSON.stringify(task), /tsk_testing-secret-value/);
});

test("polls with the same credential profile and sanitizes task output", async () => {
  const keyring = new FakeKeyring();
  const calls = [];
  const connector = new TripoConnector({
    keyring,
    request: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({
        code: 0,
        data: {
          task_id: "07764597-9c93-4eb9-92b6-4ea96a8c7d1a",
          status: "running",
          output: { undocumented: "not projected" },
          progress: 63,
          consumed_credit: 0,
          queuing_num: -1,
          running_left_time: 9,
          create_time: "2026-08-07T01:00:00.000Z",
        },
      });
    },
  });
  const task = await connector.getTask({
    profileId: request.profileId,
    requestId: request.id,
    providerTaskId: "07764597-9c93-4eb9-92b6-4ea96a8c7d1a",
    operation: request.operation,
  });
  assert.equal(calls[0].url, `${TRIPO_API_ORIGIN}/v2/openapi/task/07764597-9c93-4eb9-92b6-4ea96a8c7d1a`);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(task.progress, 63);
  assert.equal(task.output.modelUrl, null);
  assert.deepEqual(keyring.calls, [{ profileId: request.profileId, provider: "tripo" }]);
});

test("returns bounded Tripo errors instead of raw provider envelopes", async () => {
  const connector = new TripoConnector({
    keyring: new FakeKeyring(),
    request: async () => jsonResponse({
      code: 2010,
      message: "Credits exhausted",
      suggestion: "Recharge the API project",
      data: null,
      debug: { authorization: "not projected" },
    }, 402),
  });
  await assert.rejects(
    () => connector.createTask(request),
    (error) => {
      assert.ok(error instanceof TripoConnectorError);
      assert.equal(error.code, 2010);
      assert.equal(error.httpStatus, 402);
      assert.equal(error.suggestion, "Recharge the API project");
      assert.doesNotMatch(JSON.stringify(error), /not projected/);
      return true;
    },
  );
});

test("fails closed for Studio credentials and requests only the API origin", async () => {
  const connector = new TripoConnector({
    keyring: new FakeKeyring("studio-session-cookie"),
    request: async () => { throw new Error("fetch should not run"); },
  });
  await assert.rejects(() => connector.createTask(request), /beginning with tsk_/);

  const requests = [];
  assert.equal(await requestTripoAccess({
    request(value) {
      requests.push(value);
      return Promise.resolve(true);
    },
  }), true);
  assert.deepEqual(requests, [{ origins: ["https://api.tripo3d.ai/*"] }]);
});
