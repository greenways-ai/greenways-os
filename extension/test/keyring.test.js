import assert from "node:assert/strict";
import test from "node:test";
import {
  GreenwaysKeyring,
  KEYRING_PROTOCOL,
  KEYRING_SESSION_STORAGE_KEY,
  createProviderProfileId,
} from "../src/keyring.js";

class MemorySessionStorage {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return { [key]: this.values.get(key) };
  }

  async set(entries) {
    for (const [key, value] of Object.entries(entries)) this.values.set(key, value);
  }

  async remove(key) {
    this.values.delete(key);
  }
}

class MemoryIdentityStore {
  constructor() {
    this.values = new Map();
  }

  key(name, id) {
    return `${name}:${id}`;
  }

  async get(name, id) {
    return this.values.get(this.key(name, id));
  }

  async put(name, id, value) {
    this.values.set(this.key(name, id), value);
  }
}

const identityRecord = {
  identity: {
    identityId: "identity/test",
    handle: "river.studio",
    keyId: `sha256:${"a".repeat(64)}`,
    algorithm: "ECDSA-P256-SHA256",
    createdAt: "2026-08-06T00:00:00.000Z",
  },
  privateKey: { type: "private", extractable: false },
};

function createKeyring() {
  return new GreenwaysKeyring({
    sessionStorage: new MemorySessionStorage(),
    identityStore: new MemoryIdentityStore(),
    identityFactory: async () => identityRecord,
    now: () => "2026-08-06T00:00:00.000Z",
  });
}

test("creates one durable controller and projects public metadata only", async () => {
  const keyring = createKeyring();
  assert.equal((await keyring.status()).controller, null);
  const controller = await keyring.createController("river.studio");
  assert.equal(controller.keyId, identityRecord.identity.keyId);
  assert.equal("privateKey" in controller, false);
  assert.equal((await keyring.status()).controller.handle, "river.studio");
  await assert.rejects(() => keyring.createController("second"), /already exists/);
});

test("keeps provider credentials in session storage and redacts status", async () => {
  const keyring = createKeyring();
  const profile = await keyring.addProviderProfile({
    id: "openrouter.personal.abc123",
    provider: "openrouter",
    label: "Personal coding",
    secret: "sk-or-v1-secret-value",
  });
  assert.equal(profile.protocol, KEYRING_PROTOCOL);
  assert.equal(profile.sessionOnly, true);
  assert.equal("secret" in profile, false);

  const status = await keyring.status();
  assert.equal(status.providerCredentialStorage, "session");
  assert.equal(status.providerProfiles.length, 1);
  assert.doesNotMatch(JSON.stringify(status), /sk-or-v1-secret-value/);

  const raw = await keyring.sessionStorage.get(KEYRING_SESSION_STORAGE_KEY);
  assert.equal(raw[KEYRING_SESSION_STORAGE_KEY][0].secret, "sk-or-v1-secret-value");
});

test("removes individual profiles and clears the entire provider session", async () => {
  const keyring = createKeyring();
  await keyring.addProviderProfile({
    id: "openai.primary.abc123",
    provider: "openai",
    label: "Primary",
    secret: "sk-openai-secret",
  });
  await keyring.addProviderProfile({
    id: "anthropic.backup.def456",
    provider: "anthropic",
    label: "Backup",
    secret: "sk-ant-secret",
  });
  await keyring.removeProviderProfile("openai.primary.abc123");
  assert.deepEqual((await keyring.status()).providerProfiles.map(({ id }) => id), [
    "anthropic.backup.def456",
  ]);
  assert.deepEqual(await keyring.clearProviderSession(), { cleared: 1 });
  assert.deepEqual((await keyring.status()).providerProfiles, []);
});

test("rejects unsupported providers, duplicate ids, and malformed secrets", async () => {
  const keyring = createKeyring();
  await assert.rejects(() => keyring.addProviderProfile({
    id: "other.personal.abc123",
    provider: "other",
    label: "Other",
    secret: "long-enough-secret",
  }), /Unsupported model provider/);
  await assert.rejects(() => keyring.addProviderProfile({
    id: "openai.short.abc123",
    provider: "openai",
    label: "Short",
    secret: "tiny",
  }), /too short/);
  await keyring.addProviderProfile({
    id: "openai.primary.abc123",
    provider: "openai",
    label: "Primary",
    secret: "long-enough-secret",
  });
  await assert.rejects(() => keyring.addProviderProfile({
    id: "openai.primary.abc123",
    provider: "openai",
    label: "Duplicate",
    secret: "another-long-secret",
  }), /already in use/);
});

test("creates bounded, provider-prefixed profile ids", () => {
  const random = {
    getRandomValues(bytes) {
      bytes.set([1, 2, 3, 4, 5]);
      return bytes;
    },
  };
  assert.equal(
    createProviderProfileId("openrouter", "Personal Coding", random),
    "openrouter.personal-coding.0102030405",
  );
});
