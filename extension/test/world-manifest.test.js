import assert from "node:assert/strict";
import test from "node:test";
import { readWorldProject } from "../src/world-manifest.js";

const manifest = `
{:hara/type :project
 :hara/version "1.0.0"
 :project/id greenways.example/fern-gully
 :project/version "1.2.0"
 :project/source-paths ["src"]
 :project/test-paths ["test"]
 :project/extension-paths []
 :project/capabilities [:canvas/webgl2 :input/pointer]
 :project/world
 {:world/version "1.0.0"
  :world/title "Fern Gully"
  :world/background "#102018"
  :world/camera {:world/position [1 2 3] :world/target [0 1 0] :world/fov 55}
  :world/layers [{:world/id grove :world/asset "world/grove.sog"
                  :world/transform {:world/position [2 0 0] :world/rotation [0 90 0] :world/scale 0.5}}]
  :world/imports [{:world/id creek :world/repository "https://github.com/greenways/creek"
                   :world/ref "0123456789012345678901234567890123456789"}]}}
`;

test("reads and normalizes a world project", () => {
  const project = readWorldProject(manifest);
  assert.equal(project.id, "greenways.example/fern-gully");
  assert.equal(project.layers[0].asset, "world/grove.sog");
  assert.deepEqual(project.layers[0].transform, { position: [2, 0, 0], rotation: [0, 90, 0], scale: 0.5 });
  assert.equal(project.imports[0].transform.scale, 1);
});

test("rejects paths that leave the repository", () => {
  assert.throws(() => readWorldProject(manifest.replace("world/grove.sog", "../grove.sog")), /repository-relative|parent segments/);
});

test("requires browser capabilities", () => {
  assert.throws(() => readWorldProject(manifest.replace(":canvas/webgl2 ", "")), /canvas\/webgl2/);
});
