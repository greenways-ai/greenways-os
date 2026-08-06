import { parseEDNString } from "edn-data";
import {
  PublicGitHubClient,
  parseGitHubRepository,
  rawGitHubUrl,
} from "./github-worlds.js";
import {
  loadLockedPackageBundle,
  lockedPackageAppEntry,
} from "./hara-packages.js";
import { validateAppManifest } from "./app-catalog.js";

const COMMIT_SHA = /^[a-f0-9]{40}$/i;
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;
const ednOptions = {
  mapAs: "object", setAs: "array", listAs: "array",
  keywordAs: "string", charAs: "string", objectKeysAs: "string",
};

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!keys.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  return input;
}

function safePath(value, label) {
  if (typeof value !== "string" || !value || !SAFE_PATH.test(value)
      || value.startsWith("/") || value.includes("\\")
      || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  return value;
}

function repositoryDescriptor(value) {
  if (typeof value === "string") {
    if (value.startsWith("https://")) return parseGitHubRepository(value);
    const [owner, repo, extra] = value.split("/");
    if (!owner || !repo || extra) throw new Error("Preview repository must be owner/repository");
    return parseGitHubRepository(`https://github.com/${owner}/${repo}`);
  }
  const input = plainObject(value, "Preview repository");
  return parseGitHubRepository(`https://github.com/${input.owner}/${input.repo}`);
}

function publisher(value) {
  const input = exactKeys(
    value,
    new Set(["publisher/id", "publisher/name"]),
    "Preview app publisher",
  );
  return {
    id: input["publisher/id"],
    name: input["publisher/name"],
  };
}

export function parsePreviewAppDescriptor(source, { repository, sha, lockDigest }) {
  const input = exactKeys(
    parseEDNString(String(source), ednOptions),
    new Set([
      "app/protocol", "app/id", "app/version", "app/publisher",
      "app/name", "app/description", "app/category", "app/capabilities",
    ]),
    "greenways.app.edn",
  );
  return validateAppManifest({
    protocol: input["app/protocol"],
    id: input["app/id"],
    version: input["app/version"],
    publisher: publisher(input["app/publisher"]),
    name: input["app/name"],
    description: input["app/description"],
    category: input["app/category"],
    capabilities: input["app/capabilities"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "preview",
    lockDigest,
    source: {
      kind: "github",
      owner: repository.owner,
      repo: repository.repo,
      sha,
    },
  });
}

function previewArchiveResolver(repository, sha) {
  return (lockedPath) => {
    const path = safePath(lockedPath, "Preview package archive path");
    return rawGitHubUrl(repository, sha, path);
  };
}

export async function resolvePreviewModule({
  repository,
  ref = "",
  mode = "strict",
  appPath = "greenways.app.edn",
  lockPath = "project.lock.edn",
  client = new PublicGitHubClient(),
} = {}) {
  if (mode !== "strict" && mode !== "dev") throw new Error("Preview mode must be strict or dev");
  const sourceRepository = repositoryDescriptor(repository);
  if (mode === "strict" && !COMMIT_SHA.test(ref)) {
    throw new Error("Strict preview mode requires a full 40-character commit SHA");
  }
  const sha = await client.resolveCommit(sourceRepository, ref);
  if (!COMMIT_SHA.test(sha)) throw new Error("Preview ref did not resolve to a full commit SHA");
  const pinnedSha = sha.toLowerCase();
  const [appSource, lockSource] = await Promise.all([
    client.text(
      rawGitHubUrl(sourceRepository, pinnedSha, safePath(appPath, "Preview app manifest path")),
      `${sourceRepository.owner}/${sourceRepository.repo}@${pinnedSha}/${appPath}`,
    ),
    client.text(
      rawGitHubUrl(sourceRepository, pinnedSha, safePath(lockPath, "Preview lock path")),
      `${sourceRepository.owner}/${sourceRepository.repo}@${pinnedSha}/${lockPath}`,
    ),
  ]);
  const bundle = await loadLockedPackageBundle(lockSource, client.request, {
    resolvePackageUrl: previewArchiveResolver(sourceRepository, pinnedSha),
  });
  const manifest = parsePreviewAppDescriptor(appSource, {
    repository: sourceRepository,
    sha: pinnedSha,
    lockDigest: bundle.lockDigest,
  });
  const entry = lockedPackageAppEntry(bundle);
  return Object.freeze({
    mode,
    requestedRef: ref,
    resolvedSha: pinnedSha,
    repository: sourceRepository,
    manifest,
    bundle,
    staged: Object.freeze({
      id: manifest.id,
      lockDigest: bundle.lockDigest,
      entry,
      resources: bundle.resources,
    }),
  });
}
