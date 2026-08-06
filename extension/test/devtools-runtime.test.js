import assert from "node:assert/strict";
import test from "node:test";
import { createDevtoolsRuntime } from "../src/devtools-runtime.js";

function rig() {
  let current = "gw.os.kernel";
  const evaluations = [];
  const calls = [];
  const runtime = {
    currentNamespace: () => current,
    evalInNamespace(namespace, source) {
      evaluations.push([namespace, source]);
      current = namespace;
      return source === "nil" ? "nil" : "42";
    },
  };
  const modules = {
    list: () => [{
      id: "example-app",
      generation: 2,
      root: "app.example-app.g2",
      lockDigest: `sha256:${"a".repeat(64)}`,
      entry: "app.example-app.g2.core/view",
      private: "not exposed",
    }],
  };
  const invoke = async (method, args) => {
    calls.push([method, args]);
    return { method, args };
  };
  return { devtools: createDevtoolsRuntime({ runtime, modules, invoke }), evaluations, calls, runtime };
}

test("evaluates Hara in an explicit namespace and restores the kernel namespace", async () => {
  const { devtools, evaluations, runtime } = rig();
  const result = await devtools.call("devtools/eval", [{ namespace: "gw.devtools.scratch", source: "(+ 20 22)" }]);
  assert.deepEqual(result, { namespace: "gw.devtools.scratch", output: "42" });
  assert.deepEqual(evaluations, [
    ["gw.devtools.scratch", "(+ 20 22)"],
    ["gw.os.kernel", "nil"],
  ]);
  assert.equal(runtime.currentNamespace(), "gw.os.kernel");
});

test("returns bounded public module status", async () => {
  const { devtools } = rig();
  const status = await devtools.call("devtools/status");
  assert.equal(status.protocol, "greenways-devtools/1");
  assert.equal(status.currentNamespace, "gw.os.kernel");
  assert.deepEqual(status.modules, [{
    id: "example-app",
    generation: 2,
    root: "app.example-app.g2",
    lockDigest: `sha256:${"a".repeat(64)}`,
    entry: "app.example-app.g2.core/view",
  }]);
  assert.equal("private" in status.modules[0], false);
});

test("calls reviewed kernel methods without recursive DevTools dispatch", async () => {
  const { devtools, calls } = rig();
  assert.deepEqual(
    await devtools.call("devtools/call", ["core/services", []]),
    { method: "core/services", args: [] },
  );
  assert.deepEqual(calls, [["core/services", []]]);
  await assert.rejects(devtools.call("devtools/call", ["devtools/status", []]), /invalid/);
  await assert.rejects(devtools.call("devtools/eval", [{ namespace: "bad/namespace", source: "1" }]), /namespace is invalid/);
});


test("bounds evaluation output and kernel call results", async () => {
  const oversized = "x".repeat(1024 * 1024 + 1);
  const runtime = {
    currentNamespace: () => "gw.os.kernel",
    evalInNamespace: (_namespace, source) => source === "nil" ? "nil" : oversized,
  };
  const modules = { list: () => [] };
  const devtools = createDevtoolsRuntime({ runtime, modules, invoke: async () => ({ value: oversized }) });
  await assert.rejects(
    devtools.call("devtools/eval", [{ namespace: "gw.scratch", source: "42" }]),
    /eval output exceeds the 1 MB/,
  );
  await assert.rejects(
    devtools.call("devtools/call", ["core/services", []]),
    /kernel result exceeds the 1 MB/,
  );
});
