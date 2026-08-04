import { parseEDNString } from "edn-data";
import { start } from "./hara-vm.mjs";
import adaptorSource from "../../src/gw/os/adaptor.hal";
import kernelSource from "../../src/gw/os/kernel.hal";
import { encodeHalValue } from "./hal-transport.js";

const runtime = await start({
  resources: {
    "gw.os.adaptor": adaptorSource,
    "gw.os.kernel": kernelSource,
  },
});

runtime.require("gw.os.kernel");

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
  const output = runtime.eval(`(gw.os.kernel/dispatch ${encodeHalValue(method)} ${encodeHalValue(args)})`);
  return decode(output);
}

export function greenwaysCapabilities() {
  return invokeGreenways("app/capabilities");
}