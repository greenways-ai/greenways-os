const PROTOCOL = "greenways.fabric-backup/0-alpha";
const DAY = 86_400_000;

export const FABRIC_COLLECTIONS = Object.freeze({
  "kernel-devtools": Object.freeze(["settings", "identity"]),
  userscripts: Object.freeze(["userscripts"]),
  worlds: Object.freeze(["projects", "actions", "inclusions", "outbox"]),
  chats: Object.freeze(["chats"]),
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function digest(value, cryptoImpl) {
  const bytes = await cryptoImpl.subtle.digest("SHA-256", encoder.encode(canonical(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createRecoveryKey(cryptoImpl = globalThis.crypto) {
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(32));
  return `gw1-${bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

function recoveryKeyBytes(recoveryKey) {
  if (typeof recoveryKey !== "string" || !recoveryKey.startsWith("gw1-")) {
    throw new TypeError("A Greenways recovery key is required");
  }
  const encoded = recoveryKey.slice(4).replaceAll("-", "+").replaceAll("_", "/");
  const bytes = base64ToBytes(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="));
  if (bytes.byteLength !== 32) throw new TypeError("The Greenways recovery key is invalid");
  return bytes;
}

export async function sealBackup(payload, recoveryKey, {
  cryptoImpl = globalThis.crypto,
  createdAt = new Date().toISOString(),
} = {}) {
  const key = await cryptoImpl.subtle.importKey("raw", recoveryKeyBytes(recoveryKey), "AES-GCM", false, ["encrypt"]);
  const nonce = cryptoImpl.getRandomValues(new Uint8Array(12));
  const cleartext = encoder.encode(canonical(payload));
  const ciphertext = new Uint8Array(await cryptoImpl.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cleartext));
  return Object.freeze({
    protocol: PROTOCOL,
    id: await digest({ createdAt, ciphertext: bytesToBase64(ciphertext) }, cryptoImpl),
    createdAt,
    cipher: "AES-256-GCM",
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  });
}

export async function openBackup(backup, recoveryKey, cryptoImpl = globalThis.crypto) {
  if (backup?.protocol !== PROTOCOL || backup.cipher !== "AES-256-GCM") {
    throw new TypeError("Unsupported Greenways backup object");
  }
  const key = await cryptoImpl.subtle.importKey("raw", recoveryKeyBytes(recoveryKey), "AES-GCM", false, ["decrypt"]);
  const cleartext = await cryptoImpl.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(backup.nonce) },
    key,
    base64ToBytes(backup.ciphertext),
  );
  return JSON.parse(decoder.decode(cleartext));
}

export function dailyRetention(backups, { now = Date.now(), retain = 30 } = {}) {
  const byDay = new Map();
  for (const backup of [...backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const timestamp = Date.parse(backup.createdAt);
    if (!Number.isFinite(timestamp) || timestamp > now) continue;
    const day = Math.floor(timestamp / DAY);
    if (!byDay.has(day)) byDay.set(day, backup);
  }
  return [...byDay.values()].slice(0, retain);
}

export async function collectFabricState(storage) {
  const applications = {};
  for (const [appId, names] of Object.entries(FABRIC_COLLECTIONS)) {
    applications[appId] = { version: 1, collections: {} };
    for (const name of names) applications[appId].collections[name] = await storage.entries(name);
  }
  return { protocol: "greenways.fabric-state/0-alpha", applications };
}

export async function restoreFabricState(payload, storage) {
  if (payload?.protocol !== "greenways.fabric-state/0-alpha") throw new TypeError("Unsupported Greenways state backup");
  for (const [appId, descriptor] of Object.entries(payload.applications ?? {})) {
    const allowed = new Set(FABRIC_COLLECTIONS[appId] ?? []);
    for (const [name, entries] of Object.entries(descriptor.collections ?? {})) {
      if (!allowed.has(name) || !Array.isArray(entries)
        || entries.some((entry) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")) {
        throw new TypeError(`Invalid ${appId} backup collection`);
      }
      await storage.replace(name, entries);
    }
  }
}

export function createFabricBackupService({ storage, transport, cryptoImpl = globalThis.crypto, clock = Date.now }) {
  return Object.freeze({
    async backup(recoveryKey) {
      const existing = dailyRetention(await transport.list(), { now: clock() });
      const today = Math.floor(clock() / DAY);
      if (existing.some(({ createdAt }) => Math.floor(Date.parse(createdAt) / DAY) === today)) {
        return { status: "current", backup: existing.find(({ createdAt }) => Math.floor(Date.parse(createdAt) / DAY) === today) };
      }
      const backup = await sealBackup(await collectFabricState(storage), recoveryKey, {
        cryptoImpl,
        createdAt: new Date(clock()).toISOString(),
      });
      await transport.put(backup);
      const retained = dailyRetention([backup, ...existing], { now: clock() });
      await transport.retain(retained.map(({ id }) => id));
      return { status: "created", backup };
    },
    async restore(backupId, recoveryKey) {
      const backup = await transport.get(backupId);
      await restoreFabricState(await openBackup(backup, recoveryKey, cryptoImpl), storage);
      return backup;
    },
  });
}
