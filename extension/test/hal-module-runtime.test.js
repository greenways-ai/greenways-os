import assert from "node:assert/strict";
import test from "node:test";
import {
  createHalModuleRuntime,
  rewriteHalModuleResources,
} from "../src/hal-module-runtime.js";

const LOCK_A = `sha256:${"a".repeat(64)}`;
const LOCK_B = `sha256:${"b".repeat(64)}`;

class FakeRuntime {
  constructor() {
    this.namespace = "gw.os.kernel";
    this.namespaces = new Set([this.namespace]);
    this.resources = new Map();
    this.required = [];
    this.evaluations = [];
  }

  currentNamespace() { return this.namespace; }
  registerResource(name, source) { this.resources.set(name, source); }
  require(resource) {
    this.required.push({ resource, namespace: this.namespace });
    if (!this.resources.has(resource)) throw new Error("missing resource");
    return ":loaded";
  }

  evalInNamespace(namespace, source) {
    this.namespaces.add(namespace);
    this.namespace = namespace;
    this.evaluations.push({ namespace, source });
    return source === "nil" ? "nil" : '{"type" "text" "text" "hello"}';
  }
}

function staged(lockDigest = LOCK_A, source = "(ns notes.app) (defn view [input] input)") {
  return {
    id: "notes",
    lockDigest,
    entry: "notes.app/view",
    resources: { "notes.app": source },
  };
}

test("rewrites every package-local namespace into an app generation", () => {
  const output = rewriteHalModuleResources("notes", 3, {
    "notes.model": "(ns notes.model) (defn value [] 42)",
    "notes.app": `(ns notes.app (:require [notes.model :as model]))
; notes.model/value remains a comment
(def label "notes.model/value remains a string")
(defn view [] (notes.model/value))`,
  });
  assert.equal(output.root, "app.notes.g3");
  assert.ok(output.resources["app.notes.g3.notes.app"].includes("(ns app.notes.g3.notes.app"));
  assert.ok(output.resources["app.notes.g3.notes.app"].includes("[app.notes.g3.notes.model :as model]"));
  assert.ok(output.resources["app.notes.g3.notes.app"].includes("(app.notes.g3.notes.model/value)"));
  assert.ok(output.resources["app.notes.g3.notes.app"].includes('"notes.model/value remains a string"'));
  assert.ok(output.resources["app.notes.g3.notes.app"].includes("; notes.model/value remains a comment"));
});

test("rejects protected, native, and dynamic evaluator escape forms", () => {
  for (const source of [
    "(ns notes.app) (gw.os.kernel/dispatch \"x\" [])",
    "(ns notes.app) (std.native.Host/call \"x\")",
    "(ns notes.app) (app.other.private/read)",
    "(ns notes.app) (eval \"(+ 1 1)\")",
    "(ns notes.app) (load-string \"(+ 1 1)\")",
  ]) {
    assert.throws(() => rewriteHalModuleResources("notes", 1, { "notes.app": source }), /cannot reference|cannot call|forbidden dynamic/);
  }
});

test("install and reload stage a fresh generation before swapping", () => {
  const raw = new FakeRuntime();
  const modules = createHalModuleRuntime(raw);
  const first = modules.installModule(staged());
  assert.equal(first.root, "app.notes.g1");
  assert.equal(modules.get("notes").lockDigest, LOCK_A);
  assert.equal(raw.currentNamespace(), "gw.os.kernel");

  const prepared = modules.prepareReload("notes", staged(LOCK_B, "(ns notes.app) (defn view [input] {\"next\" input})"));
  assert.equal(prepared.descriptor.root, "app.notes.g2");
  assert.equal(modules.get("notes").root, "app.notes.g1");
  prepared.commit();
  assert.equal(modules.get("notes").root, "app.notes.g2");
  assert.equal(modules.get("notes").lockDigest, LOCK_B);
});

test("a rolled-back reload leaves the active generation untouched", () => {
  const raw = new FakeRuntime();
  const modules = createHalModuleRuntime(raw);
  modules.installModule(staged());
  const prepared = modules.prepareReload("notes", staged(LOCK_B));
  assert.equal(prepared.rollback(), true);
  assert.equal(prepared.rollback(), false);
  assert.equal(modules.get("notes").root, "app.notes.g1");
  assert.equal(modules.get("notes").lockDigest, LOCK_A);
});

test("module invocation uses only the active qualified entry and restores the kernel namespace", () => {
  const raw = new FakeRuntime();
  const modules = createHalModuleRuntime(raw);
  modules.installModule(staged());
  const output = modules.invoke("notes", ['{"message" "hello"}']);
  assert.equal(output, '{"type" "text" "text" "hello"}');
  assert.deepEqual(raw.evaluations.findLast(({ source }) => source !== "nil"), {
    namespace: "app.notes.g1",
    source: '(app.notes.g1.notes.app/view {"message" "hello"})',
  });
  assert.equal(raw.currentNamespace(), "gw.os.kernel");
});

test("remove is transactional and does not pretend old namespaces were erased", () => {
  const raw = new FakeRuntime();
  const modules = createHalModuleRuntime(raw);
  modules.installModule(staged());
  const removal = modules.prepareRemove("notes");
  assert.ok(modules.get("notes"));
  removal.commit();
  assert.equal(modules.get("notes"), null);
  assert.ok(raw.namespaces.has("app.notes.g1"));
});
