import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LOCK_PROTOCOL = "greenways-hestia-room-authority-lock/0-alpha";
const REPOSITORY = "greenways-ai/hestia";
const PACKAGE = "@greenways/hestia-browser";
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const ARTIFACTS = Object.freeze({
  packageManifest: "browser/package.json",
  importManifest: "browser/room-authority-import.json",
  decisionModule: "browser/src/room-authority.js",
  roomProjectionModule: "browser/src/room-authority-projections.js",
  authorityRecordModule: "browser/src/room-authority-records.js",
  sourceGrantProjectionModule: "browser/src/room-authority-source-projections.js",
  agentRoomRecordModule: "browser/src/agent-room-records.js",
  agentProtocolModule: "browser/src/agent-protocol.js",
  agentHcv1Module: "browser/src/agent-hcv1.js",
  protocolModule: "browser/src/protocol.js",
  encodingModule: "browser/src/encoding.js",
  conformanceFixture: "browser/fixtures/room-authority-conformance.json"
});

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = resolve(scriptDirectory, "..");
const lockPath = resolve(extensionDirectory, "hestia-room-authority.lock.json");
const suppliedRepository = process.argv[2];
const mode = process.argv[3] ?? "--print";

if (!suppliedRepository || !new Set(["--print", "--write", "--check"]).has(mode)) {
  throw new Error(
    "Usage: node generate-hestia-room-authority-lock.mjs <hestia-repository> "
      + "[--print|--write|--check]"
  );
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function containedPath(repositoryRoot, relativePath, name) {
  assert.equal(typeof relativePath, "string", `${name} path`);
  assert.ok(relativePath.length > 0 && !relativePath.includes("\\"), `${name} path shape`);
  const absolute = resolve(repositoryRoot, relativePath);
  assert.ok(
    absolute === repositoryRoot || absolute.startsWith(`${repositoryRoot}${sep}`),
    `${name} must remain inside the Hestia checkout`
  );
  return absolute;
}

async function canonicalContainedPath(repositoryRoot, relativePath, name) {
  const lexicalPath = containedPath(repositoryRoot, relativePath, name);
  const canonicalPath = await realpath(lexicalPath);
  assert.equal(
    canonicalPath,
    lexicalPath,
    `${name} must not resolve through a symbolic link or escaped parent`
  );
  return canonicalPath;
}

const repositoryRoot = await realpath(resolve(suppliedRepository));
const revision = execFileSync(
  "git",
  ["-C", repositoryRoot, "rev-parse", "HEAD"],
  { encoding: "utf8" }
).trim();
assert.match(revision, REVISION_PATTERN, "Hestia checkout revision");

const artifactEntries = [];
for (const [name, path] of Object.entries(ARTIFACTS)) {
  const canonicalPath = await canonicalContainedPath(repositoryRoot, path, name);
  const bytes = await readFile(canonicalPath);
  artifactEntries.push([name, { path, digest: digest(bytes) }]);
}

const lock = {
  protocol: LOCK_PROTOCOL,
  repository: REPOSITORY,
  revision,
  package: PACKAGE,
  artifacts: Object.fromEntries(artifactEntries)
};
const serialized = `${JSON.stringify(lock, null, 2)}\n`;

if (mode === "--write") {
  await writeFile(lockPath, serialized, "utf8");
} else if (mode === "--check") {
  assert.equal(await readFile(lockPath, "utf8"), serialized, "Hestia room authority lock drift");
} else {
  process.stdout.write(serialized);
}
