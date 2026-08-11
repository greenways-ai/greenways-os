const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const ZERO_HASH = `sha256:${"0".repeat(64)}`;

function webCrypto() {
  if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) {
    throw new Error("Web Crypto is required");
  }
  return globalThis.crypto;
}

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(value[key])}`
  ).join(",")}}`;
}

export function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value) {
  const base64 = String(value).replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256(value) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = new Uint8Array(await webCrypto().subtle.digest("SHA-256", bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function randomId(prefix = "record") {
  return `${prefix}/${bytesToBase64Url(webCrypto().getRandomValues(new Uint8Array(16)))}`;
}

export async function createIdentity(handle) {
  const keys = await webCrypto().subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]
  );
  const publicKey = await webCrypto().subtle.exportKey("jwk", keys.publicKey);
  const identityId = randomId("identity");
  const keyId = await sha256(canonical(publicKey));
  return {
    identity: {
      type: "GreenwaysIdentityCard",
      version: 1,
      identityId,
      handle: normalizeHandle(handle),
      keyId,
      algorithm: "ECDSA-P256-SHA256",
      publicKey,
      createdAt: new Date().toISOString()
    },
    privateKey: keys.privateKey
  };
}

export function normalizeHandle(value) {
  const handle = String(value ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$/.test(handle)) {
    throw new Error("Handle must be 1-48 lowercase letters, numbers, dots, dashes, or underscores");
  }
  return handle;
}

export function actionBody({ type, actor, workflowRoot = null, subject = null, payload = {} }) {
  if (!String(type).startsWith("@greenways/")) throw new Error("Greenways action type required");
  if (!actor?.identityId || !actor?.keyId) throw new Error("Key-controlled actor required");
  return {
    protocol: "greenways-action/0-alpha",
    id: randomId("action"),
    type,
    actor: { identityId: actor.identityId, handle: actor.handle, keyId: actor.keyId },
    workflowRoot,
    subject,
    payload,
    createdAt: new Date().toISOString()
  };
}

export async function signAction(body, privateKey) {
  const root = await sha256(canonical(body));
  return { ...body, root, signature: await signCanonical(body, privateKey) };
}

export async function verifyAction(action, publicJwk) {
  const { root, signature, ...body } = action;
  if (root !== await sha256(canonical(body))) return false;
  return verifyCanonicalSignature(body, signature, publicJwk);
}

async function signCanonical(value, privateKey) {
  const signature = new Uint8Array(await webCrypto().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(canonical(value))
  ));
  return bytesToBase64Url(signature);
}

async function verifyCanonicalSignature(value, signature, publicJwk) {
  if (!signature || !publicJwk) return false;
  try {
    const key = await webCrypto().subtle.importKey(
      "jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
    );
    return webCrypto().subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key,
      base64UrlToBytes(signature), encoder.encode(canonical(value))
    );
  } catch {
    return false;
  }
}

export async function includeAction(chainOwner, privateKey, previous, action) {
  if (!action?.root || !action?.signature) throw new Error("Signed action required");
  if (!chainOwner?.identityId || !chainOwner?.keyId || !chainOwner?.publicKey) {
    throw new Error("Key-controlled chain owner required");
  }
  if (chainOwner.keyId !== await sha256(canonical(chainOwner.publicKey))) {
    throw new Error("Chain owner key ID does not match its public key");
  }
  if (previous && (previous.chainId !== chainOwner.identityId || previous.keyId !== chainOwner.keyId)) {
    throw new Error("Previous inclusion belongs to another personal chain");
  }
  const inclusion = {
    protocol: "greenways-personal-chain/0-alpha",
    chainId: chainOwner.identityId,
    keyId: chainOwner.keyId,
    sequence: (previous?.sequence ?? 0) + 1,
    previousHash: previous?.eventHash ?? ZERO_HASH,
    actionRoot: action.root,
    includedAt: new Date().toISOString()
  };
  const signature = await signCanonical(inclusion, privateKey);
  if (!await verifyCanonicalSignature(inclusion, signature, chainOwner.publicKey)) {
    throw new Error("Personal-chain inclusion must be signed by the chain owner's key");
  }
  return { ...inclusion, eventHash: await sha256(canonical(inclusion)), signature };
}

export async function verifyPersonalChain(inclusions, publicKeys) {
  if (!Array.isArray(inclusions)) return false;
  let previous = null;
  let chainId = null;
  let keyId = null;
  for (const inclusion of inclusions) {
    if (!inclusion || typeof inclusion !== "object") return false;
    const { eventHash, signature, ...body } = inclusion;
    if (body.protocol !== "greenways-personal-chain/0-alpha" || !body.chainId || !body.keyId) return false;
    if (chainId === null) {
      chainId = body.chainId;
      keyId = body.keyId;
    } else if (body.chainId !== chainId || body.keyId !== keyId) {
      return false;
    }
    if (body.sequence !== (previous?.sequence ?? 0) + 1) return false;
    if (body.previousHash !== (previous?.eventHash ?? ZERO_HASH)) return false;
    if (eventHash !== await sha256(canonical(body))) return false;
    const publicJwk = publicKeys?.[body.keyId];
    if (!publicJwk || body.keyId !== await sha256(canonical(publicJwk))) return false;
    if (!await verifyCanonicalSignature(body, signature, publicJwk)) return false;
    previous = inclusion;
  }
  return true;
}

export async function createEvidenceBundle({
  identity,
  actions,
  inclusions,
  project,
  personalChainMigrations = [],
}) {
  const bundle = {
    protocol: "greenways-evidence-bundle/0-alpha",
    id: randomId("bundle"),
    exportedAt: new Date().toISOString(),
    project,
    publicKeys: { [identity.keyId]: identity.publicKey },
    identities: [identity],
    actions,
    inclusions,
    personalChainMigrations,
  };
  return { ...bundle, root: await sha256(canonical(bundle)) };
}

export async function verifyEvidenceBundle(bundle) {
  const { root, ...body } = bundle;
  const errors = [];
  if (root !== await sha256(canonical(body))) errors.push("bundle-root-mismatch");
  if (!await verifyPersonalChain(bundle.inclusions ?? [], bundle.publicKeys ?? {})) errors.push("personal-chain-invalid");
  for (const action of bundle.actions ?? []) {
    const key = bundle.publicKeys?.[action.actor?.keyId];
    if (!key || !await verifyAction(action, key)) errors.push(`action-invalid:${action.id}`);
  }
  const actionRoots = new Set((bundle.actions ?? []).map((action) => action.root));
  for (const inclusion of bundle.inclusions ?? []) {
    if (!actionRoots.has(inclusion.actionRoot)) errors.push(`action-missing:${inclusion.actionRoot}`);
  }
  for (const [index, migration] of (bundle.personalChainMigrations ?? []).entries()) {
    if (!await verifyPersonalChainMigration(
      migration,
      bundle.inclusions ?? [],
      bundle.publicKeys ?? {},
    )) {
      errors.push(`personal-chain-migration-invalid:${index}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function verifyPersonalChainMigration(migration, inclusions, publicKeys) {
  if (!migration || typeof migration !== "object" || Array.isArray(migration)
    || migration.protocol !== "greenways-action/0-alpha"
    || migration.type !== "@greenways/personal-chain-migrated"
    || migration.subject !== migration.actor?.identityId
    || migration.payload?.protocol !== "greenways-personal-chain-migration/0-alpha"
    || migration.payload.fromProtocol !== "greenways-personal-chain/0-alpha-unsigned"
    || migration.payload.toProtocol !== "greenways-personal-chain/0-alpha"
    || !Array.isArray(migration.payload.mappings)
    || !Array.isArray(migration.payload.previouslyPendingRoots)
    || !Array.isArray(inclusions)) {
    return false;
  }
  const publicKey = publicKeys?.[migration.actor?.keyId];
  if (!publicKey || !await verifyAction(migration, publicKey)) return false;
  const mappings = migration.payload.mappings;
  if (!mappings.length || mappings.length > inclusions.length) return false;
  const roots = new Set();
  for (const [index, mapping] of mappings.entries()) {
    const inclusion = inclusions[index];
    if (!mapping || mapping.sequence !== index + 1
      || inclusion?.sequence !== mapping.sequence
      || inclusion?.actionRoot !== mapping.actionRoot
      || inclusion?.eventHash !== mapping.signedEventHash
      || roots.has(mapping.actionRoot)) {
      return false;
    }
    roots.add(mapping.actionRoot);
  }
  return migration.payload.signedHead === inclusions[mappings.length - 1]?.eventHash
    && migration.payload.legacyHead === mappings.at(-1)?.legacyEventHash
    && new Set(migration.payload.previouslyPendingRoots).size
      === migration.payload.previouslyPendingRoots.length
    && migration.payload.previouslyPendingRoots.every((root) => roots.has(root));
}

export async function createFurnishingBundle({ identity, privateKey, title, ideas = [], repositories = [], parents = [], visibility = "personal" }) {
  if (!["personal", "shared"].includes(visibility)) throw new Error("Furnishing visibility must be personal or shared");
  const furnishing = {
    protocol: "greenways-room-furnishing/0-alpha",
    id: randomId("furnishing"),
    title: String(title ?? "Untitled furnishing"),
    parents: [...new Set(parents)],
    visibility,
    ideas: ideas.map(({ id, title: ideaTitle, body, color, position }) => ({ id, title: ideaTitle, body, color, position })),
    repositories: repositories.map(({ id, name, fileCount, nodes }) => ({ id, name, fileCount, nodes })),
    createdAt: new Date().toISOString()
  };
  const publication = await signAction(actionBody({
    type: "@greenways/furnishing-published", actor: identity, subject: furnishing.id,
    payload: { furnishingRoot: await sha256(canonical(furnishing)), parents: furnishing.parents, visibility }
  }), privateKey);
  const body = { protocol: "greenways-furnishing-bundle/0-alpha", furnishing, creator: identity, publication };
  return { ...body, root: await sha256(canonical(body)) };
}

export async function verifyFurnishingBundle(bundle) {
  const { root, ...body } = bundle ?? {};
  const errors = [];
  if (body.protocol !== "greenways-furnishing-bundle/0-alpha") errors.push("unsupported-furnishing-bundle");
  if (root !== await sha256(canonical(body))) errors.push("bundle-root-mismatch");
  if (!body.creator?.publicKey || !await verifyAction(body.publication, body.creator?.publicKey)) errors.push("publication-signature-invalid");
  if (body.publication?.payload?.furnishingRoot !== await sha256(canonical(body.furnishing))) errors.push("furnishing-root-mismatch");
  return { valid: errors.length === 0, errors };
}

export async function verifyPublicCredential(credential) {
  const identity = credential?.identity;
  if (credential?.protocol !== "greenways-public-credential/0-alpha" || !identity?.identityId || !identity?.publicKey) return false;
  return identity.keyId === await sha256(canonical(identity.publicKey));
}

export function encodeJson(value) {
  return decoder.decode(encoder.encode(JSON.stringify(value, null, 2)));
}
