#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BrowserBridgeHost } from "../src/host.js";
import { NativeMessageDecoder, writeNativeMessage } from "../src/native-framing.js";

const home = resolve(process.env.GREENWAYS_HOME || join(homedir(), ".greenways"));
const socketPath = resolve(home, "run", "greenwaysd.sock");
const credentialPath = resolve(
  process.env.GREENWAYS_BROWSER_CREDENTIAL || join(home, "clients", "browser-bridge.json"),
);
const host = new BrowserBridgeHost({ socketPath, credentialPath });
const decoder = new NativeMessageDecoder();
let queue = Promise.resolve();
let closing = false;

function close() {
  if (closing) return;
  closing = true;
  host.close();
}

process.stdin.on("data", (chunk) => {
  let messages;
  try {
    messages = decoder.push(chunk);
  } catch (error) {
    queue = queue.then(() => writeNativeMessage(process.stdout, {
      protocol: "greenways-browser-bridge-result/0-alpha",
      type: "response",
      id: "bridge/request/invalid0001",
      ok: false,
      status: {
        protocol: "greenways-browser-bridge-status/0-alpha",
        state: "protocol-mismatch",
        daemon: null,
        actor: null,
        identity: null,
        session: null,
        error: { code: "protocol-mismatch", message: error?.message || "Native message is invalid." },
        observedAtUnixMs: Date.now(),
      },
      error: { code: "protocol-mismatch", message: error?.message || "Native message is invalid." },
    }));
    return;
  }
  for (const message of messages) {
    queue = queue
      .then(() => host.handle(message))
      .then((response) => writeNativeMessage(process.stdout, response))
      .catch(() => {});
  }
});
process.stdin.on("end", close);
process.stdin.on("error", close);
process.on("SIGTERM", () => { close(); process.exit(0); });
process.on("SIGINT", () => { close(); process.exit(0); });
