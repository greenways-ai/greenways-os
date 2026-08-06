import { createIdentity } from "./protocol.js";
import { store, withOriginLock } from "./storage.js";

export const KEYRING_PROTOCOL = "greenways-keyring/1";
export const KEYRING_SESSION_STORAGE_KEY = "greenways-keyring/provider-profiles";
const KEYRING_LOCK = "keyring";

export const KEYRING_PROVIDERS = Object.freeze([
  Object.freeze({ id: "openrouter", name: "OpenRouter" }),
  Object.freeze({ id: "openai", name: "OpenAI" }),
  Object.freeze({ id: "anthropic", name: "Anthropic" }),
]);

const PROVIDER_IDS = new Set(KEYRING_PROVIDERS.map(({ id }) => id));
const PROFILE_ID = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

function requiredString(value, label, maximum = 160) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const output = value.trim();
  if (!output) throw new Error(`${label} cannot be empty`);
  if (output.length > maximum) throw new Error(`${label} cannot exceed ${maximum} characters`);
  return output;
}

function profileId(value) {
  const output = requiredString(value, "Provider profile id", 64).toLowerCase();
  if (!PROFILE_ID.test(output)) {
    throw new Error("Provider profile id must use lowercase letters, numbers, dots, or dashes");
  }
  return output;
}

function providerId(value) {
  const output = requiredString(value, "Provider", 40).toLowerCase();
  if (!PROVIDER_IDS.has(output)) throw new Error(`Unsupported model provider: ${output}`);
  return output;
}

function providerSecret(value) {
  const output = requiredString(value, "Provider credential", 8192);
  if (/\r|\n/.test(output)) throw new Error("Provider credential cannot contain line breaks");
  if (output.length < 8) throw new Error("Provider credential is too short");
  return output;
}

function sessionArea(value = globalThis.chrome?.storage?.session) {
  if (!value || typeof value.get !== "function" || typeof value.set !== "function"
    || typeof value.remove !== "function") {
    throw new Error("Chrome session storage is unavailable");
  }
  return value;
}

function publicController(identityRecord) {
  const identity = identityRecord?.identity;
  if (!identity?.identityId || !identity?.keyId) return null;
  return Object.freeze({
    identityId: identity.identityId,
    handle: identity.handle,
    keyId: identity.keyId,
    algorithm: identity.algorithm,
    createdAt: identity.createdAt,
  });
}

function normalizeStoredProfile(value, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Stored provider profile ${index} is invalid`);
  }
  if (value.protocol !== KEYRING_PROTOCOL) {
    throw new Error(`Stored provider profile ${index} uses an unsupported protocol`);
  }
  return Object.freeze({
    protocol: KEYRING_PROTOCOL,
    id: profileId(value.id),
    provider: providerId(value.provider),
    label: requiredString(value.label, "Provider profile label", 80),
    secret: providerSecret(value.secret),
    createdAt: requiredString(value.createdAt, "Provider profile creation time", 80),
  });
}

function publicProfile(value) {
  return Object.freeze({
    protocol: KEYRING_PROTOCOL,
    id: value.id,
    provider: value.provider,
    label: value.label,
    createdAt: value.createdAt,
    sessionOnly: true,
  });
}

function randomSuffix(random = globalThis.crypto) {
  if (!random?.getRandomValues) throw new Error("Secure randomness is unavailable");
  const bytes = random.getRandomValues(new Uint8Array(5));
  return [...bytes].map((byte) => byte.toString(36).padStart(2, "0")).join("");
}

export function createProviderProfileId(provider, label, random = globalThis.crypto) {
  const providerName = providerId(provider);
  const slug = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30) || "personal";
  return profileId(`${providerName}.${slug}.${randomSuffix(random)}`);
}

export class GreenwaysKeyring {
  constructor({
    sessionStorage,
    identityStore = store,
    identityFactory = createIdentity,
    now = () => new Date().toISOString(),
  } = {}) {
    this.sessionStorage = sessionArea(sessionStorage);
    if (!identityStore || typeof identityStore.get !== "function" || typeof identityStore.put !== "function") {
      throw new TypeError("Greenways Keyring requires an identity store");
    }
    if (typeof identityFactory !== "function") throw new TypeError("Identity factory must be a function");
    if (typeof now !== "function") throw new TypeError("Keyring clock must be a function");
    this.identityStore = identityStore;
    this.identityFactory = identityFactory;
    this.now = now;
  }

  async readProfiles() {
    const stored = await this.sessionStorage.get(KEYRING_SESSION_STORAGE_KEY);
    const values = stored?.[KEYRING_SESSION_STORAGE_KEY] ?? [];
    if (!Array.isArray(values)) throw new Error("Stored provider profiles must be an array");
    const profiles = values.map(normalizeStoredProfile);
    if (new Set(profiles.map(({ id }) => id)).size !== profiles.length) {
      throw new Error("Stored provider profile ids must be unique");
    }
    return profiles;
  }

  async writeProfiles(profiles) {
    await this.sessionStorage.set({
      [KEYRING_SESSION_STORAGE_KEY]: profiles.map((profile, index) => normalizeStoredProfile(profile, index)),
    });
  }

  async status() {
    const [identityRecord, profiles] = await Promise.all([
      this.identityStore.get("identity", "owner"),
      this.readProfiles(),
    ]);
    return Object.freeze({
      protocol: KEYRING_PROTOCOL,
      controller: publicController(identityRecord),
      providerProfiles: Object.freeze(profiles.map(publicProfile)),
      providerCredentialStorage: "session",
    });
  }

  async createController(handle) {
    return withOriginLock(KEYRING_LOCK, async () => {
      const existing = await this.identityStore.get("identity", "owner");
      if (existing) throw new Error("A controller key already exists in this browser profile");
      const identityRecord = await this.identityFactory(handle);
      if (!identityRecord?.identity?.identityId || !identityRecord?.identity?.keyId || !identityRecord?.privateKey) {
        throw new Error("Identity factory did not return a key-controlled identity");
      }
      await this.identityStore.put("identity", "owner", identityRecord);
      return publicController(identityRecord);
    });
  }

  async addProviderProfile({ id, provider, label, secret }) {
    return withOriginLock(KEYRING_LOCK, async () => {
      const profiles = await this.readProfiles();
      const record = Object.freeze({
        protocol: KEYRING_PROTOCOL,
        id: profileId(id),
        provider: providerId(provider),
        label: requiredString(label, "Provider profile label", 80),
        secret: providerSecret(secret),
        createdAt: this.now(),
      });
      if (profiles.some((profile) => profile.id === record.id)) {
        throw new Error("Provider profile id is already in use");
      }
      await this.writeProfiles([...profiles, record]);
      return publicProfile(record);
    });
  }

  async removeProviderProfile(id) {
    return withOriginLock(KEYRING_LOCK, async () => {
      const requested = profileId(id);
      const profiles = await this.readProfiles();
      const next = profiles.filter((profile) => profile.id !== requested);
      if (next.length === profiles.length) throw new Error("Provider profile does not exist");
      await this.writeProfiles(next);
      return Object.freeze({ removed: requested });
    });
  }

  async clearProviderSession() {
    return withOriginLock(KEYRING_LOCK, async () => {
      const profiles = await this.readProfiles();
      await this.sessionStorage.remove(KEYRING_SESSION_STORAGE_KEY);
      return Object.freeze({ cleared: profiles.length });
    });
  }

}
