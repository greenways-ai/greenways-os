export const SYNC_ENTRY_PROTOCOL = "greenways-sync-entry/1";
export const SYNC_BATCH_PROTOCOL = "greenways-sync/1";
const ZERO_HASH = `sha256:${"0".repeat(64)}`;

export function createSyncEntry(action, inclusion) {
  if (!action || typeof action !== "object" || Array.isArray(action)
    || action.protocol !== "greenways-action/1"
    || typeof action.id !== "string" || !action.id
    || typeof action.root !== "string" || !action.root
    || typeof action.signature !== "string" || !action.signature) {
    throw new Error("Hestia sync requires a signed Greenways action");
  }
  if (!inclusion || typeof inclusion !== "object" || Array.isArray(inclusion)
    || inclusion.protocol !== "greenways-personal-chain/1"
    || typeof inclusion.chainId !== "string" || !inclusion.chainId
    || typeof inclusion.keyId !== "string" || !inclusion.keyId
    || !Number.isSafeInteger(inclusion.sequence) || inclusion.sequence < 1
    || typeof inclusion.previousHash !== "string" || !inclusion.previousHash
    || typeof inclusion.eventHash !== "string" || !inclusion.eventHash
    || typeof inclusion.signature !== "string" || !inclusion.signature) {
    throw new Error("Hestia sync requires a signed personal-chain inclusion");
  }
  if (inclusion.actionRoot !== action.root) {
    throw new Error("Hestia sync inclusion does not name its action");
  }
  return { protocol: SYNC_ENTRY_PROTOCOL, action, inclusion };
}

export function validateSyncEntry(entry, index = 0) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)
    || entry.protocol !== SYNC_ENTRY_PROTOCOL) {
    throw new Error(`Hestia sync entry ${index} has an unsupported protocol`);
  }
  createSyncEntry(entry.action, entry.inclusion);
  return entry;
}

export function orderSyncEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("Hestia sync requires a signed entry batch");
  const ordered = entries.map((entry, index) => validateSyncEntry(entry, index))
    .sort((left, right) => left.inclusion.sequence - right.inclusion.sequence);
  const eventHashes = new Set();
  const actionRoots = new Set();
  for (const [index, entry] of ordered.entries()) {
    const inclusion = entry.inclusion;
    if (eventHashes.has(inclusion.eventHash) || actionRoots.has(entry.action.root)) {
      throw new Error("Hestia sync batch contains duplicate records");
    }
    eventHashes.add(inclusion.eventHash);
    actionRoots.add(entry.action.root);
    if (index === 0) continue;
    const previous = ordered[index - 1].inclusion;
    if (inclusion.chainId !== previous.chainId || inclusion.keyId !== previous.keyId
      || inclusion.sequence !== previous.sequence + 1
      || inclusion.previousHash !== previous.eventHash) {
      throw new Error("Hestia sync batch is not one contiguous personal-chain segment");
    }
  }
  if (ordered[0]?.inclusion.sequence === 1
    && ordered[0].inclusion.previousHash !== ZERO_HASH) {
    throw new Error("The first Hestia chain inclusion must start at the zero hash");
  }
  return ordered;
}
