import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createHomeNodeAdmin } from "./admin.js";
import {
  GreenwaysHomeNode,
  HOME_ERROR_PROTOCOL,
  HomeNodeError,
} from "./home-node.js";

const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function browserOrigin(value) {
  if (!value) return null;
  if (value.startsWith("chrome-extension://") || value.startsWith("moz-extension://")) return value;
  throw new HomeNodeError(403, "browser-origin-required", "Home Link accepts browser extension origins only");
}

function corsHeaders(origin = null) {
  return {
    "access-control-allow-origin": origin || "*",
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function writeJson(response, status, body, origin = null) {
  response.writeHead(status, corsHeaders(origin));
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HomeNodeError(413, "request-too-large", "Home node requests are limited to 64 KiB");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) throw new HomeNodeError(400, "empty-request", "A JSON request body is required");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HomeNodeError(400, "invalid-json", "Request body must be valid JSON");
  }
}

function originHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function listeningOrigin(server, host) {
  const address = server.address();
  if (!address || typeof address === "string") return null;
  return `http://${originHost(host)}:${address.port}`;
}

/**
 * One mutation lane for the compatibility service.
 *
 * Pairing, signed presence, unpairing, and local administration all touch the
 * same node maps and durable state file. The queue prevents an administrator
 * revocation from racing a signed browser request, and keeps accepting work
 * after an earlier operation fails.
 */
export function createHomeNodeOperationQueue() {
  let tail = Promise.resolve();
  return function runExclusive(operation) {
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("Home Node operation must be a function"));
    }
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
}

export function createHomeNodeServer({ node = new GreenwaysHomeNode(), host = "127.0.0.1", port = 58100 } = {}) {
  if (!LOOPBACK_BIND_HOSTS.has(host)) {
    throw new Error("The development Home Node must bind to loopback and sit behind HTTPS for remote routes");
  }

  let server = null;
  const getOrigin = () => listeningOrigin(server, host);
  const runExclusive = createHomeNodeOperationQueue();
  const admin = createHomeNodeAdmin({ node, getOrigin });

  server = createServer(async (request, response) => {
    let origin = null;
    try {
      const url = new URL(
        request.url ?? "/",
        getOrigin() ?? `http://${originHost(host)}:${port}`,
      );

      // The legacy administrator has a separate loopback, Host, session, and
      // CSRF boundary. Resolve it before the extension-origin CORS gate and in
      // the same mutation lane as signed browser operations.
      if (admin.matches(url.pathname)) {
        await runExclusive(() => admin.handle({ request, response, url }));
        return;
      }

      origin = browserOrigin(request.headers.origin);
      if (request.method === "OPTIONS") {
        response.writeHead(204, corsHeaders(origin));
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/.well-known/greenways-home") {
        writeJson(response, 200, node.discovery(), origin);
        return;
      }
      if (request.method === "POST" && url.pathname === "/greenways/v1/pair") {
        const body = await readJson(request);
        writeJson(response, 200, await runExclusive(() => node.pair(body)), origin);
        return;
      }
      if (request.method === "POST" && url.pathname === "/greenways/v1/status") {
        const body = await readJson(request);
        writeJson(response, 200, await runExclusive(() => node.status(body)), origin);
        return;
      }
      if (request.method === "POST" && url.pathname === "/greenways/v1/unpair") {
        const body = await readJson(request);
        writeJson(response, 200, await runExclusive(() => node.unpair(body)), origin);
        return;
      }
      throw new HomeNodeError(404, "not-found", "Greenways home endpoint was not found");
    } catch (error) {
      const status = error instanceof HomeNodeError ? error.status : 500;
      const code = error instanceof HomeNodeError ? error.code : "internal-error";
      if (!response.headersSent) {
        writeJson(response, status, {
          protocol: HOME_ERROR_PROTOCOL,
          error: code,
          message: status === 500 ? "The home node could not complete the request" : error.message,
        }, origin);
      } else {
        response.destroy();
      }
    }
  });

  return {
    node,
    server,
    async listen() {
      if (server.listening) return server.address();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    issuePairingCode() {
      return runExclusive(() => node.issuePairingCode());
    },
    get origin() {
      return getOrigin();
    },
    get adminUrl() {
      const origin = getOrigin();
      return origin ? `${origin}/admin` : null;
    },
  };
}

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

async function main() {
  const node = new GreenwaysHomeNode({
    id: process.env.GREENWAYS_HOME_ID || "greenways-home-dev",
    name: process.env.GREENWAYS_HOME_NAME || "Greenways Home (compatibility)",
    services: defaultServices(),
    onPairingCode(code, pairing) {
      console.log(`Greenways Home pairing code: ${code} (expires ${pairing.expiresAt})`);
    },
  });

  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 58100);
  const app = createHomeNodeServer({ node, host, port });
  await app.listen();
  console.log(`Greenways Home compatibility service listening at ${app.origin}`);
  console.log(`Local control plane: ${app.adminUrl}`);
  console.log("Pairing is closed until it is opened locally or SIGUSR1 is sent.");
  console.log("New gateway work belongs in Greenways Beacon on Hoplite.");

  process.on("SIGUSR1", () => {
    app.issuePairingCode().catch((error) => console.error("Could not issue pairing code", error));
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      console.log("Closing Greenways Home compatibility service…");
      await app.close();
      process.exit(0);
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
