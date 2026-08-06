import { parseEDNString } from "edn-data";
import { start } from "./hara-vm.mjs";
import adaptorSource from "../../src/gw/os/adaptor.hal";
import kernelSource from "../../src/gw/os/kernel.hal";
import { encodeHalValue } from "./hal-transport.js";
import { createHalModuleRuntime } from "./hal-module-runtime.js";

const runtimePromise = start({
  resources: {
    "gw.os.adaptor": adaptorSource,
    "gw.os.kernel": kernelSource,
  },
}).then((runtime) => {
  runtime.require("gw.os.kernel");
  return runtime;
});

let invokerPromise;
let moduleRuntimePromise;

function decode(value) {
  return parseEDNString(value, {
    mapAs: "object",
    setAs: "array",
    listAs: "array",
    keywordAs: "string",
    charAs: "string",
    objectKeysAs: "string",
  });
}

export function createGreenwaysInvoker() {
  if (!invokerPromise) {
    invokerPromise = runtimePromise.then((runtime) => (method, args = []) => {
      const output = runtime.eval(`(gw.os.kernel/dispatch ${encodeHalValue(method)} ${encodeHalValue(args)})`);
      return decode(output);
    });
  }
  return invokerPromise;
}

export function createGreenwaysModuleRuntime() {
  if (!moduleRuntimePromise) {
    moduleRuntimePromise = runtimePromise.then(createHalModuleRuntime);
  }
  return moduleRuntimePromise;
}

export async function invokeGreenways(method, args = []) {
  return (await createGreenwaysInvoker())(method, args);
}

export async function greenwaysCapabilities() {
  return invokeGreenways("app/capabilities");
}

export async function installGreenwaysModule(staged) {
  return (await createGreenwaysModuleRuntime()).installModule(staged);
}

export async function reloadGreenwaysModule(id, staged) {
  return (await createGreenwaysModuleRuntime()).reloadModule(id, staged);
}

export async function removeGreenwaysModule(id) {
  return (await createGreenwaysModuleRuntime()).removeModule(id);
}

export async function invokeGreenwaysModule(id, args = []) {
  const output = (await createGreenwaysModuleRuntime()).invoke(
    id,
    args.map(encodeHalValue),
  );
  return decode(output);
}
