import assert from "node:assert/strict";
import test from "node:test";
import { getAppManifest, validateAppManifest } from "../src/app-catalog.js";
import {
  BrowserKernelHost,
  KERNEL_CONTEXT_RECORD_PROTOCOL,
  KERNEL_GLOBAL_PROTOCOL,
  KERNEL_PROTOCOL,
} from "../src/kernel-host.js";

const CONTEXT_PROTOCOL = "greenways-kernel-context/1";
const LAUNCHER_A = Object.freeze({ kind: "launcher", clientId: "launcher/client-alpha-0001" });
const LAUNCHER_B = Object.freeze({ kind: "launcher", clientId: "launcher/client-bravo-0002" });
const WORLD_A = Object.freeze({ kind: "world", clientId: "world/client-alpha-000001" });
const DEVTOOLS_A = Object.freeze({ kind: "devtools", clientId: "devtools/client-alpha-001" });

const ALLOW_CAPABILITY_AUTHORITY = Object.freeze({
  async check({ appId, capability }) {
    return Object.freeze({
      protocol: "greenways-capability-decision/1",
      allowed: true,
      reason: "test-authority",
      capability,
      subject: Object.freeze({ id: appId }),
      evidence: Object.freeze({ kind: "test" }),
    });
  },
  async assert(request, context) {
    return this.check(request, context);
  },
});

function denyingCapabilityAuthority(reason = "module-runtime-unverified") {
  return Object.freeze({
    async check({ appId, capability }) {
      return Object.freeze({
        protocol: "greenways-capability-decision/1",
        allowed: false,
        reason,
        capability,
        subject: Object.freeze({ id: appId }),
        evidence: null,
      });
    },
    async assert(request, context) {
      const decision = await this.check(request, context);
      const error = new Error(`Capability authority denied: ${decision.capability} (${decision.reason})`);
      error.code = "CAPABILITY_DENIED";
      error.decision = decision;
      throw error;
    },
  });
}

function copy(value) {
  return structuredClone(value);
}

function initialState() {
  return {
    apps: { installed: [], active: null },
    core: { services: [] },
    capabilities: { grants: [] },
    surface: { active: null, payload: null },
    studio: { tracks: [] },
    world: { status: "idle", repository: null, graph: null },
  };
}

function checkpoint(state) {
  return {
    protocol: CONTEXT_PROTOCOL,
    apps: { active: state.apps?.active ?? null },
    surface: copy(state.surface ?? { active: null, payload: null }),
    studio: copy(state.studio ?? { tracks: [] }),
  };
}

function restoredState(saved, installed, grants = []) {
  const state = initialState();
  state.apps = {
    installed: copy(installed),
    active: installed.some(({ id }) => id === saved.apps?.active) ? saved.apps.active : null,
  };
  state.capabilities = { grants: copy(grants) };
  state.surface = copy(saved.surface ?? state.surface);
  state.studio = copy(saved.studio ?? state.studio);
  return state;
}

function revokeAppGrants(state, appId, revokedAt) {
  const grants = state.capabilities?.grants ?? [];
  const next = grants.map((grant) => {
    if (grant.subject?.appId !== appId || grant.revokedAt) return copy(grant);
    const effectiveTime = grant.issuedAt > revokedAt ? grant.issuedAt : revokedAt;
    return { ...copy(grant), revokedAt: effectiveTime };
  });
  return { grants: next, changed: JSON.stringify(grants) !== JSON.stringify(next) };
}

function createInvoker({ override, calls = [] } = {}) {
  return {
    calls,
    async invoke(method, args) {
      calls.push({ method, args: copy(args) });
      if (override) {
        const overridden = await override(method, args);
        if (overridden !== undefined) return overridden;
      }
      if (method === "app/bootstrap") return initialState();
      if (method === "app/checkpoint") return checkpoint(args[0]);
      if (method === "app/restore") return restoredState(args[0], args[1], args[2] ?? []);
      if (method === "apps/restore") {
        return {
          state: restoredState(
            checkpoint(args[0]),
            args[1],
            args[0]?.capabilities?.grants ?? [],
          ),
          effects: [],
        };
      }
      if (method === "apps/install") {
        const [state, manifest] = args;
        if (state.apps.installed.some(({ id }) => id === manifest.id)) throw new Error("App is already installed");
        const installed = [...state.apps.installed, copy(manifest)];
        return {
          state: { ...copy(state), apps: { ...copy(state.apps), installed } },
          effects: [{ effect: "storage", method: "save-apps", args: [installed] }],
        };
      }
      if (method === "apps/update") {
        const [state, manifest, revokedAt] = args;
        if (!state.apps.installed.some(({ id }) => id === manifest.id)) throw new Error("App is not installed");
        const installed = state.apps.installed.map((entry) => (
          entry.id === manifest.id ? copy(manifest) : entry
        ));
        const revoked = revokeAppGrants(state, manifest.id, revokedAt);
        const effects = [{ effect: "storage", method: "save-apps", args: [installed] }];
        if (revoked.changed) effects.push({ effect: "storage", method: "save-grants", args: [revoked.grants] });
        return {
          state: {
            ...copy(state),
            apps: { ...copy(state.apps), installed },
            capabilities: { grants: revoked.grants },
          },
          effects,
        };
      }
      if (method === "apps/open") {
        const [state, appId] = args;
        const manifest = state.apps.installed.find(({ id }) => id === appId);
        if (!manifest) throw new Error("App is not installed");
        const next = { ...copy(state), apps: { ...copy(state.apps), active: appId } };
        if (manifest.launch?.handler === "packaged-surface") {
          next.surface = { active: manifest.launch.surfaceId, payload: { appId } };
          return {
            state: next,
            effects: [{
              effect: "ui",
              method: "open-surface",
              args: [manifest.launch.surfaceId, { appId }],
            }],
          };
        }
        return {
          state: next,
          effects: [{ effect: "browser", method: "open-app", args: [appId] }],
        };
      }
      if (method === "apps/remove") {
        const [state, appId, revokedAt] = args;
        const installed = state.apps.installed.filter(({ id }) => id !== appId);
        const active = state.apps.active === appId ? null : state.apps.active;
        const revoked = revokeAppGrants(state, appId, revokedAt);
        const effects = [{ effect: "storage", method: "save-apps", args: [installed] }];
        if (revoked.changed) effects.push({ effect: "storage", method: "save-grants", args: [revoked.grants] });
        return {
          state: {
            ...copy(state),
            apps: { installed, active },
            capabilities: { grants: revoked.grants },
          },
          effects,
        };
      }
      if (method === "core/services") return [{ id: "kernel", resident: true, removable: false }];
      if (method === "capabilities/vocabulary") return [{ id: "key/sign", grantable: true }];
      if (method === "capabilities/list") return copy(args[0]?.capabilities?.grants ?? []);
      if (method === "capabilities/check") {
        const [state, appId, capability, now] = args;
        return copy((state.capabilities?.grants ?? []).find((grant) => (
          grant.subject?.appId === appId
          && grant.capability === capability
          && !grant.revokedAt
          && (!grant.expiresAt || !now || grant.expiresAt > now)
        )) ?? null);
      }
      if (method === "capabilities/grant") {
        const [state, grant] = args;
        const grants = state.capabilities?.grants ?? [];
        if (grants.some(({ id }) => id === grant.id)) throw new Error("Capability grant id already exists");
        const nextGrants = [...grants, copy(grant)];
        return {
          state: { ...copy(state), capabilities: { grants: nextGrants } },
          effects: [{ effect: "storage", method: "save-grants", args: [nextGrants] }],
        };
      }
      if (method === "capabilities/revoke") {
        const [state, grantId, revokedAt] = args;
        const grants = state.capabilities?.grants ?? [];
        if (!grants.some(({ id }) => id === grantId)) throw new Error("Capability grant does not exist");
        const nextGrants = grants.map((grant) => (
          grant.id === grantId ? { ...copy(grant), revokedAt } : copy(grant)
        ));
        return {
          state: { ...copy(state), capabilities: { grants: nextGrants } },
          effects: [{ effect: "storage", method: "save-grants", args: [nextGrants] }],
        };
      }
      if (method === "surface/close") {
        const next = copy(args[0]);
        next.apps.active = null;
        next.surface = { active: null, payload: null };
        return {
          state: next,
          effects: [{ effect: "ui", method: "close-surface", args: [] }],
        };
      }
      if (method === "world/touchpoint") {
        const [state, touchpoint] = args;
        const next = copy(state);
        next.surface = { active: touchpoint.surface, payload: copy(touchpoint) };
        return {
          state: next,
          effects: [{ effect: "ui", method: "open-surface", args: [touchpoint.surface, touchpoint] }],
        };
      }
      if (method === "catalog/search") return args[0];
      if (method === "world/open") return { state: { status: "resolving" }, effects: [] };
      if (method === "world/render") return { state: { status: "ready" }, effects: [] };
      throw new Error(`Unexpected fake Hara method: ${method}`);
    },
  };
}

class MemoryRepository {
  constructor() {
    this.stores = new Map();
  }

  target(name) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return this.stores.get(name);
  }

  async get(name, key) {
    const value = this.target(name).get(key);
    return value === undefined ? undefined : copy(value);
  }

  async put(name, key, value) {
    this.target(name).set(key, copy(value));
  }

  async values(name) {
    return [...this.target(name).values()].map(copy);
  }

  async replace(name, entries) {
    this.stores.set(name, new Map(entries.map(([key, value]) => [key, copy(value)])));
  }
}

class MemoryKernelRepository {
  constructor(repository) {
    this.repository = repository;
    this.commits = [];
    this.prepared = [];
    this.aborted = [];
  }

  async getRequest(requestId) {
    return this.repository.get("kernel", `request:${requestId}`);
  }

  async prepareRequest(requestId, request) {
    this.prepared.push(requestId);
    await this.repository.put("kernel", `request:${requestId}`, request);
  }

  async abortRequest(requestId) {
    this.aborted.push(requestId);
    this.repository.target("kernel").delete(`request:${requestId}`);
  }

  async commit(change) {
    this.commits.push(copy(change));
    await this.repository.put("kernel", "global", change.globalEnvelope);
    await this.repository.put("kernel", `context:${change.contextId}`, change.contextEnvelope);
    await this.repository.replace("apps", change.apps.map((manifest) => [manifest.id, manifest]));
    if (change.grants !== undefined) {
      await this.repository.replace("grants", change.grants.map((grant) => [grant.id, grant]));
    }
    this.repository.target("kernel").delete(`request:${change.requestId}`);
  }

  async replaceGlobal(change) {
    await this.repository.put("kernel", "global", change.globalEnvelope);
    await this.repository.replace("apps", change.apps.map((manifest) => [manifest.id, manifest]));
    if (change.grants !== undefined) {
      await this.repository.replace("grants", change.grants.map((grant) => [grant.id, grant]));
    }
  }
}

class FakeRuntime {
  constructor() {
    this.id = "greenways-test-extension";
    this.messages = [];
    this.clientEffects = new Map();
  }

  getURL(path) {
    return `chrome-extension://${this.id}/${String(path).replace(/^\/+/, "")}`;
  }

  onEffect(contextId, handler) {
    this.clientEffects.set(contextId, handler);
  }

  async sendMessage(message) {
    this.messages.push(copy(message));
    if (message.type === "greenways/kernel/effect") {
      const handler = this.clientEffects.get(message.contextId);
      if (!handler) return undefined;
      return handler(copy(message));
    }
    return { protocol: KERNEL_PROTOCOL, ok: true };
  }
}

function createRig({
  repository = new MemoryRepository(),
  invoker,
  runtime = new FakeRuntime(),
  capabilityAuthority = ALLOW_CAPABILITY_AUTHORITY,
  devtools,
} = {}) {
  const hara = invoker ?? createInvoker();
  const kernelRepository = new MemoryKernelRepository(repository);
  const tabs = {
    opened: [],
    async create(options) {
      this.opened.push(copy(options));
      return { id: this.opened.length, ...options };
    },
  };
  let tick = 0;
  const host = new BrowserKernelHost({
    invoke: hara.invoke.bind(hara),
    repository,
    kernelRepository,
    capabilityAuthority,
    runtime,
    tabs,
    devtools,
    now: () => new Date(Date.UTC(2026, 7, 4, 0, 0, tick++)),
  });
  return { host, repository, kernelRepository, runtime, tabs, invoker: hara };
}

function dispatch(host, principal, requestId, method, args = []) {
  return host.dispatch(principal, { requestId, method, args });
}

function installedIds(snapshot) {
  return snapshot.state.apps.installed.map(({ id }) => id);
}

test("shares global installs across launcher clients while keeping their surfaces isolated", async () => {
  const rig = createRig();
  const hestia = getAppManifest("hestia-connector");
  const effects = [];
  rig.runtime.onEffect(LAUNCHER_A.clientId, async (message) => {
    effects.push(["a", message]);
    return { protocol: KERNEL_PROTOCOL, ok: true };
  });
  rig.runtime.onEffect(LAUNCHER_B.clientId, async (message) => {
    effects.push(["b", message]);
    return { protocol: KERNEL_PROTOCOL, ok: true };
  });

  await dispatch(rig.host, LAUNCHER_A, "request/install-hestia-0001", "apps/install", [hestia]);
  const openedA = await dispatch(
    rig.host,
    LAUNCHER_A,
    "request/open-hestia-alpha-0002",
    "apps/open",
    [hestia.id],
  );
  const attachedB = await rig.host.attach(LAUNCHER_B);
  const openedB = await dispatch(
    rig.host,
    LAUNCHER_B,
    "request/open-hestia-bravo-0003",
    "apps/open",
    [hestia.id],
  );
  const reattachedA = await rig.host.attach(LAUNCHER_A);

  assert.ok(installedIds(attachedB).includes(hestia.id));
  assert.equal(openedA.state.surface.active, "hestia-connector");
  assert.equal(attachedB.state.surface.active, null);
  assert.equal(openedB.state.surface.active, "hestia-connector");
  assert.equal(reattachedA.state.surface.active, "hestia-connector");
  assert.deepEqual(effects.map(([client, message]) => [client, message.contextId]), [
    ["a", LAUNCHER_A.clientId],
    ["b", LAUNCHER_B.clientId],
  ]);
  assert.notDeepEqual(
    await rig.repository.get("kernel", `context:${LAUNCHER_A.clientId}`),
    await rig.repository.get("kernel", `context:${LAUNCHER_B.clientId}`),
  );
});

test("serializes concurrent installs from different clients against the latest global state", async () => {
  const rig = createRig();
  const historia = getAppManifest("historia");
  const playground = getAppManifest("hara-playground");

  const [first, second] = await Promise.all([
    dispatch(rig.host, LAUNCHER_A, "request/install-historia-0101", "apps/install", [historia]),
    dispatch(rig.host, LAUNCHER_B, "request/install-playground-0102", "apps/install", [playground]),
  ]);
  const global = await rig.repository.get("kernel", "global");
  const installInputs = rig.invoker.calls
    .filter(({ method }) => method === "apps/install")
    .map(({ args }) => args[0].apps.installed.map(({ id }) => id));

  assert.ok(installedIds(first).includes(historia.id));
  assert.ok(installedIds(second).includes(historia.id));
  assert.ok(installedIds(second).includes(playground.id));
  assert.deepEqual(global.installed.map(({ id }) => id).slice(-2), [historia.id, playground.id]);
  assert.equal(global.revision, 2);
  assert.ok(installInputs[1].includes(historia.id));
  assert.equal(rig.kernelRepository.commits.length, 2);
});

test("rehydrates global and client context state after a host restart", async () => {
  const repository = new MemoryRepository();
  const first = createRig({ repository });
  const hestia = getAppManifest("hestia-connector");
  first.runtime.onEffect(LAUNCHER_A.clientId, async () => ({ protocol: KERNEL_PROTOCOL, ok: true }));
  await dispatch(first.host, LAUNCHER_A, "request/restart-install-0201", "apps/install", [hestia]);
  await dispatch(first.host, LAUNCHER_A, "request/restart-open-0202", "apps/open", [hestia.id]);

  const restarted = createRig({ repository });
  const attached = await restarted.host.attach(LAUNCHER_A);

  assert.ok(installedIds(attached).includes(hestia.id));
  assert.equal(attached.globalRevision, 1);
  assert.equal(attached.contextRevision, 2);
  assert.equal(attached.state.apps.active, hestia.id);
  assert.equal(attached.state.surface.active, "hestia-connector");
  assert.equal(restarted.kernelRepository.commits.length, 0);
});

test("requires reapproval before opening a changed packaged-surface manifest", async () => {
  const repository = new MemoryRepository();
  const hestia = getAppManifest("hestia-connector");
  await repository.put("kernel", "global", {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 1,
    installed: [{ ...hestia, version: "0.0.1" }],
    receipts: [],
    updatedAt: "2026-08-04T00:00:00.000Z",
  });
  const rig = createRig({ repository });
  await assert.rejects(
    dispatch(
      rig.host,
      LAUNCHER_A,
      "request/stale-surface-open-0251",
      "apps/open",
      [hestia.id],
    ),
    (error) => error.code === "APP_APPROVAL_REQUIRED",
  );
  assert.deepEqual(rig.kernelRepository.prepared, []);
  assert.equal(rig.runtime.messages.length, 0);
});

test("does not restore an active packaged surface after its approval becomes stale", async () => {
  const repository = new MemoryRepository();
  const hestia = getAppManifest("hestia-connector");
  await repository.put("kernel", "global", {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 1,
    installed: [{ ...hestia, version: "0.2.0" }],
    receipts: [],
    updatedAt: "2026-08-04T00:00:00.000Z",
  });
  await repository.put("kernel", `context:${LAUNCHER_A.clientId}`, {
    protocol: KERNEL_CONTEXT_RECORD_PROTOCOL,
    clientId: LAUNCHER_A.clientId,
    kind: LAUNCHER_A.kind,
    revision: 4,
    checkpoint: {
      protocol: CONTEXT_PROTOCOL,
      apps: { active: hestia.id },
      surface: { active: "hestia-connector", payload: { appId: hestia.id } },
      studio: { tracks: [] },
    },
    updatedAt: "2026-08-04T00:00:00.000Z",
  });
  const attached = await createRig({ repository }).host.attach(LAUNCHER_A);
  assert.equal(attached.state.apps.active, null);
  assert.equal(attached.state.surface.active, null);
  assert.equal(attached.contextRevision, 4);
});

test("removing a packaged app clears its surface in other contexts and after restart", async () => {
  const repository = new MemoryRepository();
  const rig = createRig({ repository });
  const hestia = getAppManifest("hestia-connector");
  rig.runtime.onEffect(LAUNCHER_B.clientId, async () => ({
    protocol: KERNEL_PROTOCOL,
    ok: true,
  }));

  await dispatch(rig.host, LAUNCHER_A, "request/remove-other-install-0254", "apps/install", [hestia]);
  await dispatch(rig.host, LAUNCHER_B, "request/remove-other-open-0255", "apps/open", [hestia.id]);
  await dispatch(rig.host, LAUNCHER_A, "request/remove-other-remove-0256", "apps/remove", [hestia.id]);

  const attached = await rig.host.attach(LAUNCHER_B);
  assert.equal(attached.state.apps.active, null);
  assert.equal(attached.state.surface.active, null);
  assert.equal(attached.state.surface.payload, null);

  const restarted = createRig({ repository });
  const reattached = await restarted.host.attach(LAUNCHER_B);
  assert.equal(reattached.state.apps.active, null);
  assert.equal(reattached.state.surface.active, null);
  assert.equal(reattached.state.surface.payload, null);
});

test("approves only the exact bundled manifest when updating an installed app", async () => {
  const repository = new MemoryRepository();
  const hestia = getAppManifest("hestia-connector");
  await repository.put("kernel", "global", {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 1,
    installed: [{ ...hestia, version: "0.2.0" }],
    receipts: [],
    updatedAt: "2026-08-04T00:00:00.000Z",
  });
  const rig = createRig({ repository });
  const updated = await dispatch(
    rig.host,
    LAUNCHER_A,
    "request/update-hestia-0252",
    "apps/update",
    [hestia],
  );
  assert.equal(
    updated.state.apps.installed.find(({ id }) => id === hestia.id).version,
    hestia.version,
  );
  await assert.rejects(
    dispatch(
      rig.host,
      LAUNCHER_A,
      "request/forged-update-0253",
      "apps/update",
      [{ ...hestia, description: "Substituted catalog copy" }],
    ),
    (error) => error.code === "APP_CATALOG_MISMATCH",
  );
  assert.equal(rig.kernelRepository.prepared.includes("request/forged-update-0253"), false);
});

test("retains an uncertain browser-effect receipt when commit fails", async () => {
  const repository = new MemoryRepository();
  const rig = createRig({ repository });
  const historia = getAppManifest("historia");
  await dispatch(
    rig.host,
    LAUNCHER_A,
    "request/uncertain-install-0261",
    "apps/install",
    [historia],
  );
  const originalCommit = rig.kernelRepository.commit.bind(rig.kernelRepository);
  rig.kernelRepository.commit = async (change) => {
    if (change.requestId === "request/uncertain-open-0262") throw new Error("commit unavailable");
    return originalCommit(change);
  };

  await assert.rejects(
    dispatch(
      rig.host,
      LAUNCHER_A,
      "request/uncertain-open-0262",
      "apps/open",
      [historia.id],
    ),
    (error) => error.code === "EFFECT_OUTCOME_UNKNOWN" && /may have completed/.test(error.message),
  );
  assert.equal(rig.tabs.opened.length, 1);
  assert.ok(await rig.kernelRepository.getRequest("request/uncertain-open-0262"));
  assert.ok(!rig.kernelRepository.aborted.includes("request/uncertain-open-0262"));

  const restarted = createRig({ repository });
  await assert.rejects(
    dispatch(
      restarted.host,
      LAUNCHER_A,
      "request/uncertain-open-0262",
      "apps/open",
      [historia.id],
    ),
    (error) => error.code === "EFFECT_OUTCOME_UNKNOWN",
  );
  assert.equal(restarted.tabs.opened.length, 0);
});

test("retains an uncertain export receipt when its commit fails", async () => {
  const repository = new MemoryRepository();
  const invoker = createInvoker({
    override(method, args) {
      if (method !== "studio/export-project") return undefined;
      return {
        state: copy(args[0]),
        effects: [{ effect: "export", method: "studio-project", args: [{ tracks: [{ id: "local:1" }] }] }],
      };
    },
  });
  const rig = createRig({ repository, invoker });
  let exports = 0;
  rig.runtime.onEffect(WORLD_A.clientId, async () => {
    exports += 1;
    return { protocol: KERNEL_PROTOCOL, ok: true };
  });
  const originalCommit = rig.kernelRepository.commit.bind(rig.kernelRepository);
  rig.kernelRepository.commit = async (change) => {
    if (change.requestId === "request/uncertain-export-0263") throw new Error("commit unavailable");
    return originalCommit(change);
  };

  await assert.rejects(
    dispatch(
      rig.host,
      WORLD_A,
      "request/uncertain-export-0263",
      "studio/export-project",
      [],
    ),
    (error) => error.code === "EFFECT_OUTCOME_UNKNOWN" && /may have completed/.test(error.message),
  );
  assert.equal(exports, 1);
  assert.ok(await rig.kernelRepository.getRequest("request/uncertain-export-0263"));
  assert.ok(!rig.kernelRepository.aborted.includes("request/uncertain-export-0263"));

  const restarted = createRig({ repository });
  await assert.rejects(
    dispatch(
      restarted.host,
      WORLD_A,
      "request/uncertain-export-0263",
      "studio/export-project",
      [],
    ),
    (error) => error.code === "EFFECT_OUTCOME_UNKNOWN",
  );
  assert.equal(
    restarted.runtime.messages.filter(({ type }) => type === "greenways/kernel/effect").length,
    0,
  );
});

test("durably replays an identical request and rejects changed content with the same id", async () => {
  const repository = new MemoryRepository();
  const first = createRig({ repository });
  const historia = getAppManifest("historia");
  const playground = getAppManifest("hara-playground");
  const requestId = "request/durable-replay-0301";
  const committed = await dispatch(first.host, LAUNCHER_A, requestId, "apps/install", [historia]);

  const restarted = createRig({ repository });
  const replayed = await dispatch(restarted.host, LAUNCHER_A, requestId, "apps/install", [historia]);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.globalRevision, committed.globalRevision);
  assert.equal(restarted.kernelRepository.commits.length, 0);
  assert.equal(
    restarted.invoker.calls.filter(({ method }) => method === "apps/install").length,
    0,
  );

  let reuseError;
  try {
    await dispatch(restarted.host, LAUNCHER_A, requestId, "apps/install", [playground]);
  } catch (error) {
    reuseError = error;
  }
  assert.equal(reuseError?.code, "REQUEST_ID_REUSE");
  assert.match(reuseError?.message ?? "", /different content/);
});

test("enforces caller-specific call and dispatch allowlists", async () => {
  const rig = createRig();

  await assert.rejects(
    rig.host.call(LAUNCHER_A, "world/open", ["repo", "main", "dev"]),
    (error) => error.code === "METHOD_DENIED",
  );
  await assert.rejects(
    dispatch(rig.host, WORLD_A, "request/world-install-denied-0401", "apps/install", [getAppManifest("historia")]),
    (error) => error.code === "METHOD_DENIED",
  );
  await assert.rejects(
    dispatch(rig.host, LAUNCHER_A, "request/launcher-touch-denied-0402", "world/touchpoint", [{ surface: "studio" }]),
    (error) => error.code === "METHOD_DENIED",
  );
  await assert.rejects(
    rig.host.attach({ kind: "home", clientId: "home/client-denied-00001" }),
    (error) => error.code === "CALLER_DENIED",
  );
  assert.deepEqual(await rig.host.call(WORLD_A, "catalog/search", [[{ id: "one" }], "one"]), {
    ok: true,
    protocol: KERNEL_PROTOCOL,
    value: [{ id: "one" }],
  });
  assert.equal(rig.kernelRepository.prepared.length, 0);
});

test("routes a page effect only to its target client", async () => {
  const rig = createRig();
  const received = [];
  rig.runtime.onEffect(WORLD_A.clientId, async (message) => {
    received.push([WORLD_A.clientId, message]);
    return { protocol: KERNEL_PROTOCOL, ok: true };
  });
  rig.runtime.onEffect(LAUNCHER_A.clientId, async (message) => {
    received.push([LAUNCHER_A.clientId, message]);
    return { protocol: KERNEL_PROTOCOL, ok: true };
  });

  const response = await dispatch(
    rig.host,
    WORLD_A,
    "request/world-surface-target-0501",
    "world/touchpoint",
    [{ id: "console", surface: "studio" }],
  );

  assert.equal(response.state.surface.active, "studio");
  assert.equal(received.length, 1);
  assert.equal(received[0][0], WORLD_A.clientId);
  assert.equal(received[0][1].contextId, WORLD_A.clientId);
  assert.equal(received[0][1].tentativeState.surface.active, "studio");
  assert.equal(received[0][1].effects[0].method, "open-surface");
});

test("rejects an unexpected Hara effect before preparing or committing", async () => {
  const invoker = createInvoker({
    override(method, args) {
      if (method !== "apps/install") return undefined;
      const [state, manifest] = args;
      const installed = [...state.apps.installed, copy(manifest)];
      return {
        state: { ...copy(state), apps: { ...copy(state.apps), installed } },
        effects: [{ effect: "network", method: "fetch", args: ["https://attacker.invalid"] }],
      };
    },
  });
  const rig = createRig({ invoker });

  await assert.rejects(
    dispatch(
      rig.host,
      LAUNCHER_A,
      "request/unexpected-effect-0601",
      "apps/install",
      [getAppManifest("historia")],
    ),
    (error) => error.code === "KERNEL_CONTRACT" && /unauthorized effect/.test(error.message),
  );
  assert.equal(rig.kernelRepository.prepared.length, 0);
  assert.equal(rig.kernelRepository.commits.length, 0);
  assert.equal(rig.runtime.messages.some(({ type }) => type === "greenways/kernel/effect"), false);
});

test("does not commit tentative state when the target client rejects an effect", async () => {
  const rig = createRig();
  const hestia = getAppManifest("hestia-connector");
  await dispatch(rig.host, LAUNCHER_A, "request/failure-install-0701", "apps/install", [hestia]);
  const beforeGlobal = await rig.repository.get("kernel", "global");
  const beforeContext = await rig.repository.get("kernel", `context:${LAUNCHER_A.clientId}`);
  const commitCount = rig.kernelRepository.commits.length;
  rig.runtime.onEffect(LAUNCHER_A.clientId, async () => ({
    protocol: KERNEL_PROTOCOL,
    ok: false,
    error: "surface refused",
  }));

  let failure;
  try {
    await dispatch(rig.host, LAUNCHER_A, "request/failure-open-0702", "apps/open", [hestia.id]);
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, "CLIENT_EFFECT_FAILED");
  assert.match(failure?.message ?? "", /surface refused/);
  assert.equal(rig.kernelRepository.commits.length, commitCount);
  assert.deepEqual(await rig.repository.get("kernel", "global"), beforeGlobal);
  assert.deepEqual(await rig.repository.get("kernel", `context:${LAUNCHER_A.clientId}`), beforeContext);
  assert.equal(await rig.kernelRepository.getRequest("request/failure-open-0702"), undefined);
  assert.ok(rig.kernelRepository.aborted.includes("request/failure-open-0702"));
  assert.ok(rig.runtime.messages.some((message) => (
    message.type === "greenways/kernel/update"
    && message.contextId === LAUNCHER_A.clientId
    && message.rollback === true
  )));
  const attached = await rig.host.attach(LAUNCHER_A);
  assert.equal(attached.state.surface.active, null);
  assert.equal(attached.state.apps.active, null);
});

test("host persistence records use the versioned global and context protocols", async () => {
  const rig = createRig();
  await rig.host.attach(LAUNCHER_A);
  const global = await rig.repository.get("kernel", "global");
  const context = await rig.repository.get("kernel", `context:${LAUNCHER_A.clientId}`);
  assert.equal(global.protocol, KERNEL_GLOBAL_PROTOCOL);
  assert.equal(context.protocol, KERNEL_CONTEXT_RECORD_PROTOCOL);
});

test("migrates pre-grant global envelopes into an explicit empty grant projection", async () => {
  const repository = new MemoryRepository();
  const installed = [
    getAppManifest("greenways-home"),
    getAppManifest("greenways-worlds"),
  ];
  await repository.put("kernel", "global", {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 4,
    installed,
    receipts: [],
    updatedAt: "2026-08-03T00:00:00.000Z",
  });

  const rig = createRig({ repository });
  await rig.host.attach(LAUNCHER_A);
  const migrated = await repository.get("kernel", "global");

  assert.deepEqual(migrated.grants, []);
  assert.equal(migrated.revision, 5);
  assert.deepEqual(await repository.values("grants"), []);
});

test("exposes resident service and capability projections through bounded kernel calls", async () => {
  const rig = createRig();
  const services = await rig.host.call(LAUNCHER_A, "core/services", []);
  const vocabulary = await rig.host.call(WORLD_A, "capabilities/vocabulary", []);
  const grants = await rig.host.call(LAUNCHER_A, "capabilities/list", []);

  assert.deepEqual(services.value, [{ id: "kernel", resident: true, removable: false }]);
  assert.deepEqual(vocabulary.value, [{ id: "key/sign", grantable: true }]);
  assert.deepEqual(grants.value, []);
  assert.ok(rig.invoker.calls.some(({ method, args }) => (
    method === "capabilities/list" && args[0]?.apps?.installed
  )));
});

test("fails a capability check closed before Hara grants are consulted", async () => {
  const repository = new MemoryRepository();
  const module = validateAppManifest({
    protocol: "greenways-app/1",
    id: "unverified-signer",
    version: "0.1.0",
    publisher: { id: "example", name: "Example" },
    name: "Unverified Signer",
    description: "Exercises the host-owned runtime authority gate.",
    category: "installable",
    capabilities: ["hara/module", "key/sign"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "preview",
    lockDigest: `sha256:${"9".repeat(64)}`,
    source: {
      kind: "github",
      owner: "example",
      repo: "unverified-signer",
      sha: "8".repeat(40),
    },
  });
  await repository.put("kernel", "global", {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 1,
    installed: [module],
    grants: [],
    receipts: [],
    updatedAt: "2026-08-06T00:00:00.000Z",
  });
  const rig = createRig({
    repository,
    capabilityAuthority: denyingCapabilityAuthority(),
  });

  const checked = await rig.host.call(
    LAUNCHER_A,
    "capabilities/check",
    [module.id, "key/sign"],
  );
  assert.equal(checked.value, null);
  assert.equal(checked.authority.allowed, false);
  assert.equal(checked.authority.reason, "module-runtime-unverified");
  assert.equal(rig.invoker.calls.some(({ method }) => method === "capabilities/check"), false);
});

test("denies a capability grant before preparing durable state when authority is unverified", async () => {
  const repository = new MemoryRepository();
  const module = validateAppManifest({
    protocol: "greenways-app/1",
    id: "blocked-signer",
    version: "0.1.0",
    publisher: { id: "example", name: "Example" },
    name: "Blocked Signer",
    description: "Cannot receive authority before runtime verification.",
    category: "installable",
    capabilities: ["hara/module", "key/sign"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "preview",
    lockDigest: `sha256:${"7".repeat(64)}`,
    source: {
      kind: "github",
      owner: "example",
      repo: "blocked-signer",
      sha: "6".repeat(40),
    },
  });
  await repository.put("kernel", "global", {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 1,
    installed: [module],
    grants: [],
    receipts: [],
    updatedAt: "2026-08-06T00:00:00.000Z",
  });
  const rig = createRig({
    repository,
    capabilityAuthority: denyingCapabilityAuthority(),
  });

  await assert.rejects(
    dispatch(
      rig.host,
      LAUNCHER_A,
      "request/blocked-capability-1001",
      "capabilities/grant",
      [{
        id: "grant/blocked-signer-0001",
        appId: module.id,
        capability: "key/sign",
        constraints: { purpose: "test" },
      }],
    ),
    (error) => (
      error.code === "CAPABILITY_DENIED"
      && error.decision?.reason === "module-runtime-unverified"
    ),
  );
  assert.deepEqual(rig.kernelRepository.prepared, []);
  assert.deepEqual(rig.kernelRepository.commits, []);
});

test("persists an exact app-bound capability grant and revocation across restarts", async () => {
  const repository = new MemoryRepository();
  const lockDigest = `sha256:${"a".repeat(64)}`;
  const module = validateAppManifest({
    protocol: "greenways-app/1",
    id: "signing-room",
    version: "0.1.0",
    publisher: { id: "example", name: "Example" },
    name: "Signing Room",
    description: "Signs bounded publication receipts.",
    category: "installable",
    capabilities: ["hara/module", "key/sign"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "preview",
    lockDigest,
    source: {
      kind: "github",
      owner: "example",
      repo: "signing-room",
      sha: "b".repeat(40),
    },
  });
  await repository.put("kernel", "global", {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 1,
    installed: [module],
    grants: [],
    receipts: [],
    updatedAt: "2026-08-06T00:00:00.000Z",
  });

  const first = createRig({ repository });
  const granted = await dispatch(
    first.host,
    LAUNCHER_A,
    "request/capability-grant-1001",
    "capabilities/grant",
    [{
      id: "grant/signing-room-0001",
      appId: module.id,
      capability: "key/sign",
      constraints: { purpose: "publication-receipt" },
      expiresAt: "2026-08-07T00:00:00.000Z",
    }],
  );

  const grant = granted.state.capabilities.grants[0];
  assert.equal(grant.subject.appId, module.id);
  assert.equal(grant.subject.version, module.version);
  assert.equal(grant.subject.publisherId, module.publisher.id);
  assert.equal(grant.subject.lockDigest, lockDigest);
  assert.equal(grant.capability, "key/sign");
  assert.equal((await repository.get("kernel", "global")).grants[0].id, grant.id);
  assert.equal((await repository.get("grants", grant.id)).capability, "key/sign");
  assert.equal(first.kernelRepository.commits.at(-1).grants[0].id, grant.id);

  const restarted = createRig({ repository });
  const restored = await restarted.host.attach(LAUNCHER_A);
  assert.equal(restored.state.capabilities.grants[0].id, grant.id);
  const checked = await restarted.host.call(
    LAUNCHER_A,
    "capabilities/check",
    [module.id, "key/sign"],
  );
  assert.equal(checked.value.id, grant.id);

  const revoked = await dispatch(
    restarted.host,
    LAUNCHER_A,
    "request/capability-revoke-1002",
    "capabilities/revoke",
    [grant.id],
  );
  assert.equal(revoked.state.capabilities.grants[0].revokedAt, grant.issuedAt);
  assert.equal(
    (await restarted.host.call(LAUNCHER_A, "capabilities/check", [module.id, "key/sign"])).value,
    null,
  );
});

test("removing an app revokes its grants atomically so reinstall cannot revive them", async () => {
  const repository = new MemoryRepository();
  const module = validateAppManifest({
    protocol: "greenways-app/1",
    id: "temporary-signer",
    version: "0.1.0",
    publisher: { id: "example", name: "Example" },
    name: "Temporary Signer",
    description: "Exercises removal-bound capability revocation.",
    category: "installable",
    capabilities: ["hara/module", "key/sign"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "preview",
    lockDigest: `sha256:${"e".repeat(64)}`,
    source: {
      kind: "github",
      owner: "example",
      repo: "temporary-signer",
      sha: "f".repeat(40),
    },
  });
  await repository.put("kernel", "global", {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 1,
    installed: [module],
    grants: [],
    receipts: [],
    updatedAt: "2026-08-06T00:00:00.000Z",
  });

  const rig = createRig({ repository });
  const granted = await dispatch(
    rig.host,
    LAUNCHER_A,
    "request/remove-grant-1101",
    "capabilities/grant",
    [{
      id: "grant/temporary-signer-0001",
      appId: module.id,
      capability: "key/sign",
      constraints: { purpose: "temporary-test" },
    }],
  );
  const removed = await dispatch(
    rig.host,
    LAUNCHER_A,
    "request/remove-app-1102",
    "apps/remove",
    [module.id],
  );

  assert.equal(removed.state.apps.installed.some(({ id }) => id === module.id), false);
  assert.ok(removed.state.capabilities.grants[0].revokedAt);
  assert.ok(removed.state.capabilities.grants[0].revokedAt >= granted.state.capabilities.grants[0].issuedAt);
  const global = await repository.get("kernel", "global");
  assert.equal(global.grants[0].revokedAt, removed.state.capabilities.grants[0].revokedAt);
  assert.equal((await repository.get("grants", global.grants[0].id)).revokedAt, global.grants[0].revokedAt);
});

test("rejects undeclared capability grants before preparing a durable request", async () => {
  const repository = new MemoryRepository();
  const module = validateAppManifest({
    protocol: "greenways-app/1",
    id: "notes-room",
    version: "0.1.0",
    publisher: { id: "example", name: "Example" },
    name: "Notes Room",
    description: "A module without signing authority.",
    category: "installable",
    capabilities: ["hara/module"],
    launch: { handler: "hal-module" },
    kind: "hal-module",
    channel: "preview",
    lockDigest: `sha256:${"c".repeat(64)}`,
    source: {
      kind: "github",
      owner: "example",
      repo: "notes-room",
      sha: "d".repeat(40),
    },
  });
  await repository.put("kernel", "global", {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 1,
    installed: [module],
    grants: [],
    receipts: [],
    updatedAt: "2026-08-06T00:00:00.000Z",
  });
  const rig = createRig({ repository });

  await assert.rejects(
    dispatch(
      rig.host,
      LAUNCHER_A,
      "request/capability-denied-1003",
      "capabilities/grant",
      [{
        id: "grant/notes-room-0001",
        appId: module.id,
        capability: "key/sign",
        constraints: {},
      }],
    ),
    (error) => error.code === "CAPABILITY_DENIED" && /does not declare key\/sign/.test(error.message),
  );
  assert.deepEqual(rig.kernelRepository.prepared, []);
  assert.deepEqual(rig.kernelRepository.commits, []);
});


test("root DevTools has a fixed call surface and no state-changing dispatches", async () => {
  const calls = [];
  const rig = createRig({
    devtools: {
      async call(method, args) { calls.push([method, args]); return { method, args }; },
    },
  });
  assert.deepEqual(await rig.host.call(DEVTOOLS_A, "devtools/status", []), {
    ok: true,
    protocol: KERNEL_PROTOCOL,
    value: { method: "devtools/status", args: [] },
  });
  assert.deepEqual(calls, [["devtools/status", []]]);
  await assert.rejects(
    rig.host.call(LAUNCHER_A, "devtools/status", []),
    (error) => error.code === "METHOD_DENIED",
  );
  await assert.rejects(
    dispatch(rig.host, DEVTOOLS_A, "request/devtools-dispatch-9001", "apps/install", [getAppManifest("historia")]),
    (error) => error.code === "METHOD_DENIED",
  );
});
