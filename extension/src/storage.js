const DATABASE = "greenways-os-v1";
const VERSION = 1;
const STORES = ["settings", "identity", "projects", "actions", "inclusions", "outbox"];

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

async function transaction(storeName, mode, operation) {
  const database = await openDatabase();
  try {
    const tx = database.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = await operation(store);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return result;
  } finally {
    database.close();
  }
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export const store = {
  get: (name, key) => transaction(name, "readonly", (value) => requestValue(value.get(key))),
  put: (name, key, value) => transaction(name, "readwrite", (target) => requestValue(target.put(value, key))),
  delete: (name, key) => transaction(name, "readwrite", (target) => requestValue(target.delete(key))),
  values: (name) => transaction(name, "readonly", (target) => requestValue(target.getAll()))
};
