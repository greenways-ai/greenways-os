import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build, transform } from "esbuild";
import {
  mv3PlayCanvasWorkerPlugin,
  staticWorkerSources,
} from "./mv3-playcanvas-workers.mjs";

await mkdir("dist", { recursive: true });

const common = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  loader: { ".hal": "text", ".edn": "text" },
  external: ["node:worker_threads"],
  entryNames: "[name]",
  outdir: "dist",
  plugins: [mv3PlayCanvasWorkerPlugin()],
};

const backgroundBuild = await build({
  ...common,
  entryPoints: { background: "src/background-entry.js" },
  metafile: true,
});

const pageBuild = await build({
  ...common,
  entryPoints: {
    world: "src/world.js",
    launcher: "src/launcher-entry.js",
    devtools: "src/devtools.js",
  },
  define: { __GREENWAYS_EXTENSION_HOST__: "true" },
  metafile: true,
  // The public web build may load its own local Hara runtime. Packaged pages
  // must always use the single service-worker host instead.
});

const contentBuild = await build({
  ...common,
  format: "iife",
  entryPoints: {
    "playground-bridge": "src/playground-bridge.js",
    "chatgpt-provider-bridge": "src/chatgpt-provider-bridge.js",
    "mcp-authorization-bridge": "src/mcp-authorization-bridge.js",
  },
  metafile: true,
});

for (const buildResult of [backgroundBuild, pageBuild, contentBuild]) {
  for (const [outputPath, output] of Object.entries(buildResult.metafile.outputs)) {
    const unresolved = output.imports.find(({ external }) => external);
    if (unresolved) {
      throw new Error(`The packaged output ${outputPath} has an unresolved import: ${unresolved.path}`);
    }
  }
}

for (const [filename, source] of Object.entries(await staticWorkerSources())) {
  const { code } = await transform(source, {
    format: "iife",
    loader: "js",
    minify: true,
    target: "chrome116",
  });
  await writeFile(new URL(`../dist/${filename}`, import.meta.url), code);
}

const worldBundle = await readFile(new URL("../dist/world.js", import.meta.url), "utf8");
if (/new Worker\(URL\.createObjectURL|new Worker\(workerUrl\)|eval:\s*true/.test(worldBundle)) {
  throw new Error("The MV3 world bundle still contains a dynamic worker execution path");
}

const [
  backgroundBundle,
  launcherBundle,
  devtoolsBundle,
  playgroundBridgeBundle,
  chatgptProviderBridgeBundle,
  mcpAuthorizationBridgeBundle,
] = await Promise.all([
  readFile(new URL("../dist/background.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/launcher.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/devtools.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/playground-bridge.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/chatgpt-provider-bridge.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/mcp-authorization-bridge.js", import.meta.url), "utf8"),
]);
if (!backgroundBundle.includes("gw.os.kernel") || !backgroundBundle.includes("data:application/wasm;base64")) {
  throw new Error("The MV3 background bundle does not contain the reviewed Hara kernel runtime");
}
if (/^await\b/m.test(backgroundBundle)) {
  throw new Error("The MV3 background bundle contains top-level await");
}
for (const [name, source] of [
  ["launcher", launcherBundle],
  ["world", worldBundle],
  ["devtools", devtoolsBundle],
  ["playground-bridge", playgroundBridgeBundle],
  ["chatgpt-provider-bridge", chatgptProviderBridgeBundle],
  ["mcp-authorization-bridge", mcpAuthorizationBridgeBundle],
]) {
  if (source.includes("data:application/wasm;base64") || source.includes("gw.os.kernel")) {
    throw new Error(`The ${name} page bundle contains a second Hara kernel runtime`);
  }
}
