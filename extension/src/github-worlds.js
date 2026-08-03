import { readWorldProject, WORLD_LIMITS } from "./world-manifest.js";

export const GITHUB_ORIGINS = Object.freeze([
  "https://api.github.com/*",
  "https://raw.githubusercontent.com/*"
]);

let catalogCache;

export async function greenwaysWorldRepositories(request = fetch) {
  if (!catalogCache) {
    catalogCache = (async () => {
      const repositories = [];
      for (let page = 1; page <= 4; page += 1) {
        const response = await request(`https://api.github.com/orgs/greenways-worlds/repos?type=public&sort=updated&per_page=100&page=${page}`, {
          headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        });
        if (!response.ok) throw responseError(response, "greenways-worlds catalog");
        const batch = await response.json();
        repositories.push(...batch);
        if (batch.length < 100) break;
      }
      return repositories.map((repository) => ({
        name: repository.name,
        full_name: repository.full_name,
        description: repository.description ?? "",
        topics: repository.topics ?? [],
        html_url: repository.html_url,
        updated_at: repository.updated_at,
      }));
    })();
  }
  return catalogCache;
}

export async function searchGreenwaysWorlds(query, request = fetch, invoke) {
  const dispatch = invoke ?? (await import("./greenways-runtime.js")).invokeGreenways;
  return dispatch("catalog/search", [await greenwaysWorldRepositories(request), query]);
}

const commitPattern = /^[0-9a-f]{40}$/i;

export function parseGitHubRepository(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error("Repository must be a valid GitHub URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.search || url.hash) {
    throw new Error("Repository must be an https://github.com URL without query or fragment");
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Repository URL must have the form https://github.com/owner/repository");
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("GitHub owner or repository name is invalid");
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

export async function requestGitHubAccess(permissions = globalThis.chrome?.permissions) {
  if (!permissions) return true;
  if (await permissions.contains({ origins: [...GITHUB_ORIGINS] })) return true;
  const granted = await permissions.request({ origins: [...GITHUB_ORIGINS] });
  if (!granted) throw new Error("GitHub access was not granted");
  return true;
}

function encodePath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function rawGitHubUrl(repository, commit, path) {
  return `https://raw.githubusercontent.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/${commit}/${encodePath(path)}`;
}

function responseError(response, label) {
  const remaining = response.headers?.get?.("x-ratelimit-remaining");
  const suffix = response.status === 403 && remaining === "0" ? " (GitHub API rate limit reached)" : "";
  return new Error(`${label} failed: ${response.status}${suffix}`);
}

export class PublicGitHubClient {
  constructor({ request = fetch } = {}) {
    this.request = request;
    this.refCache = new Map();
    this.manifestCache = new Map();
  }

  async json(url, label) {
    const response = await this.request(url, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }
    });
    if (!response.ok) throw responseError(response, label);
    return response.json();
  }

  async text(url, label) {
    const response = await this.request(url);
    if (!response.ok) throw responseError(response, label);
    return response.text();
  }

  async defaultBranch(repository) {
    const metadata = await this.json(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
      `${repository.owner}/${repository.repo} metadata`
    );
    if (!metadata.default_branch) throw new Error(`${repository.owner}/${repository.repo} has no default branch`);
    return metadata.default_branch;
  }

  async resolveCommit(repository, ref) {
    const requestedRef = ref || await this.defaultBranch(repository);
    if (commitPattern.test(requestedRef)) return requestedRef.toLowerCase();
    const key = `${repository.owner}/${repository.repo}@${requestedRef}`;
    if (!this.refCache.has(key)) {
      this.refCache.set(key, this.json(
        `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/commits/${encodeURIComponent(requestedRef)}`,
        `${key} resolution`
      ).then((commit) => {
        if (!commitPattern.test(commit.sha ?? "")) throw new Error(`${key} did not resolve to a commit`);
        return commit.sha.toLowerCase();
      }));
    }
    return this.refCache.get(key);
  }

  async project(repository, commit) {
    const key = `${repository.owner}/${repository.repo}@${commit}`;
    if (!this.manifestCache.has(key)) {
      this.manifestCache.set(key, this.text(rawGitHubUrl(repository, commit, "project.edn"), `${key}/project.edn`)
        .then(readWorldProject));
    }
    return this.manifestCache.get(key);
  }
}

function safeStreamPath(value) {
  if (typeof value !== "string") return;
  const looksLikeResource = /\.(?:sog|webp|json)(?:$|[?#])/i.test(value);
  if (!looksLikeResource) return;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/") || value.includes("\\") || value.includes("?") || value.includes("#")) {
    throw new Error(`streamed SOG contains an external or absolute resource: ${value}`);
  }
  if (value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`streamed SOG resource escapes its directory: ${value}`);
  }
}

function inspectStreamValue(value) {
  if (typeof value === "string") return safeStreamPath(value);
  if (Array.isArray(value)) return value.forEach(inspectStreamValue);
  if (value && typeof value === "object") Object.values(value).forEach(inspectStreamValue);
}

export async function validateStreamMetadata(url, request = fetch) {
  const response = await request(url);
  if (!response.ok) throw responseError(response, `${url} metadata`);
  let metadata;
  try {
    metadata = await response.json();
  } catch (error) {
    throw new Error(`streamed SOG metadata is not valid JSON: ${error.message}`);
  }
  inspectStreamValue(metadata);
  return metadata;
}

function diagnostic(path, error) {
  return { path: path.join(" → "), message: error instanceof Error ? error.message : String(error) };
}

export async function resolveWorldGraph({ repository, ref = "", mode = "dev", client = new PublicGitHubClient() }) {
  if (!['dev', 'strict'].includes(mode)) throw new Error("Viewer mode must be dev or strict");
  const rootRepository = typeof repository === "string" ? parseGitHubRepository(repository) : repository;
  if (mode === "strict" && !commitPattern.test(ref)) {
    throw new Error("Strict mode requires the root ref to be a full 40-character commit SHA");
  }
  const rootCommit = await client.resolveCommit(rootRepository, ref);
  const diagnostics = [];
  const layers = [];
  const projects = new Set();

  async function visit(source, commit, transformChain, ancestry, displayPath, depth) {
    const identity = `${source.owner}/${source.repo}@${commit}`;
    if (depth > WORLD_LIMITS.importDepth) {
      diagnostics.push(diagnostic(displayPath, new Error(`import depth exceeds ${WORLD_LIMITS.importDepth}`)));
      return null;
    }
    if (ancestry.includes(identity)) {
      diagnostics.push(diagnostic(displayPath, new Error(`world import cycle detected at ${identity}`)));
      return null;
    }
    if (!projects.has(identity) && projects.size >= WORLD_LIMITS.projects) {
      diagnostics.push(diagnostic(displayPath, new Error(`world graph exceeds ${WORLD_LIMITS.projects} projects`)));
      return null;
    }
    projects.add(identity);

    let project;
    try {
      project = await client.project(source, commit);
    } catch (error) {
      diagnostics.push(diagnostic(displayPath, error));
      return null;
    }

    for (const layer of project.layers) {
      if (layers.length >= WORLD_LIMITS.layers) {
        diagnostics.push(diagnostic(displayPath, new Error(`world graph exceeds ${WORLD_LIMITS.layers} layers`)));
        break;
      }
      const assetUrl = rawGitHubUrl(source, commit, layer.asset);
      if (layer.asset.endsWith("lod-meta.json")) {
        try {
          await validateStreamMetadata(assetUrl, client.request);
        } catch (error) {
          diagnostics.push(diagnostic([...displayPath, layer.id], error));
          continue;
        }
      }
      layers.push({
        id: [...displayPath, layer.id].join("/"),
        asset: layer.asset,
        assetUrl,
        source: { ...source, commit },
        transformChain: [...transformChain, layer.transform]
      });
    }

    await Promise.all(project.imports.map(async (entry) => {
      const childPath = [...displayPath, entry.id];
      let childRepository;
      try {
        childRepository = parseGitHubRepository(entry.repository);
        if (mode === "strict" && !commitPattern.test(entry.ref)) {
          throw new Error("Strict mode requires imported worlds to use a full commit SHA");
        }
        const childCommit = await client.resolveCommit(childRepository, entry.ref);
        await visit(
          childRepository, childCommit, [...transformChain, entry.transform],
          [...ancestry, identity], childPath, depth + 1
        );
      } catch (error) {
        diagnostics.push(diagnostic(childPath, error));
      }
    }));
    return project;
  }

  const rootPath = [`${rootRepository.owner}/${rootRepository.repo}`];
  const rootProject = await visit(rootRepository, rootCommit, [], [], rootPath, 0);
  if (!rootProject) throw new Error(diagnostics[0]?.message ?? "Root world could not be loaded");
  return {
    repository: rootRepository,
    commit: rootCommit,
    project: rootProject,
    layers,
    diagnostics,
    complete: diagnostics.length === 0
  };
}
