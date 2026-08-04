const DATABASE = "greenways-os-v1";
const VERSION = 2;
const STORES = ["settings", "identity", "projects", "actions", "inclusions", "outbox", "apps"];

export function withOriginLock(name, operation, locks = globalThis.navigator?.locks) {
  if (typeof name !== "string" || !name) throw new TypeError("Origin lock requires a name");
  if (typeof operation !== "function") throw new TypeError("Origin lock requires an operation");
  if (!locks?.request) return operation();
  return locks.request(`greenways-os:${name}`, { mode: "exclusive" }, operation);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function databaseTransaction(storeNames, mode, operation) {
  const database = await openDatabase();
  try {
    const tx = database.transaction(storeNames, mode);
    const completion = new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const settled = completion.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    try {
      const result = await operation(tx);
      const outcome = await settled;
      if (!outcome.ok) throw outcome.error;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        // The transaction already completed or aborted.
      }
      await settled;
      throw error;
    }
  } finally {
    database.close();
  }
}

function transaction(storeName, mode, operation) {
  return databaseTransaction(storeName, mode, (tx) => operation(tx.objectStore(storeName)));
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function replaceStoreEntries(target, entries) {
  if (!Array.isArray(entries)) throw new TypeError("Replacement entries must be an array");
  const requests = [target.clear()];
  for (const [key, value] of entries) requests.push(target.put(value, key));
  return Promise.all(requests.map(requestValue));
}

export function deleteStoreEntries(target, keys) {
  if (!Array.isArray(keys)) throw new TypeError("Deleted entry keys must be an array");
  return Promise.all(keys.map((key) => requestValue(target.delete(key))));
}

export function putSignedRecordStores(tx, action, inclusion) {
  if (!action?.id || !action?.root || !inclusion?.eventHash) {
    throw new Error("Signed record storage requires action and inclusion identifiers");
  }
  return Promise.all([
    requestValue(tx.objectStore("actions").put(action, action.id)),
    requestValue(tx.objectStore("inclusions").put(inclusion, inclusion.eventHash)),
    requestValue(tx.objectStore("outbox").put(action, action.root)),
  ]);
}

export const store = {
  get: (name, key) => transaction(name, "readonly", (value) => requestValue(value.get(key))),
  put: (name, key, value) => transaction(name, "readwrite", (target) => requestValue(target.put(value, key))),
  delete: (name, key) => transaction(name, "readwrite", (target) => requestValue(target.delete(key))),
  deleteMany: (name, keys) => transaction(
    name,
    "readwrite",
    (target) => deleteStoreEntries(target, keys),
  ),
  values: (name) => transaction(name, "readonly", (target) => requestValue(target.getAll())),
  replace: (name, entries) => transaction(
    name,
    "readwrite",
    (target) => replaceStoreEntries(target, entries),
  ),
  putSignedRecord: (action, inclusion) => databaseTransaction(
    ["actions", "inclusions", "outbox"],
    "readwrite",
    (tx) => putSignedRecordStores(tx, action, inclusion),
  ),
};
