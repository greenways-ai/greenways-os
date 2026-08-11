import { canonical, sha256, randomId } from "./protocol.js";

export const RELEASE_WORKFLOW = Object.freeze({
  id: "greenways.release-steward",
  version: "0.1.0",
  states: ["draft", "review", "ready", "published"],
  capabilities: {
    steward: ["artifact/read-selected", "metadata/read", "proposal/create"],
    artist: ["artifact/add", "proposal/accept", "checkpoint/sign", "publish"]
  },
  publication: { role: "artist", minimumAcceptedArtifacts: 1 }
});

export async function workflowRoot(policy = RELEASE_WORKFLOW) {
  return sha256(canonical(policy));
}

export function createProject(title, owner) {
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) throw new Error("Project title is required");
  return {
    id: randomId("workload"),
    title: cleanTitle,
    workflow: `${RELEASE_WORKFLOW.id}/${RELEASE_WORKFLOW.version}`,
    owner: owner.identityId,
    state: "draft",
    artifacts: [],
    ideas: [],
    repositories: [],
    friends: [],
    furnishingParents: [],
    personalFurnishings: [],
    ideaLayoutProposal: null,
    proposals: [],
    results: [],
    createdAt: new Date().toISOString()
  };
}

export function addRepositoryMap(project, files) {
  const entries = [...files].map((file) => String(file.webkitRelativePath || file.name)).filter(Boolean);
  if (!entries.length) throw new Error("Choose a repository folder");
  const name = entries[0].split("/")[0];
  const directories = new Map();
  for (const entry of entries) {
    const parts = entry.split("/").slice(1);
    const top = parts.length > 1 ? parts[0] : "root";
    directories.set(top, (directories.get(top) ?? 0) + 1);
  }
  const nodes = [...directories.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, count], index) => ({
    id: randomId("repo-node"), label, count,
    position: { x: 16 + (index % 5) * 17, y: 24 + Math.floor(index / 5) * 24, z: (index % 3 - 1) * 22 }
  }));
  const repository = { id: randomId("repository"), name, fileCount: entries.length, nodes, mappedAt: new Date().toISOString() };
  return { ...project, repositories: [...(project.repositories ?? []).filter((repo) => repo.name !== name), repository] };
}

const clamp = (value) => Math.max(4, Math.min(96, Number(value)));

export function addIdea(project, { title, body = "", color = "fern" }) {
  const cleanTitle = String(title ?? "").trim();
  if (!cleanTitle) throw new Error("Idea title is required");
  const index = project.ideas?.length ?? 0;
  const idea = {
    id: randomId("idea"), title: cleanTitle, body: String(body ?? "").trim(), color,
    position: { x: 18 + (index % 4) * 20, y: 24 + (index % 3) * 17, z: index % 2 ? 18 : -12 },
    createdAt: new Date().toISOString()
  };
  return { ...project, ideas: [...(project.ideas ?? []), idea], ideaLayoutProposal: null };
}

export function moveIdea(project, ideaId, delta) {
  if (!(project.ideas ?? []).some((idea) => idea.id === ideaId)) throw new Error("Unknown idea");
  return { ...project, ideas: project.ideas.map((idea) => idea.id === ideaId ? {
    ...idea,
    position: {
      x: clamp(idea.position.x + (delta.x ?? 0)),
      y: clamp(idea.position.y + (delta.y ?? 0)),
      z: Math.max(-80, Math.min(80, idea.position.z + (delta.z ?? 0)))
    }
  } : idea), ideaLayoutProposal: null };
}

export function proposeIdeaArrangement(project, intent = "group related ideas") {
  const ideas = project.ideas ?? [];
  if (ideas.length < 2) throw new Error("Add at least two ideas before asking the arranger");
  const sorted = [...ideas].sort((a, b) => `${a.title} ${a.body}`.localeCompare(`${b.title} ${b.body}`));
  const positions = Object.fromEntries(sorted.map((idea, index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    return [idea.id, { x: 22 + column * 28, y: 25 + row * 22, z: column === 1 ? 28 : -8 }];
  }));
  return { ...project, ideaLayoutProposal: {
    id: randomId("layout-proposal"), actor: "agent/greenways/idea-arranger-1",
    intent: String(intent ?? "").trim() || "group related ideas",
    summary: `Arrange ${ideas.length} ideas into a readable spatial sequence.`,
    positions, status: "proposed",
    limitations: ["This local arranger uses titles and notes only; it does not judge artistic value."]
  } };
}

export function acceptIdeaArrangement(project) {
  const proposal = project.ideaLayoutProposal;
  if (!proposal || proposal.status !== "proposed") throw new Error("No arrangement is awaiting acceptance");
  return {
    ...project,
    ideas: project.ideas.map((idea) => ({ ...idea, position: proposal.positions[idea.id] ?? idea.position })),
    ideaLayoutProposal: { ...proposal, status: "accepted" }
  };
}

export function classifyArtifact(file) {
  const type = String(file.type ?? "");
  const name = String(file.name ?? "").toLowerCase();
  if (type.startsWith("audio/") || /\.(wav|mp3|flac|aiff|m4a)$/.test(name)) return "audio";
  if (type.startsWith("image/") || /\.(png|jpe?g|webp|tiff?|svg)$/.test(name)) return "artwork";
  if (type.startsWith("video/") || /\.(mp4|mov|webm)$/.test(name)) return "video";
  if (type.startsWith("text/") || /\.(md|txt|csv|json)$/.test(name)) return "text";
  return "other";
}

export function addArtifact(project, artifact) {
  if (!artifact.id || !artifact.root || !artifact.name) throw new Error("Artifact identity is incomplete");
  if (project.artifacts.some((item) => item.root === artifact.root)) return project;
  return { ...project, artifacts: [...project.artifacts, artifact] };
}

const result = (service, subject, status, summary, evidence, extra = {}) => ({
  id: randomId("quality"),
  service,
  class: "verified-check",
  subject,
  status,
  summary,
  evidence,
  limitations: [],
  ...extra
});

export async function runReleaseSteward(project) {
  const results = [];
  const proposals = [];
  const artifacts = project.artifacts;
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));

  results.push(result(
    "credits-and-contributions", project.id,
    artifacts.length > 0 && artifacts.every((artifact) => artifact.contributor) ? "passed" : "attention",
    artifacts.length === 0 ? "Add the first contribution."
      : artifacts.every((artifact) => artifact.contributor) ? "Every artifact has a contributor claim."
        : "One or more artifacts need a contributor claim.",
    artifacts.map((artifact) => artifact.root)
  ));

  for (const artifact of artifacts) {
    const known = artifact.size > 0 && artifact.mediaType;
    results.push(result(
      `${artifact.kind}-delivery`, artifact.root, known ? "passed" : "attention",
      known ? `${artifact.name} has a digest, media type, and byte size.` : `${artifact.name} needs delivery metadata.`,
      [artifact.root],
      { limitations: ["This v0.1 check validates delivery metadata, not artistic merit or codec internals."] }
    ));
  }

  const accessibilityReady = artifacts.every((artifact) =>
    !["artwork", "video"].includes(artifact.kind) || artifact.description?.trim()
  );
  results.push(result(
    "accessibility", project.id, accessibilityReady ? "passed" : "attention",
    accessibilityReady ? "Visual contributions include descriptions."
      : "Add a description for visual work before packaging.",
    artifacts.map((artifact) => artifact.root)
  ));
  if (!accessibilityReady) {
    proposals.push({
      id: randomId("proposal"),
      service: "accessibility",
      action: "request-descriptions",
      summary: "Ask contributors to add descriptions to visual work.",
      status: "proposed"
    });
  }

  results.push(result(
    "provenance", project.id,
    artifacts.every((artifact) => artifact.root && artifact.claimActionRoot) ? "passed" : "attention",
    artifacts.every((artifact) => artifact.root && artifact.claimActionRoot)
      ? "Every contribution is connected to a signed claim."
      : "A contribution is missing its signed claim.",
    artifacts.map((artifact) => artifact.claimActionRoot).filter(Boolean)
  ));

  results.push(result(
    "release-package", project.id,
    artifacts.length > 0 && kinds.size > 0 ? "passed" : "attention",
    artifacts.length > 0 ? `${artifacts.length} immutable artifact version(s) are ready to bundle.`
      : "The release package is empty.",
    artifacts.map((artifact) => artifact.root)
  ));

  return { ...project, state: "review", results, proposals, stewardRanAt: new Date().toISOString() };
}

export function acceptProposal(project, proposalId) {
  if (!project.proposals.some((proposal) => proposal.id === proposalId)) throw new Error("Unknown proposal");
  return {
    ...project,
    proposals: project.proposals.map((proposal) =>
      proposal.id === proposalId ? { ...proposal, status: "accepted" } : proposal
    )
  };
}

export function readiness(project) {
  if (!project.results.length) return { state: "unchecked", passed: 0, attention: 0 };
  const passed = project.results.filter((item) => item.status === "passed").length;
  const attention = project.results.length - passed;
  return { state: attention === 0 ? "ready" : "review", passed, attention };
}

export function updateArtifactDescription(project, artifactId, description) {
  if (!project.artifacts.some((artifact) => artifact.id === artifactId)) throw new Error("Unknown artifact");
  return {
    ...project,
    artifacts: project.artifacts.map((artifact) =>
      artifact.id === artifactId ? { ...artifact, description: String(description ?? "").trim() } : artifact
    ),
    results: [],
    proposals: []
  };
}

export function createPublicationCheckpoint(project, policyRoot) {
  const status = readiness(project);
  if (project.artifacts.length < RELEASE_WORKFLOW.publication.minimumAcceptedArtifacts) {
    throw new Error("The workflow requires at least one accepted artifact");
  }
  if (status.state !== "ready") throw new Error("Resolve the Release Steward attention items before publishing");
  return {
    protocol: "greenways-release-checkpoint/0-alpha",
    id: randomId("checkpoint"),
    workloadId: project.id,
    workflowRoot: policyRoot,
    artifacts: project.artifacts.map((artifact) => ({
      id: artifact.id,
      root: artifact.root,
      claimActionRoot: artifact.claimActionRoot,
      mediaType: artifact.mediaType
    })),
    qualityResults: project.results.map((quality) => ({
      id: quality.id,
      service: quality.service,
      class: quality.class,
      status: quality.status
    })),
    createdAt: new Date().toISOString()
  };
}
