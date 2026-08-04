import { pathToFileURL } from "node:url";
import { createHomeNodeServer } from "./server.js";
import {
  createPersistentHomeNode,
  defaultHomeNodeStatePath,
} from "./persistent-home-node.js";

function defaultServices() {
  return [
    {
      id: "hestia",
      name: "Hestia",
      kind: "evidence",
      version: "1",
      capabilities: ["evidence.sync"],
      status: "available",
    },
    {
      id: "historia",
      name: "Historia",
      kind: "memory",
      version: "1",
      capabilities: ["history.import"],
      status: "available",
    },
    {
      id: "hara-runtime",
      name: "Hara Runtime",
      kind: "runtime",
      version: "1",
      capabilities: ["hara.evaluate"],
      status: "available",
    },
  ];
}

function configuredPort(value = "58100") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return port;
}

export async function runPersistentHomeNode({ env = process.env } = {}) {
  let latestCode = null;
  const statePath = env.GREENWAYS_HOME_STATE_PATH || defaultHomeNodeStatePath();
  const node = createPersistentHomeNode({
    statePath,
    ...(env.GREENWAYS_HOME_ID ? { id: env.GREENWAYS_HOME_ID } : {}),
    ...(env.GREENWAYS_HOME_NAME ? { name: env.GREENWAYS_HOME_NAME } : {}),
    services: defaultServices(),
    onPairingCode(code, pairing) {
      latestCode = code;
      console.log(`Greenways Home pairing code: ${code} (expires ${pairing.expiresAt})`);
    },
  });
  node.issuePairingCode();

  const host = env.HOST || "127.0.0.1";
  const port = configuredPort(env.PORT);
  const app = createHomeNodeServer({ node, host, port });
  await app.listen();
  console.log(`Greenways Home listening at ${app.origin}`);
  console.log(`Home identity: ${node.node.keyId}`);
  console.log(`Durable state: ${node.statePath}`);
  console.log("The node advertises inert service descriptors only; it never sends browser code.");

  process.on("SIGUSR1", () => node.issuePairingCode());
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`Closing Greenways Home after ${signal} (${latestCode ? "pairing code invalidated" : "no active pairing code"})…`);
    await app.close();
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      try {
        await close(signal);
        process.exit(0);
      } catch (error) {
        console.error(error);
        process.exit(1);
      }
    });
  }

  return { app, node, statePath };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runPersistentHomeNode().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
