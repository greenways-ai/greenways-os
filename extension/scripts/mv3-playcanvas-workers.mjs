import { readFile } from "node:fs/promises";

const PLAYCANVAS_ROOT = new URL(
  "../node_modules/playcanvas/build/playcanvas/src/scene/",
  import.meta.url,
);

const WORKERS = Object.freeze({
  classic: Object.freeze({
    sorterPath: "gsplat/gsplat-sorter.js",
    constructorEnd: "\n\t}\n\tdestroy()",
    output: "gsplat-sort-worker.js",
    sources: ["gsplat/gsplat-sort-worker.js"],
    start: "SortWorker();",
  }),
  unified: Object.freeze({
    sorterPath: "gsplat-unified/gsplat-unified-sorter.js",
    constructorEnd: "\n\t}\n\tonSorted(",
    output: "gsplat-unified-sort-worker.js",
    sources: [
      "gsplat-unified/gsplat-sort-bin-weights.js",
      "gsplat-unified/gsplat-unified-sort-worker.js",
    ],
    start: "UnifiedSortWorker();",
  }),
});

const DISABLED_DYNAMIC_DECODERS = Object.freeze({
  "/playcanvas/build/playcanvas/src/framework/parsers/draco-decoder.js": `
export const dracoInitialize = () => {};
export const dracoDecode = (_buffer, callback) => {
  callback?.("Draco decoding is not available in the Greenways MV3 world host");
  return false;
};
`,
  "/playcanvas/build/playcanvas/src/framework/handlers/basis.js": `
export const basisInitialize = () => {};
export const basisTranscode = (_device, _url, _data, callback) => {
  callback?.("Basis transcoding is not available in the Greenways MV3 world host");
  return false;
};
`,
});

function withoutExports(source, path) {
  const output = source.replace(/\nexport \{[\s\S]*?\};\s*$/, "");
  if (output === source) throw new Error(`PlayCanvas worker source changed shape: ${path}`);
  return output;
}

export function rewritePlayCanvasSorter(source, kind) {
  const definition = WORKERS[kind];
  if (!definition) throw new Error(`Unknown PlayCanvas sorter kind: ${kind}`);
  const start = source.indexOf("\t\tconst workerSource =");
  const end = source.indexOf(definition.constructorEnd, start);
  if (start < 0 || end < 0) {
    throw new Error(`PlayCanvas ${kind} sorter changed shape; refusing an unsafe MV3 build`);
  }
  const replacement = [
    `\t\tthis.worker = new Worker(new URL("./${definition.output}", import.meta.url));`,
    `\t\tthis.worker.addEventListener("message", ${kind === "classic" ? "messageHandler" : "this.onSorted.bind(this)"});`,
  ].join("\n");
  const output = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  if (/URL\.createObjectURL\(new Blob|eval:\s*true/.test(output)) {
    throw new Error(`PlayCanvas ${kind} sorter still contains a dynamic worker`);
  }
  return output;
}

export function mv3PlayCanvasWorkerPlugin() {
  return {
    name: "mv3-playcanvas-static-workers",
    setup(build) {
      build.onLoad({ filter: /gsplat(?:-unified)?-sorter\.js$/ }, async ({ path }) => {
        const normalized = path.replaceAll("\\", "/");
        const entry = Object.entries(WORKERS).find(([, definition]) => (
          normalized.endsWith(`/playcanvas/build/playcanvas/src/scene/${definition.sorterPath}`)
        ));
        if (!entry) return null;
        const [kind] = entry;
        return {
          contents: rewritePlayCanvasSorter(await readFile(path, "utf8"), kind),
          loader: "js",
        };
      });
      build.onLoad({ filter: /(?:basis|draco-decoder)\.js$/ }, async ({ path }) => {
        const normalized = path.replaceAll("\\", "/");
        const entry = Object.entries(DISABLED_DYNAMIC_DECODERS).find(([suffix]) => (
          normalized.endsWith(suffix)
        ));
        return entry ? { contents: entry[1], loader: "js" } : null;
      });
    },
  };
}

export async function staticWorkerSources() {
  const output = {};
  for (const definition of Object.values(WORKERS)) {
    const sources = await Promise.all(definition.sources.map(async (path) => (
      withoutExports(await readFile(new URL(path, PLAYCANVAS_ROOT), "utf8"), path)
    )));
    output[definition.output] = `${sources.join("\n\n")}\n\n${definition.start}\n`;
  }
  return output;
}
