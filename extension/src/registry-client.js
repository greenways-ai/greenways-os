import { parseEDNString } from "edn-data";
import { validateAppManifest } from "./app-catalog.js";
import { appApprovalIdentity } from "./app-launch.js";
import {
  loadLockedPackageBundle,
  lockedPackageAppEntry,
} from "./hara-packages.js";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const COORDINATE = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._/-]*$/;
const VERSION_KEYS = new Set([
  "version", "lock/url", "lock/sha256", "app/manifest", "publisher/signature",
]);
const ednOptions = {
  mapAs: "object", setAs: "array", listAs: "array",
  keywordAs: "string", charAs: "string", objectKeysAs: "string",
};
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
  return input;
}

function nonEmpty(value, label, maximum = 2048) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const output = value.trim();
  if (output.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return output;
}

function base64urlBytes(value, label) {
  const input = nonEmpty(value, label, 16 * 1024 * 1024);
  if (!/^[A-Za-z0-9_-]+$/.test(input) || input.length % 4 === 1) throw new Error(`${label} is not base64url`);
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((input.length + 3) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function encodeBase64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function normalizedOrigin(value, label = "Registry origin") {
  let url;
  try {
    url = new URL(nonEmpty(value, label));
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be a credential-free HTTPS origin`);
  }
  url.pathname = "/";
  return url.href;
}

function sameOriginUrl(value, origin, label) {
  let url;
  try {
    url = new URL(nonEmpty(value, label), origin);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" || url.origin !== new URL(origin).origin
      || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must remain on the signed registry origin`);
  }
  return url.href;
}

function trustedKey(source, keyId, label) {
  if (!KEY_ID.test(keyId)) throw new Error(`${label} key id is invalid`);
  const value = source instanceof Map ? source.get(keyId) : source?.[keyId];
  if (!value) throw new Error(`${label} key is not trusted: ${keyId}`);
  return value;
}

async function importP256Key(value, subtle, label) {
  if (value?.type === "public" && value?.algorithm?.name === "ECDSA") return value;
  const jwk = plainObject(value, `${label} JWK`);
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || jwk.d) {
    throw new Error(`${label} must be a public P-256 JWK`);
  }
  return subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

async function verifySignature({ bytes, signature, key, subtle, label }) {
  if (signature.byteLength !== 64) throw new Error(`${label} must be a 64-byte P-256 signature`);
  const valid = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    bytes,
  );
  if (!valid) throw new Error(`${label} is invalid`);
}

function parseInstant(value, label) {
  const input = nonEmpty(value, label, 64);
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO-8601 instant`);
  return milliseconds;
}

function publisherFromEdn(value, label) {
  const input = exactKeys(
    value,
    new Set(["publisher/id", "publisher/name", "publisher/key-id"]),
    label,
  );
  const id = nonEmpty(input["publisher/id"], `${label} id`, 80);
  const name = nonEmpty(input["publisher/name"], `${label} name`, 80);
  const keyId = nonEmpty(input["publisher/key-id"], `${label} key id`, 128);
  if (!KEY_ID.test(keyId)) throw new Error(`${label} key id is invalid`);
  return Object.freeze({ id, name, keyId });
}

function manifestFromEdn(value, { registry, coordinate, lockDigest, publisher }) {
  const input = exactKeys(
    value,
    new Set([
      "app/protocol", "app/id", "app/version", "app/publisher",
      "app/name", "app/description", "app/category", "app/capabilities",
    ]),
    `Registry package ${coordinate} app manifest`,
  );
  const manifestPublisher = exactKeys(
    input["app/publisher"],
    new Set(["publisher/id", "publisher/name"]),
    `Registry package ${coordinate} app publisher`,
  );
  if (manifestPublisher["publisher/id"] !== publisher.id) {
    throw new Error(`Registry package ${coordinate} app publisher does not match its package publisher`);
  }
  return validateAppManifest({
    protocol: input["app/protocol"],
    id: input["app/id"],
    version: input["app/version"],
    publisher: {
      id: manifestPublisher["publisher/id"],
      name: manifestPublisher["publisher/name"],
    },
    name: input["app/name"],
    description: input["app/description"],
    category: input["app/category"],
    capabilities: input["app/capabilities"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "release",
    lockDigest,
    source: { kind: "registry", registry, coordinate },
  });
}

function publisherSignatureRecord(value, label) {
  const input = exactKeys(
    value,
    new Set(["algorithm", "key-id", "value"]),
    label,
  );
  if (input.algorithm !== "ES256") throw new Error(`${label} algorithm must be ES256`);
  const keyId = nonEmpty(input["key-id"], `${label} key id`, 128);
  return Object.freeze({
    keyId,
    value: base64urlBytes(input.value, `${label} value`),
  });
}

export function publisherSignaturePayload({ registry, coordinate, version, lockDigest, manifest }) {
  const fields = [
    registry,
    coordinate,
    version,
    lockDigest,
    JSON.stringify(appApprovalIdentity(manifest)),
  ];
  return encoder.encode(fields.join("\0"));
}

export async function verifyRegistryEnvelope(
  source,
  { trustedKeys, subtle = globalThis.crypto?.subtle, now = () => new Date() } = {},
) {
  if (!subtle) throw new Error("Web Crypto is unavailable");
  const envelope = exactKeys(
    parseEDNString(String(source), ednOptions),
    new Set([
      "registry/protocol", "registry/key-id", "registry/algorithm",
      "registry/signed", "registry/signature",
    ]),
    "Registry envelope",
  );
  if (envelope["registry/protocol"] !== "greenways-registry/0-alpha") {
    throw new Error("Registry envelope protocol is not supported");
  }
  if (envelope["registry/algorithm"] !== "ES256") {
    throw new Error("Registry envelope algorithm must be ES256");
  }
  const keyId = nonEmpty(envelope["registry/key-id"], "Registry envelope key id", 128);
  const key = await importP256Key(
    trustedKey(trustedKeys, keyId, "Registry envelope"),
    subtle,
    "Registry envelope key",
  );
  const payloadBytes = base64urlBytes(envelope["registry/signed"], "Registry signed payload");
  const signature = base64urlBytes(envelope["registry/signature"], "Registry signature");
  await verifySignature({ bytes: payloadBytes, signature, key, subtle, label: "Registry signature" });

  const index = exactKeys(
    parseEDNString(decoder.decode(payloadBytes), ednOptions),
    new Set([
      "index/protocol", "index/registry", "index/generated-at",
      "index/expires-at", "index/packages",
    ]),
    "Registry index",
  );
  if (index["index/protocol"] !== "greenways-registry-index/0-alpha") {
    throw new Error("Registry index protocol is not supported");
  }
  const registry = normalizedOrigin(index["index/registry"], "Registry index origin");
  const generatedAt = parseInstant(index["index/generated-at"], "Registry index generated-at");
  const expiresAt = parseInstant(index["index/expires-at"], "Registry index expires-at");
  if (expiresAt <= generatedAt) throw new Error("Registry index expiry must follow generation");
  if (now().getTime() > expiresAt) throw new Error("Registry index has expired");
  const packages = plainObject(index["index/packages"], "Registry index packages");
  return Object.freeze({
    keyId,
    registry,
    generatedAt: new Date(generatedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    packages,
    payloadBytes,
  });
}

function packageVersion(index, coordinate, requestedVersion) {
  if (typeof coordinate !== "string" || !COORDINATE.test(coordinate) || coordinate.includes("..")) {
    throw new Error("Registry package coordinate is invalid");
  }
  const rawPackage = index.packages[coordinate];
  if (!rawPackage) throw new Error(`Registry package is not listed: ${coordinate}`);
  const record = exactKeys(
    rawPackage,
    new Set(["package/id", "package/publisher", "package/latest", "package/versions"]),
    `Registry package ${coordinate}`,
  );
  const publisher = publisherFromEdn(record["package/publisher"], `Registry package ${coordinate} publisher`);
  const versions = plainObject(record["package/versions"], `Registry package ${coordinate} versions`);
  const version = requestedVersion || record["package/latest"];
  const rawVersion = versions[version];
  if (!rawVersion) throw new Error(`Registry package ${coordinate} does not list version ${version}`);
  const versionRecord = exactKeys(rawVersion, VERSION_KEYS, `Registry package ${coordinate}@${version}`);
  if (versionRecord.version !== version) throw new Error(`Registry package ${coordinate} version key does not match its record`);
  const lockDigest = nonEmpty(versionRecord["lock/sha256"], `Registry package ${coordinate} lock digest`, 80);
  if (!SHA256.test(lockDigest)) throw new Error(`Registry package ${coordinate} lock digest is invalid`);
  return {
    packageId: nonEmpty(record["package/id"], `Registry package ${coordinate} id`, 80),
    publisher,
    version,
    versionRecord,
    lockDigest,
  };
}

export class RegistryClient {
  constructor({
    origin,
    trustedRegistryKeys,
    trustedPublisherKeys,
    request = (...args) => globalThis.fetch(...args),
    subtle = globalThis.crypto?.subtle,
    now = () => new Date(),
  } = {}) {
    this.origin = normalizedOrigin(origin);
    this.trustedRegistryKeys = trustedRegistryKeys;
    this.trustedPublisherKeys = trustedPublisherKeys;
    this.request = request;
    this.subtle = subtle;
    this.now = now;
    this.indexPromise = null;
  }

  async text(url, label) {
    const response = await this.request(url, { headers: { accept: "application/edn,text/plain" } });
    if (!response?.ok) throw new Error(`${label} failed: ${response?.status ?? "network"}`);
    return response.text();
  }

  async index({ refresh = false } = {}) {
    if (refresh || !this.indexPromise) {
      this.indexPromise = this.text(new URL("v1/index.edn", this.origin).href, "Registry index")
        .then((source) => verifyRegistryEnvelope(source, {
          trustedKeys: this.trustedRegistryKeys,
          subtle: this.subtle,
          now: this.now,
        }))
        .then((index) => {
          if (index.registry !== this.origin) throw new Error("Signed registry origin does not match the requested registry");
          return index;
        });
    }
    return this.indexPromise;
  }

  async resolve(coordinate, requestedVersion) {
    const index = await this.index();
    const { packageId, publisher, version, versionRecord, lockDigest } = packageVersion(index, coordinate, requestedVersion);
    const manifest = manifestFromEdn(versionRecord["app/manifest"], {
      registry: index.registry,
      coordinate,
      lockDigest,
      publisher,
    });
    if (manifest.version !== version) throw new Error("Registry app manifest version does not match its version record");
    if (manifest.id !== packageId) throw new Error("Registry app manifest id does not match its package record");

    const signature = publisherSignatureRecord(
      versionRecord["publisher/signature"],
      `Registry package ${coordinate}@${version} publisher signature`,
    );
    if (signature.keyId !== publisher.keyId) {
      throw new Error(`Registry package ${coordinate} publisher signature key does not match its publisher record`);
    }
    const publisherKey = await importP256Key(
      trustedKey(this.trustedPublisherKeys, publisher.keyId, "Publisher"),
      this.subtle,
      "Publisher key",
    );
    await verifySignature({
      bytes: publisherSignaturePayload({
        registry: index.registry,
        coordinate,
        version,
        lockDigest,
        manifest,
      }),
      signature: signature.value,
      key: publisherKey,
      subtle: this.subtle,
      label: `Registry package ${coordinate}@${version} publisher signature`,
    });

    const lockUrl = sameOriginUrl(
      versionRecord["lock/url"],
      index.registry,
      `Registry package ${coordinate}@${version} lock URL`,
    );
    const lockSource = await this.text(lockUrl, `Registry package ${coordinate}@${version} lock`);
    const bundle = await loadLockedPackageBundle(lockSource, this.request, {
      resolvePackageUrl: (value) => sameOriginUrl(
        value,
        index.registry,
        `Registry package ${coordinate}@${version} archive URL`,
      ),
    });
    if (bundle.lockDigest !== lockDigest) {
      throw new Error(`Registry package ${coordinate}@${version} lock digest mismatch`);
    }
    return Object.freeze({
      coordinate,
      version,
      publisher,
      manifest,
      bundle,
      staged: Object.freeze({
        id: manifest.id,
        lockDigest,
        entry: lockedPackageAppEntry(bundle),
        resources: bundle.resources,
      }),
    });
  }
}
