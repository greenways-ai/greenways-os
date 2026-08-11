import { sha256 } from "./protocol.js";
import { userscriptStore } from "./storage.js";
import {
  USERSCRIPT_LIMITS,
  validateUserscriptCollection,
  validateUserscriptRecord,
} from "./userscripts-store.js";

export {
  USERSCRIPTS_APP_ID,
  USERSCRIPTS_CAPABILITY,
} from "./userscripts-store.js";

const METHODS = new Set([
  "userscripts/status",
  "userscripts/list",
  "userscripts/save",
  "userscripts/remove",
  "userscripts/set-enabled",
]);

function errorWithCode(message, code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw errorWithCode(`${label} must be an object`, "INVALID_REQUEST");
  }
  return value;
}

function newScriptId(random = globalThis.crypto?.getRandomValues) {
  if (!random) throw new Error("Web Crypto is required");
  const bytes = random.call(globalThis.crypto, new Uint8Array(16));
  return `script/${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function registrationFor(record) {
  return {
    id: record.id,
    matches: [...record.matches],
    runAt: record.runAt,
    js: [{ code: record.source }],
    world: "USER_SCRIPT",
  };
}

/**
 * Host-owned userscript authority for the bundled greenways-userscripts app.
 *
 * Durable records live in the userscripts object store; Chrome registration is
 * a rebuildable projection of the enabled records. Mutations require an active
 * userscripts/manage capability grant for the exact installed app approval.
 */
export function createUserscriptsRuntime({
  store = userscriptStore,
  userScripts = globalThis.chrome?.userScripts,
  assertAuthority = async () => {
    throw errorWithCode("Userscript capability authority is unavailable", "CAPABILITY_DENIED");
  },
  now = () => new Date(),
} = {}) {
  if (!store || typeof store.values !== "function") {
    throw new TypeError("Userscripts runtime requires a durable script store");
  }

  function available() {
    return typeof userScripts?.register === "function"
      && typeof userScripts?.unregister === "function"
      && typeof userScripts?.getScripts === "function";
  }

  async function records() {
    return validateUserscriptCollection((await store.values()) ?? []);
  }

  async function syncRegistration() {
    if (!available()) return { registered: 0, available: false };
    const desired = (await records()).filter((record) => record.enabled).map(registrationFor);
    await userScripts.unregister();
    if (desired.length) await userScripts.register(desired);
    return { registered: desired.length, available: true };
  }

  async function status() {
    const all = await records();
    let registration = { available: available(), registered: null };
    if (registration.available) {
      try {
        registration.registered = (await userScripts.getScripts()).length;
      } catch (error) {
        registration = { available: false, registered: null, reason: error?.message || String(error) };
      }
    }
    return {
      ok: true,
      available: registration.available,
      reason: registration.reason ?? null,
      registered: registration.registered,
      scripts: all.length,
      enabled: all.filter((record) => record.enabled).length,
      limits: USERSCRIPT_LIMITS,
    };
  }

  async function save(args) {
    await assertAuthority();
    const draft = plainObject(args[0], "Userscript draft");
    const all = await records();
    const existing = typeof draft.id === "string" ? all.find((record) => record.id === draft.id) : null;
    if (draft.id !== undefined && draft.id !== null && !existing) {
      throw errorWithCode("Userscript does not exist", "USERSCRIPT_NOT_FOUND");
    }
    if (!existing && all.length >= USERSCRIPT_LIMITS.scripts) {
      throw errorWithCode(
        `Userscript collection cannot contain more than ${USERSCRIPT_LIMITS.scripts} scripts`,
        "USERSCRIPT_LIMIT",
      );
    }
    const timestamp = now().toISOString();
    const source = draft.source ?? existing?.source;
    const record = validateUserscriptRecord({
      protocol: "greenways-userscript/0-alpha",
      id: existing?.id ?? newScriptId(),
      name: draft.name ?? existing?.name,
      matches: draft.matches ?? existing?.matches,
      runAt: draft.runAt ?? existing?.runAt ?? "document_idle",
      enabled: draft.enabled ?? existing?.enabled ?? false,
      source,
      digest: await sha256(source),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    });
    await store.put(record);
    const registration = await syncRegistration();
    return { ok: true, record, registration };
  }

  async function remove(args) {
    await assertAuthority();
    const [id] = args;
    const all = await records();
    if (!all.some((record) => record.id === id)) {
      throw errorWithCode("Userscript does not exist", "USERSCRIPT_NOT_FOUND");
    }
    await store.delete(id);
    const registration = await syncRegistration();
    return { ok: true, id, registration };
  }

  async function setEnabled(args) {
    await assertAuthority();
    const [id, enabled] = args;
    if (typeof enabled !== "boolean") {
      throw errorWithCode("Userscript enabled flag must be a boolean", "INVALID_REQUEST");
    }
    const all = await records();
    const existing = all.find((record) => record.id === id);
    if (!existing) throw errorWithCode("Userscript does not exist", "USERSCRIPT_NOT_FOUND");
    const record = validateUserscriptRecord({ ...existing, enabled, updatedAt: now().toISOString() });
    await store.put(record);
    const registration = await syncRegistration();
    return { ok: true, record, registration };
  }

  return Object.freeze({
    async call(method, args = []) {
      if (!METHODS.has(method)) {
        throw errorWithCode(`Unsupported userscripts method: ${method}`, "INVALID_REQUEST");
      }
      if (method === "userscripts/status") return status();
      if (method === "userscripts/list") return { ok: true, scripts: await records() };
      if (method === "userscripts/save") return save(args);
      if (method === "userscripts/remove") return remove(args);
      return setEnabled(args);
    },
    syncRegistration,
  });
}
