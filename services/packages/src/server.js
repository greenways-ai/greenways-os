import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { createServer } from "node:http";

const TYPES = new Map([
  [".edn", "application/edn; charset=utf-8"],
  [".harp", "application/octet-stream"],
  [".json", "application/json; charset=utf-8"],
]);

function safeTarget(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = resolve(root, `.${decoded}`);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.includes("\\")) return null;
  return target;
}

export function createRegistryServer({ root, host = "127.0.0.1", port = 8787 } = {}) {
  const staticRoot = resolve(root ?? "dist");
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" });
      response.end();
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const target = safeTarget(staticRoot, url.pathname);
    if (!target) {
      response.writeHead(400);
      response.end("Invalid path");
      return;
    }
    try {
      const info = await stat(target);
      if (!info.isFile()) throw new Error("not a file");
      const isIndex = url.pathname === "/v1/index.edn";
      response.writeHead(200, {
        "content-type": TYPES.get(extname(target)) ?? "application/octet-stream",
        "content-length": info.size,
        "cache-control": isIndex ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(target).pipe(response);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });
  return Object.freeze({
    server,
    listen() {
      return new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolveListen(server.address());
        });
      });
    },
    close() {
      return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    },
  });
}
