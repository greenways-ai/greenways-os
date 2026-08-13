import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LOCK_PROTOCOL = "greenways-hestia-room-authority-lock/0-alpha";
const IMPORT_PROTOCOL = "hestia-room-authority-import/0-alpha";
const CONFORMANCE_PROTOCOL = "hestia-room-authority-conformance/0-alpha";
const DECISION_PROTOCOL = "hestia-room-authority-decision/0-alpha";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const LOCK_FIELDS = [
  "protocol",
  "repository",
  "revision",
  "package",
  "importManifest",
  "module",
  "fixture",
  "digests"
];
const DIGEST_FIELDS = ["importManifest", "module", "fixture"];
const IMPORT_FIELDS = [
  "protocol",
  "ownerRepository",
  "package",
  "export",
  "authorityDecisionProtocol",
  "conformanceProtocol",
  "conformanceFixture",
  "canonicalAuthority",
  "consumerBoundary"
];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionDirectory = resolve(scriptDirectory, "..");
const lockPath = resolve(extensionDirectory, "hestia-room-authority.lock.json");
const suppliedRepository = process.argv[2];

if (!suppliedRepository) {
  throw new Error(
    "Usage: node verify-hestia-room-authority-import.mjs <hestia-repository>"
  );
}

function assertClosedObject(value, name, expectedFields) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${name} object`);
  assert.deepEqual(Object.keys(value).sort(), [...expectedFields].sort(), `${name} fields`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, override) {
  if (override === undefined) return clone(base);
  if (Array.isArray(base) || Array.isArray(override)
      || base === null || override === null
      || typeof base !== "object" || typeof override !== "object") {
    return clone(override);
  }
  const result = clone(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : clone(value);
  }
  return result;
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

const lock = JSON.parse(await readFile(lockPath, "utf8"));
assertClosedObject(lock, "lock", LOCK_FIELDS);
assert.equal(lock.protocol, LOCK_PROTOCOL);
assert.equal(lock.repository, "greenways-ai/hestia");
assert.equal(lock.package, "@greenways/hestia-browser");
assert.match(lock.revision, REVISION_PATTERN);
assertClosedObject(lock.digests, "lock.digests", DIGEST_FIELDS);
for (const value of Object.values(lock.digests)) assert.match(value, SHA256_PATTERN);

const repositoryRoot = await realpath(resolve(suppliedRepository));
if (process.env.GREENWAYS_SKIP_HESTIA_REVISION !== "1") {
  const revision = execFileSync(
    "git",
    ["-C", repositoryRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" }
  ).trim();
  assert.equal(revision, lock.revision, "Hestia checkout revision");
}

const manifestPath = containedPath(repositoryRoot, lock.importManifest, "manifest");
const modulePath = containedPath(repositoryRoot, lock.module, "module");
const fixturePath = containedPath(repositoryRoot, lock.fixture, "fixture");
const [manifestBytes, moduleBytes, fixtureBytes] = await Promise.all([
  readFile(manifestPath),
  readFile(modulePath),
  readFile(fixturePath)
]);
assert.equal(digest(manifestBytes), lock.digests.importManifest, "manifest digest");
assert.equal(digest(moduleBytes), lock.digests.module, "module digest");
assert.equal(digest(fixtureBytes), lock.digests.fixture, "fixture digest");

const manifest = JSON.parse(manifestBytes.toString("utf8"));
assertClosedObject(manifest, "import manifest", IMPORT_FIELDS);
assert.equal(manifest.protocol, IMPORT_PROTOCOL);
assert.equal(manifest.ownerRepository, lock.repository);
assert.equal(manifest.package, lock.package);
assert.equal(manifest.export, "./room-authority");
assert.equal(manifest.authorityDecisionProtocol, DECISION_PROTOCOL);
assert.equal(manifest.conformanceProtocol, CONFORMANCE_PROTOCOL);
assert.equal(
  resolve(dirname(manifestPath), manifest.conformanceFixture),
  fixturePath,
  "manifest fixture path"
);

const fixture = JSON.parse(fixtureBytes.toString("utf8"));
assert.equal(fixture.protocol, CONFORMANCE_PROTOCOL);
assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, "conformance cases");

const moduleUrl = new URL(pathToFileURL(modulePath));
moduleUrl.searchParams.set("digest", lock.digests.module.slice(7));
const authority = await import(moduleUrl.href);
assert.equal(authority.ROOM_AUTHORITY_DECISION_PROTOCOL, DECISION_PROTOCOL);
assert.equal(authority.ROOM_AUTHORITY_CONFORMANCE_PROTOCOL, CONFORMANCE_PROTOCOL);
assert.equal(typeof authority.authorizeRoomInvocation, "function");

for (const entry of fixture.cases) {
  const overrides = entry.overrides ?? {};
  const decision = authority.authorizeRoomInvocation({
    room: deepMerge(fixture.base.room, overrides.room ?? {}),
    membership: deepMerge(fixture.base.membership, overrides.membership ?? {}),
    sourceMandate: deepMerge(
      fixture.base.sourceMandate,
      overrides.sourceMandate ?? {}
    ),
    grant: deepMerge(fixture.base.grant, overrides.grant ?? {}),
    invocation: deepMerge(fixture.base.invocation, overrides.invocation ?? {}),
    observedAt: overrides.observedAt ?? fixture.observedAt
  });
  assert.equal(decision.protocol, DECISION_PROTOCOL, entry.name);
  assert.equal(decision.allowed, entry.expected.allowed, entry.name);
  assert.equal(decision.reason, entry.expected.reason, entry.name);
  assert.equal(
    decision.requiresUserInteraction,
    entry.expected.requiresUserInteraction,
    entry.name
  );
}

console.log(
  `Verified ${fixture.cases.length} Hestia room-authority cases at ${lock.revision}.`
);
