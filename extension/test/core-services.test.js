import assert from "node:assert/strict";
import test from "node:test";
import {
  APP_CAPABILITIES,
  CAPABILITY_GRANT_PROTOCOL,
  CORE_SERVICES,
  activeCapabilityGrant,
  createCapabilityGrant,
  getCapabilityDefinition,
  getCoreService,
  normalizeCapabilityConstraints,
  revokeCapabilityGrant,
  validateCapabilityGrant,
} from "../src/core-services.js";

const digest = `sha256:${"a".repeat(64)}`;
const moduleManifest = Object.freeze({
  protocol: "greenways-app/1",
  id: "signing-room",
  version: "0.1.0",
  publisher: Object.freeze({ id: "example", name: "Example" }),
  capabilities: Object.freeze(["hara/module", "key/sign", "credential/use", "model/generate"]),
  kind: "hal-module",
  lockDigest: digest,
});

const clock = (value) => () => new Date(value);

test("publishes a closed, resident core service graph", () => {
  assert.equal(CORE_SERVICES.length, 10);
  assert.equal(new Set(CORE_SERVICES.map(({ id }) => id)).size, CORE_SERVICES.length);
  for (const service of CORE_SERVICES) {
    assert.equal(service.resident, true);
    assert.equal(service.removable, false);
    for (const dependency of service.dependencies) assert.ok(getCoreService(dependency));
  }
  assert.equal(getCoreService("keyring").status, "active");
  assert.equal(getCoreService("work").status, "foundation");
});

test("adds opaque key, model, and MCP operations to the closed app capability vocabulary", () => {
  for (const capability of [
    "key/public",
    "key/sign",
    "credential/manage",
    "credential/use",
    "model/generate",
    "model/provide",
    "mcp/pair",
  ]) {
    assert.ok(APP_CAPABILITIES.includes(capability));
    assert.equal(getCapabilityDefinition(capability).grantable, true);
  }
  assert.deepEqual(getCapabilityDefinition("model/provide").trustedPublishers, ["greenways-ai"]);
  assert.equal(getCapabilityDefinition("mcp/pair").service, "keyring");
  assert.deepEqual(getCapabilityDefinition("mcp/pair").trustedPublishers, ["greenways-ai"]);
  assert.equal(getCapabilityDefinition("hara/module").grantable, false);
});

test("creates a capability grant bound to exact app approval identity", () => {
  const grant = createCapabilityGrant({
    id: "grant/signing-room-0001",
    appId: moduleManifest.id,
    capability: "key/sign",
    constraints: { purpose: "publication-receipt", algorithms: ["ECDSA-P256-SHA256"] },
    expiresAt: "2026-08-07T00:00:00.000Z",
  }, moduleManifest, { now: clock("2026-08-06T00:00:00.000Z") });

  assert.equal(grant.protocol, CAPABILITY_GRANT_PROTOCOL);
  assert.deepEqual(grant.subject, {
    kind: "app",
    appId: "signing-room",
    version: "0.1.0",
    publisherId: "example",
    lockDigest: digest,
  });
  assert.equal(grant.capability, "key/sign");
  assert.equal(
    activeCapabilityGrant([grant], moduleManifest, "key/sign", {
      now: clock("2026-08-06T12:00:00.000Z"),
    })?.id,
    grant.id,
  );
});

test("stale, expired, and revoked grants cannot authorize an app", () => {
  const grant = createCapabilityGrant({
    id: "grant/signing-room-0002",
    appId: moduleManifest.id,
    capability: "credential/use",
    constraints: { profileId: "openai.personal" },
    expiresAt: "2026-08-06T01:00:00.000Z",
  }, moduleManifest, { now: clock("2026-08-06T00:00:00.000Z") });

  assert.equal(activeCapabilityGrant([grant], moduleManifest, "credential/use", {
    now: clock("2026-08-06T02:00:00.000Z"),
  }), null);
  assert.equal(activeCapabilityGrant([grant], {
    ...moduleManifest,
    version: "0.2.0",
  }, "credential/use", {
    now: clock("2026-08-06T00:30:00.000Z"),
  }), null);

  const revoked = revokeCapabilityGrant(grant, { now: clock("2026-08-06T00:20:00.000Z") });
  assert.equal(activeCapabilityGrant([revoked], moduleManifest, "credential/use", {
    now: clock("2026-08-06T00:30:00.000Z"),
  }), null);
});

test("rejects undeclared, non-grantable, and publisher-restricted authority", () => {
  assert.throws(() => createCapabilityGrant({
    id: "grant/signing-room-0003",
    appId: moduleManifest.id,
    capability: "key/public",
  }, moduleManifest), /does not declare key\/public/);

  assert.throws(() => createCapabilityGrant({
    id: "grant/signing-room-0004",
    appId: moduleManifest.id,
    capability: "hara/module",
  }, moduleManifest), /not operation-grantable/);

  assert.throws(() => createCapabilityGrant({
    id: "grant/signing-room-0005",
    appId: moduleManifest.id,
    capability: "credential/manage",
  }, {
    ...moduleManifest,
    capabilities: [...moduleManifest.capabilities, "credential/manage"],
  }), /trusted publisher/);
});

test("capability constraints are bounded and prototype-safe", () => {
  const safe = normalizeCapabilityConstraints({ profiles: ["openai.personal"], limit: 5 });
  assert.deepEqual(safe, { profiles: ["openai.personal"], limit: 5 });
  assert.ok(Object.isFrozen(safe));
  assert.throws(
    () => normalizeCapabilityConstraints(JSON.parse('{"__proto__":{"admin":true}}')),
    /forbidden field/,
  );
  assert.throws(
    () => normalizeCapabilityConstraints({ apiKey: "sk-must-not-be-durable" }),
    /cannot contain secret material/,
  );

  const grant = validateCapabilityGrant({
    protocol: CAPABILITY_GRANT_PROTOCOL,
    id: "grant/signing-room-0006",
    subject: {
      kind: "app",
      appId: "signing-room",
      version: "0.1.0",
      publisherId: "example",
      lockDigest: digest,
    },
    capability: "model/generate",
    constraints: { profileId: "openai.personal", maxTokens: 2048 },
    issuedAt: "2026-08-06T00:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
  });
  assert.equal(grant.constraints.maxTokens, 2048);
});
