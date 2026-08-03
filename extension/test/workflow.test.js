import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acceptIdeaArrangement,
  acceptProposal,
  addIdea,
  addArtifact,
  addRepositoryMap,
  classifyArtifact,
  createPublicationCheckpoint,
  createProject,
  moveIdea,
  proposeIdeaArrangement,
  readiness,
  runReleaseSteward,
  updateArtifactDescription,
  workflowRoot
} from "../src/workflow.js";

const owner = { identityId: "identity/alice" };

test("reference workflow has a stable policy root", async () => {
  const left = await workflowRoot();
  const right = await workflowRoot();
  assert.match(left, /^sha256:[0-9a-f]{64}$/);
  assert.equal(left, right);
});

test("artifacts are classified for the mixed-media release", () => {
  assert.equal(classifyArtifact({ name: "master.wav", type: "audio/wav" }), "audio");
  assert.equal(classifyArtifact({ name: "cover.png", type: "image/png" }), "artwork");
  assert.equal(classifyArtifact({ name: "notes.md", type: "text/markdown" }), "text");
});

test("ideas stay artist-arranged until an AI layout proposal is accepted", () => {
  let project = createProject("Night Garden", owner);
  project = addIdea(project, { title: "Moonlit opening", body: "quiet blue scene" });
  project = addIdea(project, { title: "Dawn chorus", body: "birds answer the synth" });
  const firstPosition = project.ideas[0].position;
  project = moveIdea(project, project.ideas[0].id, { x: 8, z: 12 });
  assert.notDeepEqual(project.ideas[0].position, firstPosition);
  project = proposeIdeaArrangement(project, "make a journey from night to morning");
  assert.equal(project.ideaLayoutProposal.status, "proposed");
  const beforeAccept = project.ideas.map((idea) => idea.position);
  project = acceptIdeaArrangement(project);
  assert.equal(project.ideaLayoutProposal.status, "accepted");
  assert.notDeepEqual(project.ideas.map((idea) => idea.position), beforeAccept);
});

test("a local repository becomes a spatial folder map without file contents", () => {
  const project = addRepositoryMap(createProject("Home", owner), [
    { webkitRelativePath: "greenways-os/extension/src/app.js" },
    { webkitRelativePath: "greenways-os/extension/src/styles.css" },
    { webkitRelativePath: "greenways-os/protocol/README.md" },
    { webkitRelativePath: "greenways-os/package.json" }
  ]);
  const repository = project.repositories[0];
  assert.equal(repository.name, "greenways-os");
  assert.equal(repository.fileCount, 4);
  assert.deepEqual(repository.nodes.map(({ label, count }) => [label, count]), [["extension", 2], ["protocol", 1], ["root", 1]]);
  assert.equal(JSON.stringify(repository).includes("file contents"), false);
});

test("release steward returns typed checks and artist-controlled proposals", async () => {
  let project = createProject("Night Garden", owner);
  project = addArtifact(project, {
    id: "artifact/cover", root: "sha256:cover", name: "cover.png", kind: "artwork",
    size: 100, mediaType: "image/png", contributor: owner.identityId, claimActionRoot: "sha256:claim"
  });
  project = await runReleaseSteward(project);
  assert.equal(project.results.length, 5);
  assert.ok(project.results.every((result) => result.class === "verified-check"));
  assert.equal(readiness(project).attention, 1);
  assert.equal(project.proposals.length, 1);
  const accepted = acceptProposal(project, project.proposals[0].id);
  assert.equal(accepted.proposals[0].status, "accepted");
});

test("complete descriptions produce a ready result matrix", async () => {
  let project = createProject("Night Garden", owner);
  project = addArtifact(project, {
    id: "artifact/cover", root: "sha256:cover", name: "cover.png", kind: "artwork",
    size: 100, mediaType: "image/png", description: "Blue flowers beneath a moon.",
    contributor: owner.identityId, claimActionRoot: "sha256:claim"
  });
  project = await runReleaseSteward(project);
  assert.deepEqual(readiness(project), { state: "ready", passed: 5, attention: 0 });
  const checkpoint = createPublicationCheckpoint(project, await workflowRoot());
  assert.equal(checkpoint.artifacts[0].root, "sha256:cover");
  assert.equal(checkpoint.qualityResults.length, 5);
});

test("publishing is blocked until the workflow attention items are resolved", async () => {
  let project = createProject("Night Garden", owner);
  project = addArtifact(project, {
    id: "artifact/cover", root: "sha256:cover", name: "cover.png", kind: "artwork",
    size: 100, mediaType: "image/png", contributor: owner.identityId, claimActionRoot: "sha256:claim"
  });
  project = await runReleaseSteward(project);
  assert.throws(() => createPublicationCheckpoint(project, "sha256:policy"), /attention items/);
  project = updateArtifactDescription(project, "artifact/cover", "Blue flowers beneath a moon.");
  project = await runReleaseSteward(project);
  assert.equal(createPublicationCheckpoint(project, "sha256:policy").workloadId, project.id);
});
