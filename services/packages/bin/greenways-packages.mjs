#!/usr/bin/env node
import { resolve } from "node:path";
import { buildRegistry } from "../src/build.js";
import { createRegistryServer } from "../src/server.js";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const command = process.argv[2] ?? "serve";
if (command === "build") {
  const key = option("registry-key", process.env.GREENWAYS_REGISTRY_PRIVATE_JWK);
  if (!key) throw new Error("build requires --registry-key or GREENWAYS_REGISTRY_PRIVATE_JWK");
  const result = await buildRegistry({
    source: resolve(option("source", ".")),
    output: resolve(option("output", "dist")),
    registryPrivateKey: resolve(key),
  });
  console.log(JSON.stringify(result, null, 2));
} else if (command === "serve") {
  const host = option("host", process.env.HOST ?? "127.0.0.1");
  const port = Number(option("port", process.env.PORT ?? 8787));
  const root = resolve(option("root", "dist"));
  const service = createRegistryServer({ root, host, port });
  const address = await service.listen();
  console.log(`Greenways packages registry listening on http://${address.address}:${address.port}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await service.close();
      process.exit(0);
    });
  }
} else {
  throw new Error("Usage: greenways-packages <build|serve> [options]");
}
