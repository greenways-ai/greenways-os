import init, * as wasmBindings from "./wasm/hara_wasm.js";
import { instantiateWholeWasm } from "./whole-wasm.js";
export { installLockedPackages, installPackageProvider, loadLockedPackageResources } from "./packages.js";

const { Runtime } = wasmBindings;

let started;

function asResourceEntries(resources) {
  if (!resources) return [];
  if (resources instanceof Map) return [...resources.entries()];
  return Object.entries(resources);
}

function createApi(runtime) {
  const loadWholeWasm = (artifact) =>
    instantiateWholeWasm(artifact, wasmBindings.WholeWasmHost);

  return Object.freeze({
    eval(source) {
      return runtime.eval(String(source));
    },
    require(namespace) {
      return runtime.require_resource(String(namespace));
    },
    registerResource(namespace, source) {
      runtime.register_resource(String(namespace), String(source));
    },
    unregisterResource(namespace) {
      runtime.unregister_resource(String(namespace));
    },
    evalInNamespace(namespace, source) {
      return runtime.eval_in_namespace(String(namespace), String(source));
    },
    currentNamespace() {
      return runtime.current_namespace();
    },
    compileBytecode(source) {
      return runtime.compileBytecodeArtifact(String(source));
    },
    evalBytecode(artifact) {
      return runtime.evalBytecodeArtifact(artifact);
    },
    loadWholeWasm(artifact) {
      return loadWholeWasm(artifact);
    },
    async compileWholeWasm(source) {
      if (typeof runtime.compileWholeWasmArtifact !== "function") {
        throw new Error("whole-Wasm compilation requires @hara-lang/browser/full");
      }
      const artifact = runtime.compileWholeWasmArtifact(String(source));
      return loadWholeWasm(artifact);
    },
    raw: runtime,
    dispose() {
      runtime.free();
    }
  });
}

function defaultWasmUrl() {
  // The release build inlines the Wasm payload into the generated
  // wasm-bindgen module, so the default path is self-contained for both the
  // ESM and IIFE/CDN builds. A caller can still provide wasmUrl explicitly.
  return undefined;
}

/**
 * Starts an isolated Hara runtime. The embedded HAL catalog is loaded by the
 * Wasm Runtime constructor; `resources` are optional host overrides.
 */
export async function start({ wasmUrl, resources } = {}) {
  if (!started) {
    started = (async () => {
      await init(wasmUrl ?? defaultWasmUrl());
      const runtime = new Runtime();
      return createApi(runtime);
    })();
  }
  const api = await started;
  for (const [namespace, source] of asResourceEntries(resources)) {
    api.registerResource(namespace, source);
  }
  return api;
}

export const ready = start();
