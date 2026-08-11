import { createSyncEntry, validateSyncEntry } from "./sync-protocol.js";

const DATABASE = "greenways-os-v1";
export const DATABASE_VERSION = 8;
export const DATABASE_STORES = Object.freeze([
  "settings",
  "identity",
  "projects",
  "actions",
  "inclusions",
  "outbox",
  "apps",
  "modules",
  "grants",
  "kernel",
  "userscripts",
  "chats",
  "modelSessions",
  "fabric",
]);

export const KERNEL_GLOBAL_KEY = "global";

function recordId(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function envelope(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

export function kernelContextKey(contextId) {
  return `context:${recordId(contextId, "Kernel context id")}`;
}

export function kernelRequestKey(requestId) {
  return `request:${recordId(requestId, "Kernel request id")}`;
}

export function withOriginLock(name, operation, locks = globalThis.navigator?.locks) {
  if (typeof name !== "string" || !name) throw new TypeError("Origin lock requires a name");
  if (typeof operation !== "function") throw new TypeError("Origin lock requires an operation");
  if (!locks?.request) return operation();
  return locks.request(`greenways-os:${name}`, { mode: "exclusive" }, operation);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      for (const name of DATABASE_STORES) {
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
  const syncEntry = createSyncEntry(action, inclusion);
  return Promise.all([
    requestValue(tx.objectStore("actions").put(action, action.id)),
    requestValue(tx.objectStore("inclusions").put(inclusion, inclusion.eventHash)),
    requestValue(tx.objectStore("outbox").put(syncEntry, inclusion.eventHash)),
  ]);
}

export function replacePersonalChainStores(tx, change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) {
    throw new TypeError("Personal-chain replacement must be an object");
  }
  const { identityRecord, inclusions, outbox } = change;
  if (!identityRecord?.identity?.identityId || !identityRecord.privateKey) {
    throw new Error("Personal-chain replacement requires its owner identity");
  }
  if (!Array.isArray(inclusions) || !Array.isArray(outbox)) {
    throw new TypeError("Personal-chain replacement records must be arrays");
  }
  const inclusionEntries = inclusions.map((inclusion, index) => {
    const eventHash = recordId(inclusion?.eventHash, `Personal-chain inclusion ${index} hash`);
    return [eventHash, inclusion];
  });
  const outboxEntries = outbox.map((entry, index) => {
    validateSyncEntry(entry, index);
    return [entry.inclusion.eventHash, entry];
  });
  if (new Set(inclusionEntries.map(([key]) => key)).size !== inclusionEntries.length
    || new Set(outboxEntries.map(([key]) => key)).size !== outboxEntries.length) {
    throw new Error("Personal-chain replacement contains duplicate record hashes");
  }
  return Promise.all([
    requestValue(tx.objectStore("identity").put(identityRecord, "owner")),
    replaceStoreEntries(tx.objectStore("inclusions"), inclusionEntries),
    replaceStoreEntries(tx.objectStore("outbox"), outboxEntries),
  ]);
}

function appProjectionEntries(apps) {
  if (!Array.isArray(apps)) throw new TypeError("Kernel app projection must be an array");
  const seen = new Set();
  return apps.map((manifest, index) => {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new TypeError(`Kernel app projection entry ${index} must be an object`);
    }
    const appId = recordId(manifest.id, `Kernel app projection entry ${index} id`);
    if (seen.has(appId)) throw new Error(`Kernel app projection contains duplicate app id ${appId}`);
    seen.add(appId);
    return [appId, manifest];
  });
}

function moduleProjectionEntries(modules) {
  if (!Array.isArray(modules)) throw new TypeError("Kernel module projection must be an array");
  const seen = new Set();
  return modules.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError(`Kernel module projection entry ${index} must be an object`);
    }
    const moduleId = recordId(record.id, `Kernel module projection entry ${index} id`);
    if (seen.has(moduleId)) throw new Error(`Kernel module projection contains duplicate module id ${moduleId}`);
    seen.add(moduleId);
    return [moduleId, record];
  });
}

export function capabilityProjectionEntries(grants) {
  if (!Array.isArray(grants)) throw new TypeError("Kernel capability projection must be an array");
  const seen = new Set();
  return grants.map((grant, index) => {
    if (!grant || typeof grant !== "object" || Array.isArray(grant)) {
      throw new TypeError(`Kernel capability projection entry ${index} must be an object`);
    }
    const grantId = recordId(grant.id, `Kernel capability projection entry ${index} id`);
    if (seen.has(grantId)) throw new Error(`Kernel capability projection contains duplicate grant id ${grantId}`);
    seen.add(grantId);
    return [grantId, grant];
  });
}

export function putPreparedKernelRequest(target, requestId, requestEnvelope) {
  const key = kernelRequestKey(requestId);
  const value = envelope(requestEnvelope, "Kernel request envelope");
  return requestValue(target.put(value, key));
}

export function deletePreparedKernelRequest(target, requestId) {
  return requestValue(target.delete(kernelRequestKey(requestId)));
}

export async function commitKernelStores(tx, {
  requestId,
  contextId,
  globalEnvelope,
  contextEnvelope,
  apps,
  modules,
  grants,
}) {
  const pendingKey = kernelRequestKey(requestId);
  const contextKey = kernelContextKey(contextId);
  const globalValue = envelope(globalEnvelope, "Kernel global envelope");
  const contextValue = envelope(contextEnvelope, "Kernel context envelope");
  const appEntries = appProjectionEntries(apps);
  const moduleEntries = modules === undefined ? null : moduleProjectionEntries(modules);
  const grantEntries = grants === undefined ? null : capabilityProjectionEntries(grants);
  const kernel = tx.objectStore("kernel");
  const appStore = tx.objectStore("apps");
  const writes = [
    requestValue(kernel.put(globalValue, KERNEL_GLOBAL_KEY)),
    requestValue(kernel.put(contextValue, contextKey)),
    replaceStoreEntries(appStore, appEntries),
    requestValue(kernel.delete(pendingKey)),
  ];
  if (moduleEntries) writes.push(replaceStoreEntries(tx.objectStore("modules"), moduleEntries));
  if (grantEntries) writes.push(replaceStoreEntries(tx.objectStore("grants"), grantEntries));
  await Promise.all(writes);
}

export async function replaceKernelGlobalStores(tx, {
  globalEnvelope,
  apps,
  modules,
  grants,
}) {
  const globalValue = envelope(globalEnvelope, "Kernel global envelope");
  const appEntries = appProjectionEntries(apps);
  const moduleEntries = modules === undefined ? null : moduleProjectionEntries(modules);
  const grantEntries = grants === undefined ? null : capabilityProjectionEntries(grants);
  const writes = [
    requestValue(tx.objectStore("kernel").put(globalValue, KERNEL_GLOBAL_KEY)),
    replaceStoreEntries(tx.objectStore("apps"), appEntries),
  ];
  if (moduleEntries) writes.push(replaceStoreEntries(tx.objectStore("modules"), moduleEntries));
  if (grantEntries) writes.push(replaceStoreEntries(tx.objectStore("grants"), grantEntries));
  await Promise.all(writes);
}

export async function readKernelSnapshot(target, contextId) {
  const [globalEnvelope, contextEnvelope] = await Promise.all([
    requestValue(target.get(KERNEL_GLOBAL_KEY)),
    requestValue(target.get(kernelContextKey(contextId))),
  ]);
  return { globalEnvelope, contextEnvelope };
}

export function readPreparedKernelRequest(target, requestId) {
  return requestValue(target.get(kernelRequestKey(requestId)));
}

export function prepareKernelRequest(
  requestId,
  requestEnvelope,
  transact = databaseTransaction,
) {
  return transact("kernel", "readwrite", (tx) => (
    putPreparedKernelRequest(tx.objectStore("kernel"), requestId, requestEnvelope)
  ));
}

export function abortKernelRequest(requestId, transact = databaseTransaction) {
  return transact("kernel", "readwrite", (tx) => (
    deletePreparedKernelRequest(tx.objectStore("kernel"), requestId)
  ));
}

function kernelProjectionStores(change) {
  const stores = ["kernel", "apps"];
  if (change?.modules !== undefined) stores.push("modules");
  if (change?.grants !== undefined) stores.push("grants");
  return stores;
}

export function commitKernelTransition(change, transact = databaseTransaction) {
  return transact(kernelProjectionStores(change), "readwrite", (tx) => commitKernelStores(tx, change));
}

export function replaceKernelGlobal(change, transact = databaseTransaction) {
  return transact(kernelProjectionStores(change), "readwrite", (tx) => (
    replaceKernelGlobalStores(tx, change)
  ));
}

export function getKernelSnapshot(contextId, transact = databaseTransaction) {
  return transact("kernel", "readonly", (tx) => (
    readKernelSnapshot(tx.objectStore("kernel"), contextId)
  ));
}

export function getKernelRequest(requestId, transact = databaseTransaction) {
  return transact("kernel", "readonly", (tx) => (
    readPreparedKernelRequest(tx.objectStore("kernel"), requestId)
  ));
}

export const kernelStore = Object.freeze({
  prepareRequest: prepareKernelRequest,
  abortRequest: abortKernelRequest,
  commit: commitKernelTransition,
  getSnapshot: getKernelSnapshot,
  getRequest: getKernelRequest,
  replaceGlobal: replaceKernelGlobal,
});

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
  entries: (name) => transaction(name, "readonly", async (target) => {
    const [keys, values] = await Promise.all([
      requestValue(target.getAllKeys()),
      requestValue(target.getAll()),
    ]);
    return keys.map((key, index) => [key, values[index]]);
  }),
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
  replacePersonalChain: (change) => databaseTransaction(
    ["identity", "inclusions", "outbox"],
    "readwrite",
    (tx) => replacePersonalChainStores(tx, change),
  ),
};


export const moduleStore = Object.freeze({
  get: (id) => store.get("modules", recordId(id, "Module id")),
  put: (record) => {
    const value = envelope(record, "Module record");
    return store.put("modules", recordId(value.id, "Module record id"), value);
  },
  delete: (id) => store.delete("modules", recordId(id, "Module id")),
  values: () => store.values("modules"),
  replace: (records) => store.replace("modules", moduleProjectionEntries(records)),
});


export const capabilityStore = Object.freeze({
  get: (id) => store.get("grants", recordId(id, "Capability grant id")),
  put: (grant) => {
    const value = envelope(grant, "Capability grant");
    return store.put("grants", recordId(value.id, "Capability grant id"), value);
  },
  delete: (id) => store.delete("grants", recordId(id, "Capability grant id")),
  values: () => store.values("grants"),
  replace: (grants) => store.replace("grants", capabilityProjectionEntries(grants)),
});

function userscriptProjectionEntries(records) {
  if (!Array.isArray(records)) throw new TypeError("Userscript projection must be an array");
  const seen = new Set();
  return records.map((record, index) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError(`Userscript projection entry ${index} must be an object`);
    }
    const scriptId = recordId(record.id, `Userscript projection entry ${index} id`);
    if (seen.has(scriptId)) throw new Error(`Userscript projection contains duplicate script id ${scriptId}`);
    seen.add(scriptId);
    return [scriptId, record];
  });
}

export const userscriptStore = Object.freeze({
  get: (id) => store.get("userscripts", recordId(id, "Userscript id")),
  put: (record) => {
    const value = envelope(record, "Userscript record");
    return store.put("userscripts", recordId(value.id, "Userscript record id"), value);
  },
  delete: (id) => store.delete("userscripts", recordId(id, "Userscript id")),
  values: () => store.values("userscripts"),
  replace: (records) => store.replace("userscripts", userscriptProjectionEntries(records)),
});

function chatProjectionEntries(records) {
  if (!Array.isArray(records)) throw new TypeError("Chat projection must be an array");
  const seen = new Set();
  return records.map((record, index) => {
    const value = envelope(record, `Chat projection entry ${index}`);
    const id = recordId(value.id, `Chat projection entry ${index} id`);
    if (seen.has(id)) throw new Error(`Chat projection contains duplicate id ${id}`);
    seen.add(id);
    return [id, value];
  });
}

export const chatStore = Object.freeze({
  get: (id) => store.get("chats", recordId(id, "Chat id")),
  put: (record) => {
    const value = envelope(record, "Chat record");
    return store.put("chats", recordId(value.id, "Chat record id"), value);
  },
  delete: (id) => store.delete("chats", recordId(id, "Chat id")),
  values: () => store.values("chats"),
  replace: (records) => store.replace("chats", chatProjectionEntries(records)),
});

function modelSessionProjectionEntries(records) {
  if (!Array.isArray(records)) throw new TypeError("Model-session projection must be an array");
  const seen = new Set();
  return records.map((record, index) => {
    const value = envelope(record, `Model-session projection entry ${index}`);
    const id = recordId(value.id, `Model-session projection entry ${index} id`);
    if (seen.has(id)) throw new Error(`Model-session projection contains duplicate id ${id}`);
    seen.add(id);
    return [id, value];
  });
}

export const modelSessionStore = Object.freeze({
  get: (id) => store.get("modelSessions", recordId(id, "Model session id")),
  put: (record) => {
    const value = envelope(record, "Model session record");
    return store.put("modelSessions", recordId(value.id, "Model session record id"), value);
  },
  delete: (id) => store.delete("modelSessions", recordId(id, "Model session id")),
  values: () => store.values("modelSessions"),
  replace: (records) => store.replace("modelSessions", modelSessionProjectionEntries(records)),
});

export const fabricStore = Object.freeze({
  get: (id) => store.get("fabric", recordId(id, "Fabric record id")),
  put: (record) => {
    const value = envelope(record, "Fabric record");
    return store.put("fabric", recordId(value.id, "Fabric record id"), value);
  },
  delete: (id) => store.delete("fabric", recordId(id, "Fabric record id")),
  values: () => store.values("fabric"),
});
