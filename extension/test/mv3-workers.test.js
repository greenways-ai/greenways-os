import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  rewritePlayCanvasSorter,
  staticWorkerSources,
} from "../scripts/mv3-playcanvas-workers.mjs";

const sceneRoot = new URL(
  "../node_modules/playcanvas/build/playcanvas/src/scene/",
  import.meta.url,
);

test("replaces PlayCanvas Blob sorters with packaged MV3 workers", async () => {
  const cases = [
    ["classic", "gsplat/gsplat-sorter.js", "gsplat-sort-worker.js"],
    ["unified", "gsplat-unified/gsplat-unified-sorter.js", "gsplat-unified-sort-worker.js"],
  ];
  for (const [kind, path, output] of cases) {
    const rewritten = rewritePlayCanvasSorter(
      await readFile(new URL(path, sceneRoot), "utf8"),
      kind,
    );
    assert.match(rewritten, new RegExp(`new URL\\("\\./${output.replaceAll(".", "\\.")}\", import\\.meta\\.url\\)`));
    assert.doesNotMatch(rewritten, /URL\.createObjectURL\(new Blob|eval:\s*true/);
  }
});

test("assembles self-contained static sorter worker sources", async () => {
  const workers = await staticWorkerSources();
  assert.match(workers["gsplat-sort-worker.js"], /function SortWorker\(\)/);
  assert.match(workers["gsplat-sort-worker.js"], /SortWorker\(\);\s*$/);
  assert.match(workers["gsplat-unified-sort-worker.js"], /class GSplatSortBinWeights/);
  assert.match(workers["gsplat-unified-sort-worker.js"], /function UnifiedSortWorker\(\)/);
  assert.match(workers["gsplat-unified-sort-worker.js"], /UnifiedSortWorker\(\);\s*$/);
  assert.doesNotMatch(Object.values(workers).join("\n"), /URL\.createObjectURL|new Blob/);
});
