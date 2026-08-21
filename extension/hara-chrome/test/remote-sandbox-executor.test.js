import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBoundCall,
  createRemoteSandboxExecutor,
  projectRemoteValue,
} from "../src/remote-sandbox-executor.js";
import { testDescriptor, testRequest } from "./remote-host-fixtures.js";

function callRequest(overrides = {}) {
  return testRequest({
    operation: "sandbox.call",
    namespace: "std.foundation",
    symbol: "+",
    arguments: [40, 2],
    source: undefined,
    ...overrides,
  });
}

function cancellable(value, { delayMs = 0 } = {}) {
  let timer = null;
  let rejectPending;
  const promise = new Promise((resolve, reject) => {
    rejectPending = reject;
    timer = setTimeout(() => resolve(value), delayMs);
  });
  promise.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    rejectPending(Object.assign(new Error("cancelled"), { name: "AbortError", code: "remote/cancelled" }));
    return true;
  };
  return promise;
}

function harness({ value = 42, delayMs = 0, closeError = null } = {}) {
  const runtimes = [];
  const calls = [];
  const executor = createRemoteSandboxExecutor({
    createRuntime: async ({ request }) => {
      const worker = {
        terminated: 0,
        terminate() { this.terminated += 1; },
      };
      const context = {
        closed: 0,
        call(target, args) {
          calls.push({ requestId: request.requestId, target, args });
          const pending = cancellable(value, { delayMs });
          runtime.pending = pending;
          return pending;
        },
        async close() {
          this.closed += 1;
          if (closeError) throw closeError;
        },
      };
      const runtime = { requestId: request.requestId, worker, context, pending: null };
      runtimes.push(runtime);
      return runtime;
    },
  });
  return { executor, runtimes, calls };
}

test("each remote execution gets a fresh runtime and deterministic cleanup", async () => {
  const fixture = harness();
  const descriptor = testDescriptor({ backend: "rust-wasm", haraVersion: "test-hara" });
  const firstRequest = testRequest();
  const secondRequest = testRequest({ requestId: "00000000-0000-4000-8000-000000000172" });

  const first = await fixture.executor.execute(firstRequest, { descriptor });
  const second = await fixture.executor.execute(secondRequest, { descriptor });

  assert.equal(fixture.runtimes.length, 2);
  assert.notEqual(fixture.runtimes[0], fixture.runtimes[1]);
  for (const runtime of fixture.runtimes) {
    assert.equal(runtime.context.closed, 1);
    assert.equal(runtime.worker.terminated, 1);
  }
  assert.equal(first.status, "completed");
  assert.deepEqual(first.value, { text: "42", json: 42 });
  assert.equal(first.evidence.cleanup, "completed");
  assert.equal(second.status, "completed");
});

test("sandbox.eval forwards the exact source without trusted broker indirection", async () => {
  const fixture = harness();
  const request = testRequest({ source: "(+ 19 23)" });
  await fixture.executor.execute(request, { descriptor: testDescriptor() });
  assert.deepEqual(fixture.calls, [{
    requestId: request.requestId,
    target: "eval",
    args: ["(+ 19 23)"],
  }]);
});

test("sandbox.call transports arguments through eval-bound placeholders instead of source interpolation", async () => {
  const request = callRequest({ arguments: ["secret value", { nested: [1, 2] }] });
  const bound = buildBoundCall(request);
  assert.equal(bound.source, "(std.foundation/+ __hta_arg_0 __hta_arg_1)");
  assert.equal(bound.source.includes("secret value"), false);
  assert.deepEqual(bound.bindings, request.arguments);

  const fixture = harness({ value: 42 });
  await fixture.executor.execute(request, { descriptor: testDescriptor() });
  assert.equal(fixture.calls[0].target, "eval-bound");
  assert.equal(fixture.calls[0].args[0], bound.source);
  assert.deepEqual(fixture.calls[0].args[1], request.arguments);
});

test("AbortSignal cancels the active HTA call and returns a cancelled terminal result", async () => {
  const fixture = harness({ delayMs: 5_000 });
  const controller = new AbortController();
  const pending = fixture.executor.execute(testRequest(), {
    descriptor: testDescriptor(),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort("client-cancelled"), 5);
  const result = await pending;

  assert.equal(result.status, "cancelled");
  assert.equal(result.evidence.cleanup, "completed");
  assert.equal(fixture.runtimes[0].worker.terminated, 1);
  assert.match(result.diagnostics[0].code, /cancelled/u);
});

test("request wall limit cancels the HTA call and returns timed-out", async () => {
  const fixture = harness({ delayMs: 5_000 });
  const request = testRequest({ limits: { wallMs: 5, outputBytes: 262_144 } });
  const result = await fixture.executor.execute(request, { descriptor: testDescriptor() });
  assert.equal(result.status, "timed-out");
  assert.equal(result.evidence.cleanup, "completed");
});

test("non-transferable runtime handles fail closed instead of leaking native identity", async () => {
  const fixture = harness({ value: { constructor: { name: "HtaHandle" }, id: 99n, owner: "runtime" } });
  const result = await fixture.executor.execute(testRequest(), { descriptor: testDescriptor() });
  assert.equal(result.status, "failed");
  assert.equal(result.value, null);
  assert.equal(result.diagnostics[0].code, "remote/result-not-transferable");
  assert.equal(JSON.stringify(result).includes("99"), false);
  assert.equal(JSON.stringify(result).includes("runtime"), true); // runtime evidence is expected; handle identity is not.
});

test("cleanup uncertainty is reported when context closure cannot be verified", async () => {
  const fixture = harness({ closeError: new Error("close failed") });
  const result = await fixture.executor.execute(testRequest(), { descriptor: testDescriptor() });
  assert.equal(result.status, "completed");
  assert.equal(result.evidence.cleanup, "uncertain");
  assert.equal(fixture.runtimes[0].worker.terminated, 1);
});

test("transfer projection is JSON only for safe values and enforces output bounds", () => {
  assert.deepEqual(projectRemoteValue(new Map([["answer", 42]]), 1024), {
    text: "{\"answer\" 42}",
    json: { answer: 42 },
  });
  assert.throws(
    () => projectRemoteValue("x".repeat(100), 8),
    (error) => error.code === "remote/limit-exceeded",
  );
});
