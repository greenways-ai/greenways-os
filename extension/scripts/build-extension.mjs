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
  loader: { ".hal": "text" },
  external: ["node:worker_threads"],
  entryNames: "[name]",
  outdir: "dist",
  plugins: [mv3PlayCanvasWorkerPlugin()],
};

const backgroundBuild = await build({
  ...common,
  entryPoints: ["src/background.js"],
  metafile: true,
});

const pageBuild = await build({
  ...common,
  entryPoints: ["src/world.js", "src/launcher.js", "src/devtools.js"],
  define: { __GREENWAYS_EXTENSION_HOST__: "true" },
  metafile: true,
  // The public web build may load its own local Hara runtime. Packaged pages
  // must always use the single service-worker host instead.
});

for (const buildResult of [backgroundBuild, pageBuild]) {
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

const [backgroundBundle, launcherBundle, devtoolsBundle] = await Promise.all([
  readFile(new URL("../dist/background.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/launcher.js", import.meta.url), "utf8"),
  readFile(new URL("../dist/devtools.js", import.meta.url), "utf8"),
]);
if (!backgroundBundle.includes("gw.os.kernel") || !backgroundBundle.includes("data:application/wasm;base64")) {
  throw new Error("The MV3 background bundle does not contain the reviewed Hara kernel runtime");
}
for (const [name, source] of [["launcher", launcherBundle], ["world", worldBundle], ["devtools", devtoolsBundle]]) {
  if (source.includes("data:application/wasm;base64") || source.includes("gw.os.kernel")) {
    throw new Error(`The ${name} page bundle contains a second Hara kernel runtime`);
  }
}
