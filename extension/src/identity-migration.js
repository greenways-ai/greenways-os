import {
  ZERO_HASH,
  actionBody,
  canonical,
  includeAction,
  sha256,
  signAction,
  verifyAction,
  verifyPersonalChain,
} from "./protocol.js";
import { createSyncEntry, validateSyncEntry } from "./sync-protocol.js";

const LEGACY_INCLUSION_KEYS = Object.freeze([
  "actionRoot",
  "chainId",
  "eventHash",
  "includedAt",
  "previousHash",
  "protocol",
  "sequence",
]);
const CURRENT_INCLUSION_KEYS = Object.freeze([
  "actionRoot",
  "chainId",
  "eventHash",
  "includedAt",
  "keyId",
  "previousHash",
  "protocol",
  "sequence",
  "signature",
]);
const ACTION_KEYS = Object.freeze([
  "actor",
  "createdAt",
  "id",
  "payload",
  "protocol",
  "root",
  "signature",
  "subject",
  "type",
  "workflowRoot",
]);
const ACTOR_KEYS = Object.freeze(["handle", "identityId", "keyId"]);

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ACTION_ID_PATTERN = /^action\/[A-Za-z0-9_-]{22}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]+$/;
const HANDLE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$/;
const KEY_ALGORITHM = Object.freeze({ name: "ECDSA", namedCurve: "P-256" });
const SIGN_ALGORITHM = Object.freeze({ name: "ECDSA", hash: "SHA-256" });
const KEY_CHALLENGE = new TextEncoder().encode("greenways-identity-migration/1");

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireRepository(repository) {
  record(repository, "Identity migration repository");
  for (const method of ["get", "values", "replacePersonalChain"]) {
    if (typeof repository[method] !== "function") {
      throw new TypeError(`Identity migration repository requires ${method}()`);
    }
  }
  return repository;
}

function sameRecord(left, right) {
  return canonical(left) === canonical(right);
}

function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isoTimestamp(value) {
  if (typeof value !== "string" || !value) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function jsonValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => jsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Object.values(value).every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function validActionSchema(action, identity) {
  return exactKeys(action, ACTION_KEYS)
    && action.protocol === "greenways-action/1"
    && ACTION_ID_PATTERN.test(action.id ?? "")
    && typeof action.type === "string" && action.type.startsWith("@greenways/")
    && exactKeys(action.actor ?? {}, ACTOR_KEYS)
    && action.actor.identityId === identity.identityId
    && typeof action.actor.handle === "string" && action.actor.handle === identity.handle
    && action.actor.keyId === identity.keyId
    && (action.workflowRoot === null || HASH_PATTERN.test(action.workflowRoot ?? ""))
    && (action.subject === null || (typeof action.subject === "string" && Boolean(action.subject)))
    && jsonValue(action.payload) && !Array.isArray(action.payload) && action.payload !== null
    && isoTimestamp(action.createdAt)
    && HASH_PATTERN.test(action.root ?? "")
    && SIGNATURE_PATTERN.test(action.signature ?? "");
}

function assertP256PrivateKey(privateKey) {
  if (!privateKey || privateKey.type !== "private"
    || privateKey.algorithm?.name !== "ECDSA"
    || privateKey.algorithm?.namedCurve !== "P-256"
    || !privateKey.usages?.includes("sign")
    || typeof privateKey.extractable !== "boolean") {
    throw new Error("Stored identity controller is not a signing P-256 private CryptoKey");
  }
}

async function keyMatchesIdentity(privateKey, identity) {
  try {
    const publicKey = await globalThis.crypto.subtle.importKey(
      "jwk",
      identity.publicKey,
      KEY_ALGORITHM,
      false,
      ["verify"],
    );
    const signature = await globalThis.crypto.subtle.sign(
      SIGN_ALGORITHM,
      privateKey,
      KEY_CHALLENGE,
    );
    return globalThis.crypto.subtle.verify(
      SIGN_ALGORITHM,
      publicKey,
      signature,
      KEY_CHALLENGE,
    );
  } catch {
    return false;
  }
}

async function validateAndHardenIdentity(identityRecord) {
  record(identityRecord, "Stored owner identity");
  const identity = record(identityRecord.identity, "Stored owner identity card");
  const privateKey = identityRecord.privateKey;
  if (identity.type !== "GreenwaysIdentityCard" || identity.version !== 1
    || identity.algorithm !== "ECDSA-P256-SHA256"
    || typeof identity.identityId !== "string" || !identity.identityId.trim()
    || !HANDLE_PATTERN.test(identity.handle ?? "")
    || !HASH_PATTERN.test(identity.keyId ?? "")
    || !isoTimestamp(identity.createdAt)
    || identity.publicKey?.kty !== "EC" || identity.publicKey?.crv !== "P-256") {
    throw new Error("Stored owner identity card is invalid");
  }
  if (identity.keyId !== await sha256(canonical(identity.publicKey))) {
    throw new Error("Stored owner identity key ID does not match its public key");
  }
  assertP256PrivateKey(privateKey);

  let hardenedPrivateKey = privateKey;
  if (privateKey.extractable) {
    let privateJwk;
    try {
      privateJwk = await globalThis.crypto.subtle.exportKey("jwk", privateKey);
    } catch {
      throw new Error("Extractable identity controller could not be exported for hardening");
    }
    if (privateJwk.kty !== identity.publicKey.kty
      || privateJwk.crv !== identity.publicKey.crv
      || privateJwk.x !== identity.publicKey.x
      || privateJwk.y !== identity.publicKey.y) {
      throw new Error("Stored identity private key does not match its public key");
    }
    try {
      hardenedPrivateKey = await globalThis.crypto.subtle.importKey(
        "jwk",
        privateJwk,
        KEY_ALGORITHM,
        false,
        ["sign"],
      );
    } catch {
      throw new Error("Stored identity controller could not be hardened");
    }
  }

  if (!await keyMatchesIdentity(hardenedPrivateKey, identity)) {
    throw new Error("Stored identity private key does not match its public key");
  }
  if (hardenedPrivateKey.extractable) {
    throw new Error("Stored identity controller remained extractable after hardening");
  }
  return {
    identity,
    identityRecord: { ...identityRecord, privateKey: hardenedPrivateKey },
    privateKey: hardenedPrivateKey,
    privateKeyHardened: privateKey.extractable,
  };
}

async function validatedActions(values, identity) {
  if (!Array.isArray(values)) throw new Error("Stored actions must be an array");
  const byRoot = new Map();
  const ids = new Set();
  for (const [index, value] of values.entries()) {
    const action = record(value, `Stored action ${index}`);
    if (!validActionSchema(action, identity)) {
      throw new Error(`Stored action ${index} has an invalid owner-controlled action schema`);
    }
    if (ids.has(action.id) || byRoot.has(action.root)) {
      throw new Error("Stored actions contain duplicate identifiers or roots");
    }
    let valid = false;
    try {
      valid = await verifyAction(action, identity.publicKey);
    } catch {
      valid = false;
    }
    if (!valid) throw new Error(`Stored action ${index} has an invalid root or signature`);
    ids.add(action.id);
    byRoot.set(action.root, action);
  }
  return byRoot;
}

function inclusionKind(inclusion) {
  record(inclusion, "Stored personal-chain inclusion");
  const signed = Object.hasOwn(inclusion, "signature");
  const keyed = Object.hasOwn(inclusion, "keyId");
  if (!signed && !keyed) return "legacy";
  if (signed && keyed) return "current";
  throw new Error("Stored personal-chain inclusion mixes legacy and signed fields");
}

function detectInclusionKind(inclusions) {
  if (!Array.isArray(inclusions)) throw new Error("Stored personal-chain inclusions must be an array");
  if (!inclusions.length) return "empty";
  const kinds = new Set(inclusions.map(inclusionKind));
  if (kinds.size !== 1) throw new Error("Stored personal chain mixes legacy and signed inclusions");
  return kinds.values().next().value;
}

async function validateLegacyInclusions(values, identity, actionsByRoot) {
  const inclusions = [...values].sort((left, right) => left.sequence - right.sequence);
  let previous = null;
  const actionRoots = new Set();
  for (const [index, inclusion] of inclusions.entries()) {
    if (!exactKeys(inclusion, LEGACY_INCLUSION_KEYS)
      || inclusion.protocol !== "greenways-personal-chain/1"
      || inclusion.chainId !== identity.identityId
      || !Number.isSafeInteger(inclusion.sequence) || inclusion.sequence < 1
      || !HASH_PATTERN.test(inclusion.previousHash ?? "")
      || !HASH_PATTERN.test(inclusion.actionRoot ?? "")
      || !HASH_PATTERN.test(inclusion.eventHash ?? "")
      || !isoTimestamp(inclusion.includedAt)) {
      throw new Error(`Legacy personal-chain inclusion ${index} has an invalid schema`);
    }
    if (inclusion.sequence !== (previous?.sequence ?? 0) + 1
      || inclusion.previousHash !== (previous?.eventHash ?? ZERO_HASH)) {
      throw new Error(`Legacy personal-chain inclusion ${index} breaks chain continuity`);
    }
    const { eventHash, ...body } = inclusion;
    if (eventHash !== await sha256(canonical(body))) {
      throw new Error(`Legacy personal-chain inclusion ${index} has an invalid event hash`);
    }
    if (!actionsByRoot.has(inclusion.actionRoot) || actionRoots.has(inclusion.actionRoot)) {
      throw new Error(`Legacy personal-chain inclusion ${index} does not name one unique stored action`);
    }
    actionRoots.add(inclusion.actionRoot);
    previous = inclusion;
  }
  if (actionRoots.size !== actionsByRoot.size) {
    throw new Error("Stored actions and legacy personal-chain inclusions do not correspond exactly");
  }
  return inclusions;
}

async function validateCurrentInclusions(values, identity, actionsByRoot) {
  const inclusions = [...values].sort((left, right) => left.sequence - right.sequence);
  for (const [index, inclusion] of inclusions.entries()) {
    if (!exactKeys(inclusion, CURRENT_INCLUSION_KEYS)
      || inclusion.protocol !== "greenways-personal-chain/1"
      || inclusion.chainId !== identity.identityId
      || inclusion.keyId !== identity.keyId
      || !Number.isSafeInteger(inclusion.sequence) || inclusion.sequence < 1
      || !HASH_PATTERN.test(inclusion.previousHash ?? "")
      || !HASH_PATTERN.test(inclusion.actionRoot ?? "")
      || !HASH_PATTERN.test(inclusion.eventHash ?? "")
      || !SIGNATURE_PATTERN.test(inclusion.signature ?? "")
      || !isoTimestamp(inclusion.includedAt)) {
      throw new Error(`Signed personal-chain inclusion ${index} has an invalid owner-bound schema`);
    }
  }
  if (!await verifyPersonalChain(inclusions, { [identity.keyId]: identity.publicKey })) {
    throw new Error("Stored signed personal chain is invalid");
  }
  const actionRoots = new Set();
  for (const [index, inclusion] of inclusions.entries()) {
    if (!actionsByRoot.has(inclusion.actionRoot) || actionRoots.has(inclusion.actionRoot)) {
      throw new Error(`Signed personal-chain inclusion ${index} does not name one unique stored action`);
    }
    actionRoots.add(inclusion.actionRoot);
  }
  if (actionRoots.size !== actionsByRoot.size) {
    throw new Error("Stored actions and signed personal-chain inclusions do not correspond exactly");
  }
  return inclusions;
}

async function legacyPendingRoots(outbox, actionsByRoot, inclusionRoots, identity) {
  if (!Array.isArray(outbox)) throw new Error("Stored outbox must be an array");
  const roots = [];
  const seen = new Set();
  for (const [index, value] of outbox.entries()) {
    const action = record(value, `Legacy outbox entry ${index}`);
    const stored = actionsByRoot.get(action.root);
    if (!stored || !inclusionRoots.has(action.root) || !sameRecord(action, stored)
      || action.actor?.identityId !== identity.identityId
      || action.actor?.keyId !== identity.keyId
      || !await verifyAction(action, identity.publicKey)
      || seen.has(action.root)) {
      throw new Error(`Legacy outbox entry ${index} is not one unique validated pending action`);
    }
    seen.add(action.root);
    roots.push(action.root);
  }
  return roots;
}

function currentOutbox(outbox, actionsByRoot, inclusions) {
  if (!Array.isArray(outbox)) throw new Error("Stored outbox must be an array");
  const inclusionsByHash = new Map(inclusions.map((inclusion) => [inclusion.eventHash, inclusion]));
  const seen = new Set();
  return outbox.map((value, index) => {
    let entry;
    try {
      entry = validateSyncEntry(value, index);
    } catch {
      throw new Error(`Signed outbox entry ${index} is invalid`);
    }
    const storedAction = actionsByRoot.get(entry.action.root);
    const storedInclusion = inclusionsByHash.get(entry.inclusion.eventHash);
    if (!storedAction || !storedInclusion
      || !sameRecord(entry.action, storedAction)
      || !sameRecord(entry.inclusion, storedInclusion)
      || seen.has(entry.action.root)) {
      throw new Error(`Signed outbox entry ${index} does not match one unique stored record`);
    }
    seen.add(entry.action.root);
    return entry;
  });
}

async function rebuildInclusions(identity, privateKey, legacyInclusions, actionsByRoot) {
  const inclusions = [];
  let previous = null;
  for (const legacy of legacyInclusions) {
    const inclusion = await includeAction(
      identity,
      privateKey,
      previous,
      actionsByRoot.get(legacy.actionRoot),
    );
    inclusions.push(inclusion);
    previous = inclusion;
  }
  return inclusions;
}

async function validatedMigrationHistory(identityRecord, identity) {
  const history = identityRecord.personalChainMigrations ?? [];
  if (!Array.isArray(history)) throw new Error("Stored personal-chain migration history is invalid");
  for (const [index, migration] of history.entries()) {
    if (!migration || !validActionSchema(migration, identity)
      || migration.type !== "@greenways/personal-chain-migrated"
      || migration.subject !== identity.identityId
      || migration.payload?.protocol !== "greenways-personal-chain-migration/1"
      || migration.payload.fromProtocol !== "greenways-personal-chain/1-unsigned"
      || migration.payload.toProtocol !== "greenways-personal-chain/1"
      || !HASH_PATTERN.test(migration.payload.legacyHead ?? "")
      || !HASH_PATTERN.test(migration.payload.signedHead ?? "")
      || !Array.isArray(migration.payload.mappings)
      || !Array.isArray(migration.payload.previouslyPendingRoots)
      || !await verifyAction(migration, identity.publicKey)) {
      throw new Error(`Stored personal-chain migration record ${index} is invalid`);
    }
  }
  return history;
}

function validateMigrationHistoryLinkage(history, inclusions) {
  for (const [historyIndex, migration] of history.entries()) {
    const mappings = migration.payload.mappings;
    const mappedRoots = new Set();
    for (const [index, mapping] of mappings.entries()) {
      const inclusion = inclusions[index];
      if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)
        || !Number.isSafeInteger(mapping.sequence) || mapping.sequence !== index + 1
        || !HASH_PATTERN.test(mapping.actionRoot ?? "")
        || !HASH_PATTERN.test(mapping.legacyEventHash ?? "")
        || !HASH_PATTERN.test(mapping.signedEventHash ?? "")
        || inclusion?.sequence !== mapping.sequence
        || inclusion?.actionRoot !== mapping.actionRoot
        || inclusion?.eventHash !== mapping.signedEventHash
        || mappedRoots.has(mapping.actionRoot)) {
        throw new Error(`Stored personal-chain migration record ${historyIndex} is not linked to the signed chain`);
      }
      mappedRoots.add(mapping.actionRoot);
    }
    if (!mappings.length
      || migration.payload.legacyHead !== mappings.at(-1).legacyEventHash
      || migration.payload.signedHead !== mappings.at(-1).signedEventHash
      || new Set(migration.payload.previouslyPendingRoots).size
        !== migration.payload.previouslyPendingRoots.length
      || migration.payload.previouslyPendingRoots.some((root) => !mappedRoots.has(root))) {
      throw new Error(`Stored personal-chain migration record ${historyIndex} has invalid continuity metadata`);
    }
  }
}

async function createMigrationRecord({
  identity,
  privateKey,
  legacyInclusions,
  signedInclusions,
  previouslyPendingRoots,
}) {
  const mappings = legacyInclusions.map((legacy, index) => ({
    sequence: legacy.sequence,
    actionRoot: legacy.actionRoot,
    legacyEventHash: legacy.eventHash,
    signedEventHash: signedInclusions[index].eventHash,
  }));
  return signAction(actionBody({
    type: "@greenways/personal-chain-migrated",
    actor: identity,
    subject: identity.identityId,
    payload: {
      protocol: "greenways-personal-chain-migration/1",
      fromProtocol: "greenways-personal-chain/1-unsigned",
      toProtocol: "greenways-personal-chain/1",
      legacyHead: legacyInclusions.at(-1)?.eventHash ?? ZERO_HASH,
      signedHead: signedInclusions.at(-1)?.eventHash ?? ZERO_HASH,
      mappings,
      previouslyPendingRoots,
    },
  }), privateKey);
}

export async function migrateLegacyIdentityAndPersonalChain(injectedRepository) {
  const repository = requireRepository(injectedRepository);
  const [storedIdentity, actions, inclusions, outbox] = await Promise.all([
    repository.get("identity", "owner"),
    repository.values("actions"),
    repository.values("inclusions"),
    repository.values("outbox"),
  ]);

  if (!Array.isArray(actions) || !Array.isArray(inclusions) || !Array.isArray(outbox)) {
    throw new Error("Identity migration repository values must be arrays");
  }

  if (storedIdentity == null) {
    if (actions.length || inclusions.length || outbox.length) {
      throw new Error("Personal-chain records exist without an owner identity");
    }
    return { migrated: false, reason: "identity-absent" };
  }

  const hardened = await validateAndHardenIdentity(storedIdentity);
  const migrationHistory = await validatedMigrationHistory(storedIdentity, hardened.identity);
  const actionsByRoot = await validatedActions(actions, hardened.identity);
  const kind = detectInclusionKind(inclusions);

  if (kind === "current") {
    const currentInclusions = await validateCurrentInclusions(
      inclusions,
      hardened.identity,
      actionsByRoot,
    );
    validateMigrationHistoryLinkage(migrationHistory, currentInclusions);
    const preservedOutbox = currentOutbox(outbox, actionsByRoot, currentInclusions);
    if (!hardened.privateKeyHardened) {
      return { migrated: false, reason: "current" };
    }
    await repository.replacePersonalChain({
      identityRecord: hardened.identityRecord,
      inclusions: currentInclusions,
      outbox: preservedOutbox,
    });
    return {
      migrated: true,
      privateKeyHardened: true,
      inclusionCount: currentInclusions.length,
      queuedRoots: preservedOutbox.map((entry) => entry.action.root),
    };
  }

  if (kind === "empty") {
    validateMigrationHistoryLinkage(migrationHistory, []);
    if (actionsByRoot.size || outbox.length) {
      throw new Error("Actions or pending outbox entries exist without personal-chain inclusions");
    }
    if (!hardened.privateKeyHardened) {
      return { migrated: false, reason: "current" };
    }
    await repository.replacePersonalChain({
      identityRecord: hardened.identityRecord,
      inclusions: [],
      outbox: [],
    });
    return {
      migrated: true,
      privateKeyHardened: true,
      inclusionCount: 0,
      queuedRoots: [],
    };
  }

  const legacyInclusions = await validateLegacyInclusions(
    inclusions,
    hardened.identity,
    actionsByRoot,
  );
  if (migrationHistory.length) {
    throw new Error("Legacy personal chain already has signed migration history");
  }
  const inclusionRoots = new Set(legacyInclusions.map((inclusion) => inclusion.actionRoot));
  const pendingRoots = await legacyPendingRoots(
    outbox,
    actionsByRoot,
    inclusionRoots,
    hardened.identity,
  );
  const signedInclusions = await rebuildInclusions(
    hardened.identity,
    hardened.privateKey,
    legacyInclusions,
    actionsByRoot,
  );
  const migrationRecord = await createMigrationRecord({
    identity: hardened.identity,
    privateKey: hardened.privateKey,
    legacyInclusions,
    signedInclusions,
    previouslyPendingRoots: pendingRoots,
  });
  const migratedIdentityRecord = {
    ...hardened.identityRecord,
    personalChainMigrations: [migrationRecord],
  };
  const signedOutbox = signedInclusions.map((inclusion) => (
    createSyncEntry(actionsByRoot.get(inclusion.actionRoot), inclusion)
  ));

  await repository.replacePersonalChain({
    identityRecord: migratedIdentityRecord,
    inclusions: signedInclusions,
    outbox: signedOutbox,
  });
  return {
    migrated: true,
    privateKeyHardened: hardened.privateKeyHardened,
    inclusionCount: signedInclusions.length,
    queuedRoots: signedOutbox.map((entry) => entry.action.root),
    previouslyPendingRoots: pendingRoots,
  };
}
