import { mkdir, readFile, writeFile } from "node:fs/promises";
import { build, transform } from "esbuild";
import {
  mv3PlayCanvasWorkerPlugin,
  staticWorkerSources,
} from "./mv3-playcanvas-workers.mjs";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/world.js", "src/launcher.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome116",
  loader: { ".hal": "text" },
  external: ["node:worker_threads"],
  entryNames: "[name]",
  outdir: "dist",
  plugins: [mv3PlayCanvasWorkerPlugin()],
});

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
