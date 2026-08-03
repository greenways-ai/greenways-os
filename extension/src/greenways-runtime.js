import { parseEDNString } from "edn-data";
import { start } from "./hara-vm.mjs";
import adaptorSource from "../../src/greenways/adaptor.hal";
import kernelSource from "../../src/greenways/kernel.hal";
import { loadLockedPackageResources } from "./hara-packages.js";

const runtime = await start({
  resources: {
    "greenways.adaptor": adaptorSource,
    "greenways.kernel": kernelSource,
  },
});

runtime.require("greenways.kernel");

function encode(value) {
  if (value === undefined) return "nil";
  return JSON.stringify(value);
}

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

export function invokeGreenways(method, args = []) {
  const output = runtime.eval(`(greenways.kernel/dispatch ${encode(method)} ${encode(args)})`);
  return decode(output);
}

export function greenwaysCapabilities() {
  return invokeGreenways("app/capabilities");
}

export async function activateLockedPackages(lockSource, request) {
  const resources = await loadLockedPackageResources(lockSource, request);
  for (const [namespace, source] of Object.entries(resources)) runtime.registerResource(namespace, source);
  return Object.keys(resources);
}
