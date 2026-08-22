import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REMOTE_SANDBOX_EXECUTION_OPERATIONS,
  buildBoundCall,
  createRemoteSandboxExecutor,
  projectRemoteValue,
} from "../src/remote-sandbox-executor.js";
import {
  TEST_REQUEST_ID,
  TEST_SOURCE_DIGEST,
  testDescriptor,
  testRequest,
} from "./remote-host-fixtures.js";

function restrictedDescriptor(overrides = {}) {
  return testDescriptor({
    operations: ["runtime.get", ...REMOTE_SANDBOX_EXECUTION_OPERATIONS],
    ...overrides,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.cancelled = false;
  promise.cancel = () => {
    promise.cancelled = true;
    reject(new Error("cancelled"));
  };
  return { promise, resolve, reject };
}

async function eventually(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function executorHarness({ value = 42, closeFails = false, pending = null, ...overrides } = {}) {
  const calls = [];
  const workers = [];
  const runtimes = [];
  let sequence = 0;
  const executor = createRemoteSandboxExecutor({
    now: () => new Date(`2026-08-21T00:00:00.${String(sequence++).padStart(3, "0")}Z`),
    digestSource: async () => TEST_SOURCE_DIGEST,
    async createRuntime({ request, signal }) {
      const worker = {
        name: request.requestId,
        terminated: false,
        terminate() { this.terminated = true; },
      };
      const context = {
        calls,
        call(target, args) {
          calls.push({ target, args, signal });
          return pending?.promise ?? Promise.resolve(value);
        },
        async close() {
          if (closeFails) throw new Error("close failed");
        },
      };
      workers.push(worker);
      const runtime = { worker, context };
      runtimes.push(runtime);
      return runtime;
    },
    ...overrides,
  });
  return { executor, calls, workers, runtimes };
}

test("eval executes in one fresh runtime and returns exact bound evidence", async () => {
  const { executor, calls, workers } = executorHarness({ value: 42 });
  const descriptor = restrictedDescriptor();
  const result = await executor.execute(testRequest(), { descriptor });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, { text: "42", json: 42 });
  assert.equal(result.runtime.hostId, descriptor.hostId);
  assert.equal(result.runtime.hostGeneration, descriptor.generation);
  assert.equal(result.evidence.sourceDigest, TEST_SOURCE_DIGEST);
  assert.equal(result.evidence.cleanup, "completed");
  assert.deepEqual(calls.map(({ target, args }) => ({ target, args })), [
    { target: "eval", args: ["(+ 40 2)"] },
  ]);
  assert.equal(workers[0].terminated, true);
  assert.equal(executor.active(), 0);
  await executor.close();
});

test("qualified call uses eval-bound placeholders, transfer-safe bindings, and its optional source", async () => {
  const value = new Map([["answer", 42]]);
  const { executor, calls } = executorHarness({ value });
  const request = testRequest({
    operation: "sandbox.call",
    namespace: "example.core",
    symbol: "add",
    arguments: [40, 2],
    source: "(ns example.core)",
  });
  const result = await executor.execute(request, { descriptor: restrictedDescriptor() });

  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, { text: "{\"answer\" 42}", json: { answer: 42 } });
  assert.deepEqual(calls.map(({ target, args }) => ({ target, args })), [
    {
      target: "eval-bound",
      args: ["(ns example.core)\n(example.core/add __hta_arg_0 __hta_arg_1)", [40, 2]],
    },
  ]);
  await executor.close();
});

test("qualified call target syntax fails closed before source construction", () => {
  assert.throws(
    () => buildBoundCall({
      operation: "sandbox.call",
      namespace: "std.foundation)(browser.dom/read",
      symbol: "+",
      arguments: [],
    }),
    (error) => error.code === "remote/call-target-invalid",
  );
  assert.throws(
    () => buildBoundCall({
      operation: "sandbox.call",
      namespace: "std.foundation",
      symbol: "+)(browser.dom/read",
      arguments: [],
    }),
    (error) => error.code === "remote/call-target-invalid",
  );
});

test("source digest mismatch fails before a runtime is created", async () => {
  const { executor, runtimes } = executorHarness({
    digestSource: async () => `sha256:${"3".repeat(64)}`,
  });
  const result = await executor.execute(testRequest(), { descriptor: restrictedDescriptor() });

  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics[0].code, "remote/source-digest-mismatch");
  assert.equal(result.evidence.cleanup, "uncertain");
  assert.equal(runtimes.length, 0);
  await executor.close();
});

test("descriptor state, bounds, and advertised operations remain truthful", async () => {
  const { executor } = executorHarness();
  await assert.rejects(
    executor.execute(testRequest(), { descriptor: restrictedDescriptor({ state: "degraded" }) }),
    (error) => error.code === "remote/host-incompatible",
  );
  await assert.rejects(
    executor.execute(testRequest(), { descriptor: testDescriptor() }),
    (error) => error.code === "remote/host-incompatible",
  );
  await assert.rejects(
    executor.execute(testRequest(), {
      descriptor: restrictedDescriptor({
        limits: { maxSourceBytes: 65_536, maxOutputBytes: 1_048_576, maxWallMs: 1 },
      }),
    }),
    (error) => error.code === "remote/limit-exceeded",
  );
  await executor.close();
});

test("duplicate request ID is reserved before asynchronous runtime creation", async () => {
  const gate = deferred();
  let factoryCalls = 0;
  const executor = createRemoteSandboxExecutor({
    digestSource: async () => TEST_SOURCE_DIGEST,
    async createRuntime() {
      factoryCalls += 1;
      await gate.promise;
      return {
        worker: { terminate() {} },
        context: {
          call() { return Promise.resolve(42); },
          async close() {},
        },
      };
    },
  });
  const descriptor = restrictedDescriptor();
  const first = executor.execute(testRequest(), { descriptor });
  await eventually(() => factoryCalls === 1);
  assert.equal(executor.active(), 1);
  await assert.rejects(
    executor.execute(testRequest(), { descriptor }),
    (error) => error.code === "remote/request-busy",
  );
  assert.equal(factoryCalls, 1);
  gate.resolve();
  assert.equal((await first).status, "completed");
  await executor.close();
});

test("direct executor cancellation settles the active request as cancelled", async () => {
  const pending = deferred();
  const { executor, workers } = executorHarness({ pending });
  const running = executor.execute(testRequest(), { descriptor: restrictedDescriptor() });
  await eventually(() => workers.length === 1);
  assert.equal(executor.active(), 1);
  assert.equal(await executor.cancel(TEST_REQUEST_ID, "client-cancelled"), true);
  const result = await running;

  assert.equal(result.status, "cancelled");
  assert.equal(result.diagnostics[0].code, "remote/cancelled");
  assert.equal(pending.promise.cancelled, true);
  assert.equal(workers[0].terminated, true);
  assert.equal(await executor.cancel(TEST_REQUEST_ID), false);
  await executor.close();
});

test("wall timeout cancels the pending task and releases the runtime", async () => {
  const pending = deferred();
  const { executor, workers } = executorHarness({
    pending,
    setTimeoutImpl: (callback) => setImmediate(callback),
    clearTimeoutImpl: (handle) => clearImmediate(handle),
  });
  const result = await executor.execute(testRequest({ limits: { wallMs: 5, outputBytes: 262_144 } }), {
    descriptor: restrictedDescriptor(),
  });

  assert.equal(result.status, "timed-out");
  assert.equal(result.diagnostics[0].code, "remote/timed-out");
  assert.equal(pending.promise.cancelled, true);
  assert.equal(workers[0].terminated, true);
  assert.equal(executor.active(), 0);
  await executor.close();
});

test("cleanup failure is reported as uncertain without changing the completed value", async () => {
  const { executor } = executorHarness({ value: true, closeFails: true });
  const result = await executor.execute(testRequest(), { descriptor: restrictedDescriptor() });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.value, { text: "true", json: true });
  assert.equal(result.evidence.cleanup, "uncertain");
  await executor.close();
});

test("output projection rejects unsupported and oversized values and preserves prototype-like keys", () => {
  assert.throws(
    () => projectRemoteValue({ privileged: true }, 1_024),
    (error) => error.code === "remote/result-not-transferable",
  );
  assert.throws(
    () => projectRemoteValue("x".repeat(256), 16),
    (error) => error.code === "remote/limit-exceeded",
  );
  const projection = projectRemoteValue(new Map([["__proto__", 42]]), 1_024);
  assert.equal(Object.getPrototypeOf(projection.json), Object.prototype);
  assert.equal(Object.hasOwn(projection.json, "__proto__"), true);
  assert.equal(projection.json.__proto__, 42);
});

test("unsupported check requests fail before runtime creation", async () => {
  const { executor, runtimes } = executorHarness();
  const result = await executor.execute(testRequest({
    operation: "sandbox.check",
    checkProfile: "reader",
  }), {
    descriptor: restrictedDescriptor({
      operations: ["runtime.get", "sandbox.eval", "sandbox.call"],
    }),
  }).catch((error) => error);
  assert.equal(result.code, "remote/operation-unsupported");
  assert.equal(runtimes.length, 0);
  await executor.close();
});

test("new request after close is rejected and close is idempotent", async () => {
  const { executor } = executorHarness();
  await executor.close();
  await executor.close();
  await assert.rejects(
    executor.execute(testRequest(), { descriptor: restrictedDescriptor() }),
    (error) => error.code === "remote/executor-closed",
  );
});
