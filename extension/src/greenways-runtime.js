import { parseEDNString } from "edn-data";
import { start } from "./hara-vm.mjs";
import adaptorSource from "../../src/greenways/adaptor.hal";
import kernelSource from "../../src/greenways/kernel.hal";
import { installLockedPackages } from "./hara-packages.js";
import { encodeHalValue } from "./hal-transport.js";

const runtime = await start({
  resources: {
    "greenways.adaptor": adaptorSource,
    "greenways.kernel": kernelSource,
  },
});

runtime.require("greenways.kernel");

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
  const output = runtime.eval(`(greenways.kernel/dispatch ${encodeHalValue(method)} ${encodeHalValue(args)})`);
  return decode(output);
}

export function greenwaysCapabilities() {
  return invokeGreenways("app/capabilities");
}

export async function activateLockedPackages(lockSource, request) {
  return installLockedPackages(runtime, lockSource, { fetch: request });
}
