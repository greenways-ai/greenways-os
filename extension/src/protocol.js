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
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]
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
    protocol: "greenways-action/1",
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
  const signature = new Uint8Array(await webCrypto().subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, privateKey, encoder.encode(canonical(body))
  ));
  return { ...body, root, signature: bytesToBase64Url(signature) };
}

export async function verifyAction(action, publicJwk) {
  const { root, signature, ...body } = action;
  if (root !== await sha256(canonical(body))) return false;
  const key = await webCrypto().subtle.importKey(
    "jwk", publicJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]
  );
  return webCrypto().subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, key,
    base64UrlToBytes(signature), encoder.encode(canonical(body))
  );
}

export async function includeAction(chainId, previous, action) {
  if (!action?.root || !action?.signature) throw new Error("Signed action required");
  const inclusion = {
    protocol: "greenways-personal-chain/1",
    chainId,
    sequence: (previous?.sequence ?? 0) + 1,
    previousHash: previous?.eventHash ?? ZERO_HASH,
    actionRoot: action.root,
    includedAt: new Date().toISOString()
  };
  return { ...inclusion, eventHash: await sha256(canonical(inclusion)) };
}

export async function verifyPersonalChain(inclusions) {
  let previous = null;
  for (const inclusion of inclusions) {
    const { eventHash, ...body } = inclusion;
    if (body.sequence !== (previous?.sequence ?? 0) + 1) return false;
    if (body.previousHash !== (previous?.eventHash ?? ZERO_HASH)) return false;
    if (eventHash !== await sha256(canonical(body))) return false;
    previous = inclusion;
  }
  return true;
}

export async function createEvidenceBundle({ identity, actions, inclusions, project }) {
  const bundle = {
    protocol: "greenways-evidence-bundle/1",
    id: randomId("bundle"),
    exportedAt: new Date().toISOString(),
    project,
    publicKeys: { [identity.keyId]: identity.publicKey },
    identities: [identity],
    actions,
    inclusions
  };
  return { ...bundle, root: await sha256(canonical(bundle)) };
}

export async function verifyEvidenceBundle(bundle) {
  const { root, ...body } = bundle;
  const errors = [];
  if (root !== await sha256(canonical(body))) errors.push("bundle-root-mismatch");
  if (!await verifyPersonalChain(bundle.inclusions ?? [])) errors.push("personal-chain-invalid");
  for (const action of bundle.actions ?? []) {
    const key = bundle.publicKeys?.[action.actor?.keyId];
    if (!key || !await verifyAction(action, key)) errors.push(`action-invalid:${action.id}`);
  }
  const actionRoots = new Set((bundle.actions ?? []).map((action) => action.root));
  for (const inclusion of bundle.inclusions ?? []) {
    if (!actionRoots.has(inclusion.actionRoot)) errors.push(`action-missing:${inclusion.actionRoot}`);
  }
  return { valid: errors.length === 0, errors };
}

export async function createFurnishingBundle({ identity, privateKey, title, ideas = [], repositories = [], parents = [], visibility = "personal" }) {
  if (!["personal", "shared"].includes(visibility)) throw new Error("Furnishing visibility must be personal or shared");
  const furnishing = {
    protocol: "greenways-room-furnishing/1",
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
  const body = { protocol: "greenways-furnishing-bundle/1", furnishing, creator: identity, publication };
  return { ...body, root: await sha256(canonical(body)) };
}

export async function verifyFurnishingBundle(bundle) {
  const { root, ...body } = bundle ?? {};
  const errors = [];
  if (body.protocol !== "greenways-furnishing-bundle/1") errors.push("unsupported-furnishing-bundle");
  if (root !== await sha256(canonical(body))) errors.push("bundle-root-mismatch");
  if (!body.creator?.publicKey || !await verifyAction(body.publication, body.creator?.publicKey)) errors.push("publication-signature-invalid");
  if (body.publication?.payload?.furnishingRoot !== await sha256(canonical(body.furnishing))) errors.push("furnishing-root-mismatch");
  return { valid: errors.length === 0, errors };
}

export async function verifyPublicCredential(credential) {
  const identity = credential?.identity;
  if (credential?.protocol !== "greenways-public-credential/1" || !identity?.identityId || !identity?.publicKey) return false;
  return identity.keyId === await sha256(canonical(identity.publicKey));
}

export function encodeJson(value) {
  return decoder.decode(encoder.encode(JSON.stringify(value, null, 2)));
}
