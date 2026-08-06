#!/usr/bin/env node
import { DevtoolsRespHost, DEVTOOLS_BRIDGE_PROTOCOL } from "../src/bridge-host.js";
import { NativeMessageDecoder, writeNativeMessage } from "../src/native-framing.js";

const decoder = new NativeMessageDecoder();
const host = new DevtoolsRespHost({
  sendNative: (message) => writeNativeMessage(process.stdout, message),
});

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  await host.close().catch(() => {});
  process.exitCode = code;
}

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)
      || message.protocol !== DEVTOOLS_BRIDGE_PROTOCOL) {
    throw new Error("Unsupported Greenways DevTools native message");
  }
  if (message.type === "configure") {
    await host.configure(message);
    return;
  }
  if (message.type === "response") {
    host.response(message);
    return;
  }
  if (message.type === "shutdown") {
    await shutdown(0);
    return;
  }
  throw new Error(`Unsupported Greenways DevTools native message type: ${message.type}`);
}

process.stdin.on("data", (chunk) => {
  let messages;
  try {
    messages = decoder.push(chunk);
  } catch (error) {
    host.fail(error).finally(() => shutdown(1));
    return;
  }
  for (const message of messages) {
    Promise.resolve(handle(message)).catch((error) => host.fail(error).finally(() => shutdown(1)));
  }
});
process.stdin.on("end", () => shutdown(0));
process.stdin.on("error", () => shutdown(1));
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
