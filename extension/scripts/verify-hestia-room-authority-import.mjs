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
const INVOCATION_PROTOCOL = "hestia-room-invocation/0-alpha";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const LOCK_FIELDS = [
  "protocol",
  "repository",
  "revision",
  "package",
  "artifacts"
];
const ARTIFACT_FIELDS = ["path", "digest"];
const ARTIFACT_NAMES = [
  "packageManifest",
  "importManifest",
  "decisionModule",
  "roomProjectionModule",
  "authorityRecordModule",
  "sourceGrantProjectionModule",
  "agentRoomRecordModule",
  "agentProtocolModule",
  "agentHcv1Module",
  "protocolModule",
  "encodingModule",
  "conformanceFixture"
];
const IMPORT_FIELDS = [
  "protocol",
  "ownerRepository",
  "package",
  "export",
  "projectionExport",
  "authorityRecordExport",
  "sourceGrantProjectionExport",
  "authorityDecisionProtocol",
  "conformanceProtocol",
  "conformanceFixture",
  "canonicalAuthority",
  "consumerBoundary"
];
const REQUIRED_PACKAGE_EXPORTS = Object.freeze({
  "./room-authority": "decisionModule",
  "./room-authority-projections": "roomProjectionModule",
  "./room-authority-records": "authorityRecordModule",
  "./room-authority-source-projections": "sourceGrantProjectionModule",
  "./agent-room-records": "agentRoomRecordModule",
  "./agent-protocol": "agentProtocolModule",
  "./agent-hcv1": "agentHcv1Module",
  "./protocol": "protocolModule"
});

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

function applicationIdentity() {
  return Object.freeze({
    appId: "greenways.chat",
    version: "0.1.0",
    publisherId: "greenways-ai",
    manifestDigest: `sha256:${"1".repeat(64)}`,
    lockDigest: `sha256:${"2".repeat(64)}`,
    approvalDigest: `sha256:${"3".repeat(64)}`
  });
}

async function importArtifact(lock, artifactPaths, name) {
  const url = pathToFileURL(artifactPaths[name]);
  url.searchParams.set("digest", lock.artifacts[name].digest.slice(7));
  return import(url.href);
}

const lock = JSON.parse(await readFile(lockPath, "utf8"));
assertClosedObject(lock, "lock", LOCK_FIELDS);
assert.equal(lock.protocol, LOCK_PROTOCOL);
assert.equal(lock.repository, "greenways-ai/hestia");
assert.equal(lock.package, "@greenways/hestia-browser");
assert.match(lock.revision, REVISION_PATTERN);
assertClosedObject(lock.artifacts, "lock.artifacts", ARTIFACT_NAMES);
for (const [name, artifact] of Object.entries(lock.artifacts)) {
  assertClosedObject(artifact, `lock.artifacts.${name}`, ARTIFACT_FIELDS);
  assert.match(artifact.digest, SHA256_PATTERN, `${name} digest`);
}

const repositoryRoot = await realpath(resolve(suppliedRepository));
if (process.env.GREENWAYS_SKIP_HESTIA_REVISION !== "1") {
  const revision = execFileSync(
    "git",
    ["-C", repositoryRoot, "rev-parse", "HEAD"],
    { encoding: "utf8" }
  ).trim();
  assert.equal(revision, lock.revision, "Hestia checkout revision");
}

const artifactPaths = {};
const artifactBytes = {};
for (const [name, artifact] of Object.entries(lock.artifacts)) {
  const path = await canonicalContainedPath(repositoryRoot, artifact.path, name);
  const bytes = await readFile(path);
  assert.equal(digest(bytes), artifact.digest, `${name} digest`);
  artifactPaths[name] = path;
  artifactBytes[name] = bytes;
}

const packageManifest = JSON.parse(artifactBytes.packageManifest.toString("utf8"));
assert.equal(packageManifest.name, lock.package);
assert.ok(packageManifest.exports && typeof packageManifest.exports === "object");
for (const [exportName, artifactName] of Object.entries(REQUIRED_PACKAGE_EXPORTS)) {
  assert.equal(typeof packageManifest.exports[exportName], "string", `${exportName} export`);
  assert.equal(
    resolve(dirname(artifactPaths.packageManifest), packageManifest.exports[exportName]),
    artifactPaths[artifactName],
    `${exportName} export path`
  );
}

const manifest = JSON.parse(artifactBytes.importManifest.toString("utf8"));
assertClosedObject(manifest, "import manifest", IMPORT_FIELDS);
assert.equal(manifest.protocol, IMPORT_PROTOCOL);
assert.equal(manifest.ownerRepository, lock.repository);
assert.equal(manifest.package, lock.package);
assert.equal(manifest.export, "./room-authority");
assert.equal(manifest.projectionExport, "./room-authority-projections");
assert.equal(manifest.authorityRecordExport, "./room-authority-records");
assert.equal(
  manifest.sourceGrantProjectionExport,
  "./room-authority-source-projections"
);
assert.equal(manifest.authorityDecisionProtocol, DECISION_PROTOCOL);
assert.equal(manifest.conformanceProtocol, CONFORMANCE_PROTOCOL);
assert.equal(
  resolve(dirname(artifactPaths.importManifest), manifest.conformanceFixture),
  artifactPaths.conformanceFixture,
  "manifest fixture path"
);
assert.equal(
  manifest.canonicalAuthority,
  "HCV1/HCP1 room records and exact Hestia receipt roots"
);
assert.equal(
  manifest.consumerBoundary,
  "Greenways OS imports and executes this policy without defining parallel room authority"
);

const fixture = JSON.parse(artifactBytes.conformanceFixture.toString("utf8"));
assert.equal(fixture.protocol, CONFORMANCE_PROTOCOL);
assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, "conformance cases");

const [
  authority,
  roomProjections,
  authorityRecords,
  sourceGrantProjections,
  agentRoomRecords,
  agentProtocol
] = await Promise.all([
  importArtifact(lock, artifactPaths, "decisionModule"),
  importArtifact(lock, artifactPaths, "roomProjectionModule"),
  importArtifact(lock, artifactPaths, "authorityRecordModule"),
  importArtifact(lock, artifactPaths, "sourceGrantProjectionModule"),
  importArtifact(lock, artifactPaths, "agentRoomRecordModule"),
  importArtifact(lock, artifactPaths, "agentProtocolModule")
]);

assert.equal(authority.ROOM_AUTHORITY_DECISION_PROTOCOL, DECISION_PROTOCOL);
assert.equal(authority.ROOM_AUTHORITY_CONFORMANCE_PROTOCOL, CONFORMANCE_PROTOCOL);
assert.equal(typeof authority.authorizeRoomInvocation, "function");
assert.equal(typeof roomProjections.projectVerifiedRoom, "function");
assert.equal(typeof roomProjections.projectVerifiedMembership, "function");
assert.equal(typeof authorityRecords.createRoomSourceMandate, "function");
assert.equal(typeof authorityRecords.createRoomApplicationGrant, "function");
assert.equal(typeof sourceGrantProjections.projectVerifiedSourceMandate, "function");
assert.equal(
  typeof sourceGrantProjections.projectVerifiedRoomApplicationGrant,
  "function"
);

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

const governanceRoot = `sha256:${"4".repeat(64)}`;
const activityRoot = `sha256:${"5".repeat(64)}`;
const argumentsRoot = `sha256:${"6".repeat(64)}`;
const membershipEpoch = 2;
const policyRevision = 4;
const validFrom = "2026-08-01T00:00:00.000Z";
const validUntil = "2026-09-01T00:00:00.000Z";
const observedAt = "2026-08-13T00:00:00.000Z";
const revokedAt = "2026-08-12T00:00:00.000Z";
const application = applicationIdentity();

async function createProfile(profileId, name, purposes) {
  const rootKey = await agentProtocol.generateAgentKey();
  const operationalKey = await agentProtocol.generateAgentKey();
  const created = await agentProtocol.createAgentProfile({
    profileId,
    name,
    rootKey,
    operationalKey,
    purposes,
    validUntil: "2099-01-01T00:00:00.000Z"
  });
  return { ...created, rootKey, operationalKey };
}

const host = await createProfile("profile:alice", "Alice", [
  "profile.update",
  "room.create",
  "room.invite",
  "room.join",
  "room.message"
]);
const guest = await createProfile("profile:bob", "Bob", [
  "profile.update",
  "room.app.invoke",
  "room.join"
]);
const room = await agentRoomRecords.createRoomVersion({
  roomId: "room/design-studio",
  hostProfileRecord: host.record,
  signingKey: host.operationalKey
});
const membershipRecord = await agentProtocol.signAgentRecord("room/membership", {
  room_root: room.record.root,
  member_profile_root: guest.record.root,
  role: "member",
  purposes: ["room.app.invoke"],
  status: "active",
  joined_epoch: membershipEpoch,
  revoked_epoch: null,
  delegation_root: guest.delegation.root
}, host.operationalKey);

const roomProjection = await roomProjections.projectVerifiedRoom({
  roomRecord: room.record,
  signerPublicKey: host.operationalKey.publicKey,
  expectedSignerKeyId: host.operationalKey.id,
  governanceRoot,
  membershipEpoch,
  policyRevision,
  activityHeadRoot: activityRoot,
  status: "open"
});
const membershipProjection = await roomProjections.projectVerifiedMembership({
  membershipRecord,
  signerPublicKey: host.operationalKey.publicKey,
  expectedSignerKeyId: host.operationalKey.id,
  roomProjection,
  memberNodeId: "node/bob-macbook",
  validFrom,
  validUntil
});
const sourceMandateRecord = await authorityRecords.createRoomSourceMandate({
  mandateId: "source-mandate/alice-chatgpt-browser",
  roomRecord: room.record,
  governanceRoot,
  issuedByProfileRoot: host.record.root,
  authorityRoot: host.delegation.root,
  sourceId: "source/alice-chatgpt-browser",
  sourceNodeId: "node/alice-macbook",
  implementation: "greenways.chatgpt-web",
  application,
  operations: ["conversation.create", "message.submit", "response.read"],
  membershipEpoch,
  policyRevision,
  requiresUserInteraction: true,
  validFrom,
  validUntil,
  signingKey: host.operationalKey
});
const sourceMandateProjection =
  await sourceGrantProjections.projectVerifiedSourceMandate({
    mandateRecord: sourceMandateRecord,
    signerPublicKey: host.operationalKey.publicKey,
    expectedSignerKeyId: host.operationalKey.id,
    roomProjection
  });
const grantRecord = await authorityRecords.createRoomApplicationGrant({
  grantId: "room-application-grant/bob-chat",
  roomRecord: room.record,
  governanceRoot,
  issuedByProfileRoot: host.record.root,
  authorityRoot: host.delegation.root,
  memberProfileRoot: guest.record.root,
  memberNodeId: "node/bob-macbook",
  sourceMandateRecord,
  application,
  operations: ["message.submit", "response.read"],
  limits: {
    requestsPerDay: 20,
    maxInputBytes: 20_000,
    maxOutputBytes: 100_000,
    maxTimeoutMs: 86_400_000
  },
  membershipEpoch,
  policyRevision,
  validFrom,
  validUntil,
  signingKey: host.operationalKey
});
const grantProjection =
  await sourceGrantProjections.projectVerifiedRoomApplicationGrant({
    grantRecord,
    signerPublicKey: host.operationalKey.publicKey,
    expectedSignerKeyId: host.operationalKey.id,
    roomProjection,
    membershipProjection,
    sourceMandateProjection
  });
const invocation = {
  protocol: INVOCATION_PROTOCOL,
  requestId: "room-request/greenways-import-0001",
  roomId: roomProjection.roomId,
  governanceRoot: roomProjection.governanceRoot,
  membershipRoot: membershipProjection.membershipRoot,
  memberProfileRoot: membershipProjection.memberProfileRoot,
  memberNodeId: membershipProjection.memberNodeId,
  sourceId: sourceMandateProjection.sourceId,
  sourceMandateRoot: sourceMandateProjection.mandateRoot,
  grantRoot: grantProjection.grantRoot,
  application,
  operation: "message.submit",
  argumentsDigest: argumentsRoot,
  inputBytes: 1200,
  maxOutputBytes: 50_000,
  timeoutMs: 3_600_000,
  createdAt: "2026-08-12T23:59:00.000Z",
  expiresAt: "2026-08-13T01:00:00.000Z"
};

const allowed = authority.authorizeRoomInvocation({
  room: roomProjection,
  membership: membershipProjection,
  sourceMandate: sourceMandateProjection,
  grant: grantProjection,
  invocation,
  observedAt
});
assert.equal(allowed.allowed, true);
assert.equal(allowed.reason, "allowed");
assert.equal(allowed.requiresUserInteraction, true);
assert.equal(allowed.membershipRoot, membershipRecord.root);
assert.equal(allowed.sourceMandateRoot, sourceMandateRecord.root);
assert.equal(allowed.grantRoot, grantRecord.root);

function assertDeniedDecision(decision, expectedReason, name) {
  assert.equal(decision.allowed, false, `${name} allowed`);
  assert.equal(decision.reason, expectedReason, `${name} reason`);
  assert.equal(decision.membershipRoot, null, `${name} membership root`);
  assert.equal(decision.sourceMandateRoot, null, `${name} source mandate root`);
  assert.equal(decision.grantRoot, null, `${name} grant root`);
  assert.equal(decision.requiresUserInteraction, false, `${name} interaction`);
}

const substitutions = [
  {
    name: "member identity substitution",
    invocation: {
      ...invocation,
      memberProfileRoot: `sha256:${"7".repeat(64)}`
    },
    reason: "membership-mismatch"
  },
  {
    name: "member node substitution",
    invocation: { ...invocation, memberNodeId: "node/substituted" },
    reason: "membership-mismatch"
  },
  {
    name: "source identity substitution",
    invocation: { ...invocation, sourceId: "source/substituted" },
    reason: "source-mismatch"
  },
  {
    name: "application identity substitution",
    invocation: {
      ...invocation,
      application: { ...application, version: "0.2.0" }
    },
    reason: "source-application-mismatch"
  },
  {
    name: "operation substitution",
    invocation: { ...invocation, operation: "conversation.create" },
    reason: "grant-operation-denied"
  },
  {
    name: "membership root substitution",
    invocation: {
      ...invocation,
      membershipRoot: `sha256:${"8".repeat(64)}`
    },
    reason: "membership-mismatch"
  },
  {
    name: "source mandate root substitution",
    invocation: {
      ...invocation,
      sourceMandateRoot: `sha256:${"9".repeat(64)}`
    },
    reason: "source-mismatch"
  },
  {
    name: "room application grant root substitution",
    invocation: { ...invocation, grantRoot: `sha256:${"a".repeat(64)}` },
    reason: "grant-mismatch"
  }
];

for (const substitution of substitutions) {
  const denied = authority.authorizeRoomInvocation({
    room: roomProjection,
    membership: membershipProjection,
    sourceMandate: sourceMandateProjection,
    grant: grantProjection,
    invocation: substitution.invocation,
    observedAt
  });
  assertDeniedDecision(denied, substitution.reason, substitution.name);
}

const sourceRevocationRecord =
  await authorityRecords.createRoomSourceMandateRevocation({
    revocationId: "source-mandate-revocation/import-proof",
    roomRecord: room.record,
    governanceRoot,
    mandateRecord: sourceMandateRecord,
    revokedByProfileRoot: host.record.root,
    authorityRoot: host.delegation.root,
    reason: "host-disabled-source",
    revokedAt,
    signingKey: host.operationalKey
  });
const revokedSourceProjection =
  await sourceGrantProjections.projectVerifiedSourceMandate({
    mandateRecord: sourceMandateRecord,
    signerPublicKey: host.operationalKey.publicKey,
    expectedSignerKeyId: host.operationalKey.id,
    roomProjection,
    revocationRecord: sourceRevocationRecord,
    revocationSignerPublicKey: host.operationalKey.publicKey,
    expectedRevocationSignerKeyId: host.operationalKey.id
  });
const sourceRevoked = authority.authorizeRoomInvocation({
  room: roomProjection,
  membership: membershipProjection,
  sourceMandate: revokedSourceProjection,
  grant: grantProjection,
  invocation,
  observedAt
});
assertDeniedDecision(sourceRevoked, "source-inactive", "source revocation");

const grantRevocationRecord =
  await authorityRecords.createRoomApplicationGrantRevocation({
    revocationId: "room-application-grant-revocation/import-proof",
    roomRecord: room.record,
    governanceRoot,
    grantRecord,
    revokedByProfileRoot: host.record.root,
    authorityRoot: host.delegation.root,
    reason: "member-access-revoked",
    revokedAt,
    signingKey: host.operationalKey
  });
const revokedGrantProjection =
  await sourceGrantProjections.projectVerifiedRoomApplicationGrant({
    grantRecord,
    signerPublicKey: host.operationalKey.publicKey,
    expectedSignerKeyId: host.operationalKey.id,
    roomProjection,
    membershipProjection,
    sourceMandateProjection,
    revocationRecord: grantRevocationRecord,
    revocationSignerPublicKey: host.operationalKey.publicKey,
    expectedRevocationSignerKeyId: host.operationalKey.id
  });
const grantRevoked = authority.authorizeRoomInvocation({
  room: roomProjection,
  membership: membershipProjection,
  sourceMandate: sourceMandateProjection,
  grant: revokedGrantProjection,
  invocation,
  observedAt
});
assertDeniedDecision(grantRevoked, "grant-inactive", "grant revocation");

console.log(
  `Verified ${fixture.cases.length} fixture cases, ${substitutions.length} exact `
    + `substitution denials, and canonical Hestia room records at ${lock.revision}.`
);
