import assert from "node:assert/strict";
import test from "node:test";
import { parseGitHubRepository, rawGitHubUrl, resolveWorldGraph, searchGreenwaysWorlds } from "../src/github-worlds.js";

const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
const rootRepo = parseGitHubRepository("https://github.com/greenways/root.git");
const rootSha = "a".repeat(40);
const childSha = "b".repeat(40);

test("accepts only canonical public GitHub repository URLs", () => {
  assert.deepEqual(rootRepo, { owner: "greenways", repo: "root", url: "https://github.com/greenways/root" });
  assert.throws(() => parseGitHubRepository("https://github.com/greenways/root/tree/main"), /form/);
  assert.throws(() => parseGitHubRepository("git@github.com:greenways/root.git"), /valid GitHub URL/);
});

test("builds raw asset URLs at immutable commits", () => {
  assert.equal(rawGitHubUrl(rootRepo, rootSha, "world/tree one.sog"), `https://raw.githubusercontent.com/greenways/root/${rootSha}/world/tree%20one.sog`);
});

test("delegates greenways-worlds catalog filtering to the HAL action", async () => {
  const request = async () => ({
    ok: true,
    json: async () => [{ name: "splat-garden", full_name: "greenways-worlds/splat-garden", html_url: "https://github.com/greenways-worlds/splat-garden" }],
  });
  const invoke = (method, args) => {
    assert.equal(method, "catalog/search");
    assert.equal(args[1], "garden");
    return args[0];
  };
  const results = await searchGreenwaysWorlds("garden", request, invoke);
  assert.equal(results[0].name, "splat-garden");
});

test("resolves recursive worlds and composes layer and touchpoint transforms", async () => {
  const childRepo = parseGitHubRepository("https://github.com/greenways/child");
  const projects = new Map([
    [`greenways/root@${rootSha}`, {
      background: "#000000", camera: null, layers: [{ id: "root", asset: "root.sog", transform }], touchpoints: [],
      imports: [{ id: "child", repository: childRepo.url, ref: childSha, transform: { ...transform, position: [5, 0, 0] } }],
    }],
    [`greenways/child@${childSha}`, {
      background: "#ffffff", camera: { position: [0, 0, 1], target: [0, 0, 0], fov: 60 },
      layers: [{ id: "tree", asset: "tree.sog", transform: { ...transform, scale: 2 } }],
      touchpoints: [{
        id: "console", label: "Open studio", description: "", surface: "studio", presentation: "panel",
        transform: { ...transform, position: [0, 1, -2] },
      }],
      imports: [],
    }],
  ]);
  const client = {
    request: async () => { throw new Error("not used"); },
    resolveCommit: async (_repo, ref) => ref || rootSha,
    project: async (repo, sha) => projects.get(`${repo.owner}/${repo.repo}@${sha}`),
  };
  const graph = await resolveWorldGraph({ repository: rootRepo, ref: rootSha, mode: "strict", client });
  assert.equal(graph.layers.length, 2);
  assert.deepEqual(graph.layers[1].transformChain.map(({ position, scale }) => ({ position, scale })), [
    { position: [5, 0, 0], scale: 1 }, { position: [0, 0, 0], scale: 2 },
  ]);
  assert.equal(graph.touchpoints.length, 1);
  assert.equal(graph.touchpoints[0].id, "greenways/root/child/console");
  assert.deepEqual(graph.touchpoints[0].transformChain.map(({ position }) => position), [[5, 0, 0], [0, 1, -2]]);
  assert.equal(graph.project.background, "#000000");
});

test("strict mode rejects movable refs before fetching", async () => {
  await assert.rejects(resolveWorldGraph({ repository: rootRepo, ref: "main", mode: "strict" }), /40-character commit/);
});

test("keeps the root world when an import fails", async () => {
  const client = {
    request: async () => { throw new Error("not used"); },
    resolveCommit: async (_repo, ref) => ref || rootSha,
    project: async (repo) => repo.repo === "root" ? {
      background: "#000000", camera: null, layers: [{ id: "root", asset: "root.sog", transform }], touchpoints: [],
      imports: [{ id: "missing", repository: "https://github.com/greenways/missing", ref: childSha, transform }],
    } : Promise.reject(new Error("not found")),
  };
  const graph = await resolveWorldGraph({ repository: rootRepo, ref: rootSha, mode: "dev", client });
  assert.equal(graph.layers.length, 1);
  assert.equal(graph.complete, false);
  assert.match(graph.diagnostics[0].message, /not found/);
});
