import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  collectFabricState,
  createFabricBackupService,
  createRecoveryKey,
  dailyRetention,
  openBackup,
  sealBackup,
} from "../src/fabric-backup.js";

globalThis.btoa ??= (value) => Buffer.from(value, "binary").toString("base64");
globalThis.atob ??= (value) => Buffer.from(value, "base64").toString("binary");

test("seals all four app collections and only a recovery key can open them", async () => {
  const storage = { entries: async (name) => [[`${name}-1`, { secret: "local" }]] };
  const state = await collectFabricState(storage);
  assert.deepEqual(Object.keys(state.applications), ["kernel-devtools", "userscripts", "worlds", "chats"]);
  const key = createRecoveryKey(webcrypto);
  const sealed = await sealBackup(state, key, { cryptoImpl: webcrypto, createdAt: "2026-08-09T00:00:00.000Z" });
  assert.doesNotMatch(sealed.ciphertext, /local/);
  assert.deepEqual(await openBackup(sealed, key, webcrypto), state);
  await assert.rejects(openBackup(sealed, createRecoveryKey(webcrypto), webcrypto));
});

test("keeps one immutable point per day and retains thirty", () => {
  const backups = Array.from({ length: 35 }, (_, day) => ({
    id: `backup-${day}`,
    createdAt: new Date(Date.UTC(2026, 7, 35 - day, 12)).toISOString(),
  }));
  backups.push({ id: "same-day-older", createdAt: backups[0].createdAt.replace("12:", "01:") });
  const retained = dailyRetention(backups, { now: Date.UTC(2026, 8, 4, 23), retain: 30 });
  assert.equal(retained.length, 30);
  assert.equal(retained[0].id, "backup-0");
});

test("automatic backup is idempotent for the day and prunes through transport", async () => {
  const remote = [];
  const transport = {
    list: async () => remote,
    put: async (backup) => remote.push(backup),
    get: async (id) => remote.find((backup) => backup.id === id),
    retain: async (ids) => remote.splice(0, remote.length, ...remote.filter(({ id }) => ids.includes(id))),
  };
  const storage = { entries: async () => [], replace: async () => {} };
  const service = createFabricBackupService({ storage, transport, cryptoImpl: webcrypto, clock: () => Date.UTC(2026, 7, 9, 12) });
  const key = createRecoveryKey(webcrypto);
  assert.equal((await service.backup(key)).status, "created");
  assert.equal((await service.backup(key)).status, "current");
  assert.equal(remote.length, 1);
});
