import {
  BUILTIN_APPS,
  SYSTEM_APP_IDS,
  getAppManifest,
  validateAppManifest,
} from "./app-catalog.js";
import { resolveAppUrl, sameManifestApproval } from "./app-launch.js";
import { canonical, sha256 } from "./protocol.js";
import {
  activeCapabilityGrant,
  createCapabilityGrant,
  validateCapabilityGrant,
} from "./core-services.js";
import {
  USERSCRIPTS_APP_ID,
  USERSCRIPTS_CAPABILITY,
} from "./userscripts-runtime.js";
import {
  CHATS_APP_ID,
  CHATS_CAPABILITY,
} from "./chats-runtime.js";
import {
  kernelStore,
  store,
} from "./storage.js";

export const KERNEL_PROTOCOL = "greenways-kernel/1";
export const KERNEL_GLOBAL_PROTOCOL = "greenways-kernel-global/1";
export const KERNEL_CONTEXT_RECORD_PROTOCOL = "greenways-kernel-context-record/1";

const CLIENT_ID = /^[a-z0-9][a-z0-9._:/-]{15,127}$/i;
const REQUEST_ID = /^[a-z0-9][a-z0-9._:/-]{15,127}$/i;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPTS = 128;
const SYSTEM_IDS = new Set(SYSTEM_APP_IDS);
const RETIRED_APP_IDS = new Set(["greenways-home", "hestia-connector", "hara-playground", "historia"]);
const NON_REPLAYABLE_EFFECTS = new Set([
  "browser/open-app",
  "export/studio-project",
]);

const CLIENT_POLICY = Object.freeze({
  launcher: Object.freeze({
    calls: new Set([
      "core/services",
      "capabilities/vocabulary",
      "capabilities/list",
      "capabilities/check",
      "userscripts/status",
      "userscripts/list",
      "userscripts/save",
      "userscripts/remove",
      "userscripts/set-enabled",
      "chats/status",
      "chats/list",
      "chats/search",
      "chats/import",
      "chats/capture",
      "chats/remove",
      "chats/set-capture",
    ]),
    dispatches: new Set([
      "apps/install",
      "apps/update",
      "apps/open",
      "apps/remove",
      "capabilities/grant",
      "capabilities/revoke",
      "surface/close",
    ]),
  }),
  world: Object.freeze({
    calls: new Set([
      "catalog/search",
      "world/open",
      "world/render",
      "core/services",
      "capabilities/vocabulary",
      "capabilities/check",
    ]),
    dispatches: new Set([
      "world/touchpoint",
      "surface/close",
      "studio/add-track",
      "studio/remove-track",
      "studio/export-project",
    ]),
  }),
  devtools: Object.freeze({
    calls: new Set([
      "core/services",
      "capabilities/vocabulary",
      "capabilities/list",
      "capabilities/check",
      "devtools/status",
      "devtools/modules",
      "devtools/eval",
      "devtools/call",
    ]),
    dispatches: new Set(),
  }),
});

const STATEFUL_CALLS = new Set(["capabilities/list", "capabilities/check"]);

const EFFECT_POLICY = Object.freeze({
  "apps/install": new Set(["storage/save-apps"]),
  "apps/update": new Set(["storage/save-apps", "storage/save-grants"]),
  "capabilities/grant": new Set(["storage/save-grants"]),
  "capabilities/revoke": new Set(["storage/save-grants"]),
  "apps/open": new Set(["browser/open-app", "ui/open-surface"]),
  "apps/remove": new Set(["storage/save-apps", "storage/save-grants", "ui/close-surface"]),
  "world/touchpoint": new Set(["ui/open-surface"]),
  "surface/close": new Set(["ui/close-surface"]),
  "studio/add-track": new Set(),
  "studio/remove-track": new Set(),
  "studio/export-project": new Set(["export/studio-project"]),
});

function errorWithCode(message, code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw errorWithCode(`${label} must be an object`, "INVALID_REQUEST");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw errorWithCode(`${label} must be a plain object`, "INVALID_REQUEST");
  }
  return value;
}

function closedKeys(value, allowed, label) {
  for (const key of Object.keys(plainObject(value, label))) {
    if (!allowed.has(key)) throw errorWithCode(`${label} contains an unknown field: ${key}`, "INVALID_REQUEST");
  }
}

function boundedJson(value, label) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw errorWithCode(`${label} must be JSON serializable`, "INVALID_REQUEST");
  }
  if (encoded === undefined || encoded.length > MAX_REQUEST_BYTES) {
    throw errorWithCode(`${label} exceeds the kernel message limit`, "INVALID_REQUEST");
  }
  return value;
}

function identifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw errorWithCode(`${label} is invalid`, "INVALID_REQUEST");
  }
  return value;
}

function principalPolicy(principal) {
  const policy = CLIENT_POLICY[principal?.kind];
  if (!policy) throw errorWithCode("This extension page is not a kernel client", "CALLER_DENIED");
  identifier(principal.clientId, CLIENT_ID, "Kernel client id");
  return policy;
}

function effectKey(effect) {
  return `${effect?.effect}/${effect?.method}`;
}

function manifestsEqual(left, right) {
  return canonical(left) === canonical(right);
}

function validateEffects(method, effects, nextState) {
  if (!Array.isArray(effects)) throw errorWithCode("Hara effects must be an array", "KERNEL_CONTRACT");
  const allowed = EFFECT_POLICY[method];
  if (!allowed) throw errorWithCode(`No effect policy for ${method}`, "KERNEL_CONTRACT");
  const seen = new Set();
  for (const effect of effects) {
    plainObject(effect, "Hara effect");
    const key = effectKey(effect);
    if (!allowed.has(key)) {
      throw errorWithCode(`Hara emitted an unauthorized effect for ${method}: ${key}`, "KERNEL_CONTRACT");
    }
    if (seen.has(key)) throw errorWithCode(`Hara emitted a duplicate effect: ${key}`, "KERNEL_CONTRACT");
    seen.add(key);
    if (!Array.isArray(effect.args ?? [])) throw errorWithCode(`Hara effect ${key} has invalid arguments`, "KERNEL_CONTRACT");
    boundedJson(effect.args ?? [], `Hara effect ${key}`);
    if (key === "storage/save-apps" && !manifestsEqual(effect.args?.[0] ?? [], nextState?.apps?.installed ?? [])) {
      throw errorWithCode("Hara app persistence intent does not match its next state", "KERNEL_CONTRACT");
    }
    if (key === "storage/save-grants" && !manifestsEqual(
      effect.args?.[0] ?? [],
      nextState?.capabilities?.grants ?? [],
    )) {
      throw errorWithCode("Hara capability persistence intent does not match its next state", "KERNEL_CONTRACT");
    }
  }
  return effects;
}

function requireCurrentAppApproval(method, args, nextState) {
  if (method !== "apps/open") return;
  const appId = args[0];
  const approved = nextState?.apps?.installed?.find((manifest) => manifest.id === appId);
  const current = getAppManifest(appId);
  if (!approved || !sameManifestApproval(approved, current)) {
    throw errorWithCode(
      "This app requires approval for its current version and capabilities",
      "APP_APPROVAL_REQUIRED",
    );
  }
}

function requireBundledCatalogManifest(method, args) {
  if (method !== "apps/install" && method !== "apps/update") return;
  let proposed;
  try {
    proposed = validateAppManifest(args[0]);
  } catch (error) {
    throw errorWithCode("App installation requires a valid bundled manifest", "APP_CATALOG_MISMATCH", { cause: error });
  }
  const current = getAppManifest(proposed.id);
  if (!current || !manifestsEqual(proposed, current)) {
    throw errorWithCode("App installation does not match the bundled catalog", "APP_CATALOG_MISMATCH");
  }
}

async function capabilityDispatchArguments(method, args, state, now, capabilityAuthority) {
  if (method === "apps/update" || method === "apps/remove") {
    return [...args, now.toISOString()];
  }
  if (method === "capabilities/grant") {
    if (args.length !== 1) {
      throw errorWithCode("Capability grant requires one request", "INVALID_REQUEST");
    }
    const request = plainObject(args[0], "Capability grant request");
    const manifest = state?.apps?.installed?.find(({ id }) => id === request.appId);
    if (!manifest) throw errorWithCode("Capability grant app is not installed", "APP_NOT_INSTALLED");
    try {
      await capabilityAuthority.assert({
        appId: request.appId,
        capability: request.capability,
      }, {
        installed: state?.apps?.installed ?? [],
      });
      return [createCapabilityGrant(request, manifest, { now: () => now })];
    } catch (error) {
      const denied = errorWithCode(error.message, "CAPABILITY_DENIED", { cause: error });
      if (error?.decision) denied.decision = error.decision;
      throw denied;
    }
  }
  if (method === "capabilities/revoke") {
    if (args.length !== 1 || typeof args[0] !== "string") {
      throw errorWithCode("Capability revocation requires one grant id", "INVALID_REQUEST");
    }
    const grant = state?.capabilities?.grants?.find(({ id }) => id === args[0]);
    if (!grant) throw errorWithCode("Capability grant does not exist", "CAPABILITY_NOT_FOUND");
    const currentTime = now.toISOString();
    // Browser and operating-system clocks can move backwards. A revocation is
    // still final, so pin its recorded time to at least the grant issuance.
    const revokedAt = grant.issuedAt > currentTime ? grant.issuedAt : currentTime;
    return [args[0], revokedAt];
  }
  return args;
}

function defaultGlobal(installed, updatedAt) {
  return {
    protocol: KERNEL_GLOBAL_PROTOCOL,
    revision: 0,
    installed,
    grants: [],
    receipts: [],
    updatedAt,
  };
}

function validateGlobal(value) {
  plainObject(value, "Kernel global state");
  if (value.protocol !== KERNEL_GLOBAL_PROTOCOL) {
    throw errorWithCode("Stored kernel global state uses an unsupported protocol", "RECOVERY_REQUIRED");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw errorWithCode("Stored kernel revision is invalid", "RECOVERY_REQUIRED");
  }
  if (!Array.isArray(value.installed) || !Array.isArray(value.receipts)) {
    throw errorWithCode("Stored kernel global state is incomplete", "RECOVERY_REQUIRED");
  }
  let installed;
  try {
    installed = value.installed.map((manifest) => validateAppManifest(manifest));
  } catch (error) {
    throw errorWithCode("Stored kernel app approval is invalid", "RECOVERY_REQUIRED", { cause: error });
  }
  const ids = installed.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) {
    throw errorWithCode("Stored kernel app approvals contain duplicate ids", "RECOVERY_REQUIRED");
  }
  let grants;
  try {
    grants = (value.grants ?? []).map(validateCapabilityGrant);
  } catch (error) {
    throw errorWithCode("Stored kernel capability grant is invalid", "RECOVERY_REQUIRED", { cause: error });
  }
  const grantIds = grants.map(({ id }) => id);
  if (new Set(grantIds).size !== grantIds.length) {
    throw errorWithCode("Stored kernel capability grants contain duplicate ids", "RECOVERY_REQUIRED");
  }
  return { ...value, installed, grants };
}

function migrateInstalledApprovals(values) {
  const input = Array.isArray(values) ? values : [];
  const hadHistoria = input.some((candidate) => candidate?.id === "historia");
  const output = input.filter((candidate) => !RETIRED_APP_IDS.has(candidate?.id));
  if (hadHistoria && !output.some(({ id }) => id === CHATS_APP_ID)) output.push(getAppManifest(CHATS_APP_ID));
  return output;
}

function revokeRetiredGrants(values, revokedAt) {
  return (Array.isArray(values) ? values : []).map((grant) => (
    RETIRED_APP_IDS.has(grant?.subject?.appId) && !grant.revokedAt
      ? { ...grant, revokedAt: grant.issuedAt > revokedAt ? grant.issuedAt : revokedAt }
      : grant
  ));
}

function validateContext(value, principal) {
  plainObject(value, "Kernel context state");
  if (value.protocol !== KERNEL_CONTEXT_RECORD_PROTOCOL
      || value.clientId !== principal.clientId
      || value.kind !== principal.kind
      || !Number.isSafeInteger(value.revision)
      || value.revision < 0
      || !value.checkpoint) {
    throw errorWithCode("Stored kernel context is invalid", "RECOVERY_REQUIRED");
  }
  return value;
}

function receiptFor(global, requestId) {
  return global.receipts.find((receipt) => receipt.id === requestId);
}

function responseError(error) {
  return {
    ok: false,
    protocol: KERNEL_PROTOCOL,
    error: error?.message || String(error),
    code: error?.code || "KERNEL_FAILURE",
  };
}

export class BrowserKernelHost {
  constructor({
    invoke,
    repository = store,
    kernelRepository = kernelStore,
    capabilityAuthority,
    runtime = globalThis.chrome?.runtime,
    tabs = globalThis.chrome?.tabs,
    devtools,
    userscripts,
    chats,
    now = () => new Date(),
  }) {
    if (typeof invoke !== "function") throw new TypeError("Kernel host requires a Hara invoker");
    if (!repository) throw new TypeError("Kernel host requires durable storage");
    if (!capabilityAuthority
      || typeof capabilityAuthority.check !== "function"
      || typeof capabilityAuthority.assert !== "function") {
      throw new TypeError("Kernel host requires a capability authority gate");
    }
    if (devtools !== undefined && typeof devtools?.call !== "function") {
      throw new TypeError("Kernel host DevTools runtime must expose call()");
    }
    if (userscripts !== undefined && typeof userscripts?.call !== "function") {
      throw new TypeError("Kernel host userscripts runtime must expose call()");
    }
    if (chats !== undefined && typeof chats?.call !== "function") {
      throw new TypeError("Kernel host Chats runtime must expose call()");
    }
    this.invoke = invoke;
    this.devtools = devtools ?? Object.freeze({
      async call() {
        throw errorWithCode("Root DevTools runtime is unavailable", "DEVTOOLS_UNAVAILABLE");
      },
    });
    this.userscripts = userscripts ?? Object.freeze({
      async call() {
        throw errorWithCode("Userscripts runtime is unavailable", "USERSCRIPTS_UNAVAILABLE");
      },
    });
    this.chats = chats ?? Object.freeze({
      async call() {
        throw errorWithCode("Chats runtime is unavailable", "CHATS_UNAVAILABLE");
      },
    });
    this.repository = repository;
    this.kernelRepository = kernelRepository;
    this.capabilityAuthority = capabilityAuthority;
    this.runtime = runtime;
    this.tabs = tabs;
    this.now = now;
    this.pending = Promise.resolve();
    this.inflight = new Map();
  }

  enqueue(operation) {
    const current = this.pending.then(operation);
    this.pending = current.catch(() => {});
    return current;
  }

  async legacyInstalledApps() {
    const stored = await this.repository.values("apps");
    const optional = [];
    const seen = new Set(SYSTEM_APP_IDS);
    for (const candidate of stored) {
      if (RETIRED_APP_IDS.has(candidate?.id)) continue;
      try {
        const manifest = validateAppManifest(candidate);
        if (SYSTEM_IDS.has(manifest.id) || seen.has(manifest.id)) continue;
        optional.push(manifest);
        seen.add(manifest.id);
      } catch {
        // Invalid or unsupported approvals are retained in IndexedDB for recovery,
        // but they never enter executable kernel state.
      }
    }
    const installed = [
      ...BUILTIN_APPS.filter(({ id }) => SYSTEM_IDS.has(id)),
      ...optional,
    ];
    if (stored.some(({ id } = {}) => id === "historia") && !installed.some(({ id }) => id === CHATS_APP_ID)) {
      installed.push(getAppManifest(CHATS_APP_ID));
    }
    const initial = await this.invoke("app/bootstrap", []);
    const restored = await this.invoke("apps/restore", [initial, installed]);
    return restored.state.apps.installed;
  }

  async globalState() {
    const stored = await this.repository.get("kernel", "global");
    if (stored) {
      const needsRetiredMigration = stored.installed?.some((candidate) => RETIRED_APP_IDS.has(candidate?.id))
        || stored.grants?.some((grant) => RETIRED_APP_IDS.has(grant?.subject?.appId) && !grant.revokedAt);
      const migrationTime = needsRetiredMigration ? this.now().toISOString() : stored.updatedAt;
      const global = validateGlobal({
        ...stored,
        installed: migrateInstalledApprovals(stored.installed),
        grants: revokeRetiredGrants(stored.grants, migrationTime),
      });
      const installed = [
        ...BUILTIN_APPS.filter(({ id }) => SYSTEM_IDS.has(id)),
        ...global.installed.filter(({ id }) => !SYSTEM_IDS.has(id)),
      ];
      const projectionUpgrade = stored.grants === undefined;
      const migrated = !manifestsEqual(stored.installed, installed)
        || !manifestsEqual(stored.grants ?? [], global.grants);
      if (!manifestsEqual(global.installed, installed) || projectionUpgrade || migrated) {
        const upgraded = {
          ...global,
          installed,
          revision: global.revision + 1,
          updatedAt: this.now().toISOString(),
        };
        await this.kernelRepository.replaceGlobal({
          globalEnvelope: upgraded,
          apps: installed,
          grants: global.grants,
        });
        return upgraded;
      }
      return global;
    }
    const global = defaultGlobal(
      await this.legacyInstalledApps(),
      this.now().toISOString(),
    );
    await this.kernelRepository.replaceGlobal({
      globalEnvelope: global,
      apps: global.installed,
      grants: global.grants,
    });
    return global;
  }

  contextKey(clientId) {
    return `context:${clientId}`;
  }

  async assertUserscriptsAuthority() {
    const global = await this.globalState();
    const installed = global.installed ?? [];
    const manifest = installed.find(({ id }) => id === USERSCRIPTS_APP_ID);
    if (!manifest) {
      throw errorWithCode("The Userscripts app is not installed", "APP_NOT_INSTALLED");
    }
    await this.capabilityAuthority.assert({
      appId: USERSCRIPTS_APP_ID,
      capability: USERSCRIPTS_CAPABILITY,
    }, { installed });
    if (!activeCapabilityGrant(global.grants ?? [], manifest, USERSCRIPTS_CAPABILITY, { now: this.now })) {
      throw errorWithCode(
        "Userscript management requires an active userscripts/manage grant",
        "CAPABILITY_DENIED",
      );
    }
  }

  async assertChatsAuthority() {
    const global = await this.globalState();
    const installed = global.installed ?? [];
    const manifest = installed.find(({ id }) => id === CHATS_APP_ID);
    if (!manifest) throw errorWithCode("The Chats app is not installed", "APP_NOT_INSTALLED");
    await this.capabilityAuthority.assert({ appId: CHATS_APP_ID, capability: CHATS_CAPABILITY }, { installed });
    if (!activeCapabilityGrant(global.grants ?? [], manifest, CHATS_CAPABILITY, { now: this.now })) {
      throw errorWithCode("Chat capture requires an active chats/capture grant", "CAPABILITY_DENIED");
    }
  }

  async captureChatObservation(observation) {
    await this.assertChatsAuthority();
    return this.chats.capture(observation);
  }

  async initialCheckpoint() {
    return this.invoke("app/checkpoint", [await this.invoke("app/bootstrap", [])]);
  }

  async contextState(principal) {
    const key = this.contextKey(principal.clientId);
    const stored = await this.repository.get("kernel", key);
    if (stored) return validateContext(stored, principal);
    const context = {
      protocol: KERNEL_CONTEXT_RECORD_PROTOCOL,
      clientId: principal.clientId,
      kind: principal.kind,
      revision: 0,
      checkpoint: await this.initialCheckpoint(),
      updatedAt: this.now().toISOString(),
    };
    await this.repository.put("kernel", key, context);
    return context;
  }

  async compose(global, context) {
    const state = await this.invoke("app/restore", [context.checkpoint, global.installed, global.grants ?? []]);
    const activeId = state.apps?.active;
    const activeApprovalInvalid = Boolean(
      activeId
      && !SYSTEM_IDS.has(activeId)
      && !sameManifestApproval(
        global.installed.find(({ id }) => id === activeId),
        getAppManifest(activeId),
      )
    );
    const surfaceId = state.surface?.active;
    const packagedSurface = BUILTIN_APPS.find((manifest) => (
      manifest.launch?.handler === "packaged-surface"
      && manifest.launch.surfaceId === surfaceId
    ));
    const surfaceApprovalInvalid = Boolean(packagedSurface && (
      state.surface?.payload?.appId !== packagedSurface.id
      || activeId !== packagedSurface.id
      || !sameManifestApproval(
        global.installed.find(({ id }) => id === packagedSurface.id),
        packagedSurface,
      )
    ));
    if (!activeApprovalInvalid && !surfaceApprovalInvalid) return state;
    return this.invoke("app/restore", [{
      ...context.checkpoint,
      apps: { active: null },
      surface: { active: null, payload: null },
    }, global.installed, global.grants ?? []]);
  }

  snapshot(global, context, state) {
    return {
      protocol: KERNEL_PROTOCOL,
      contextId: context.clientId,
      kind: context.kind,
      globalRevision: global.revision,
      contextRevision: context.revision,
      state,
    };
  }

  async attach(principal) {
    principalPolicy(principal);
    return this.enqueue(async () => {
      const global = await this.globalState();
      const context = await this.contextState(principal);
      const state = await this.compose(global, context);
      return { ok: true, ...this.snapshot(global, context, state) };
    });
  }

  async call(principal, method, args = []) {
    const policy = principalPolicy(principal);
    if (!policy.calls.has(method)) throw errorWithCode(`Kernel call is not available to ${principal.kind}: ${method}`, "METHOD_DENIED");
    boundedJson(args, "Kernel call arguments");
    return this.enqueue(async () => {
      let invokeArgs = args;
      let authority = null;
      if (STATEFUL_CALLS.has(method)) {
        const [global, context] = await Promise.all([
          this.globalState(),
          this.contextState(principal),
        ]);
        const state = await this.compose(global, context);
        if (method === "capabilities/check") {
          authority = await this.capabilityAuthority.check({
            appId: args[0],
            capability: args[1],
          }, {
            installed: state?.apps?.installed ?? [],
          });
          if (!authority.allowed) {
            return {
              ok: true,
              protocol: KERNEL_PROTOCOL,
              value: null,
              authority,
            };
          }
          invokeArgs = [state, ...args, this.now().toISOString()];
        } else {
          invokeArgs = [state, ...args];
        }
      }
      const response = {
        ok: true,
        protocol: KERNEL_PROTOCOL,
        value: method.startsWith("devtools/")
          ? await this.devtools.call(method, invokeArgs)
          : method.startsWith("userscripts/")
            ? await this.userscripts.call(method, invokeArgs)
            : method.startsWith("chats/")
              ? await this.chats.call(method, invokeArgs)
            : await this.invoke(method, invokeArgs),
      };
      if (authority) response.authority = authority;
      return response;
    });
  }

  dispatch(principal, request) {
    principalPolicy(principal);
    closedKeys(request, new Set(["requestId", "method", "args", "expectedGlobalRevision", "expectedContextRevision"]), "Kernel dispatch");
    const requestId = identifier(request.requestId, REQUEST_ID, "Kernel request id");
    if (this.inflight.has(requestId)) return this.inflight.get(requestId);
    const operation = this.enqueue(() => this.runDispatch(principal, {
      requestId,
      method: request.method,
      args: boundedJson(request.args ?? [], "Kernel dispatch arguments"),
      expectedGlobalRevision: request.expectedGlobalRevision,
      expectedContextRevision: request.expectedContextRevision,
    }));
    this.inflight.set(requestId, operation);
    operation.then(
      () => this.inflight.delete(requestId),
      () => this.inflight.delete(requestId),
    );
    return operation;
  }

  async runDispatch(principal, request) {
    const policy = principalPolicy(principal);
    if (!policy.dispatches.has(request.method)) {
      throw errorWithCode(`Kernel dispatch is not available to ${principal.kind}: ${request.method}`, "METHOD_DENIED");
    }
    if (!Array.isArray(request.args)) throw errorWithCode("Kernel dispatch arguments must be an array", "INVALID_REQUEST");
    requireBundledCatalogManifest(request.method, request.args);

    const [global, context] = await Promise.all([
      this.globalState(),
      this.contextState(principal),
    ]);
    const requestHash = await sha256(canonical({
      clientId: principal.clientId,
      kind: principal.kind,
      method: request.method,
      args: request.args,
    }));
    const receipt = receiptFor(global, request.requestId);
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        throw errorWithCode("Kernel request id was reused with different content", "REQUEST_ID_REUSE");
      }
      const currentContext = await this.contextState(principal);
      return {
        ok: true,
        replayed: true,
        ...this.snapshot(global, currentContext, await this.compose(global, currentContext)),
      };
    }
    const prepared = await this.kernelRepository.getRequest(request.requestId);
    if (prepared) {
      if (prepared.requestHash !== requestHash) {
        throw errorWithCode("Kernel request id was reused with different content", "REQUEST_ID_REUSE");
      }
      throw errorWithCode(
        "The previous kernel attempt ended during an external effect; its outcome is uncertain and it was not replayed",
        "EFFECT_OUTCOME_UNKNOWN",
      );
    }
    if (request.expectedGlobalRevision !== undefined && request.expectedGlobalRevision !== global.revision) {
      throw errorWithCode("Kernel profile state changed before this request", "REVISION_CONFLICT");
    }
    if (request.expectedContextRevision !== undefined && request.expectedContextRevision !== context.revision) {
      throw errorWithCode("Kernel page state changed before this request", "REVISION_CONFLICT");
    }

    const previousState = await this.compose(global, context);
    const operationTime = this.now();
    const dispatchArgs = await capabilityDispatchArguments(
      request.method,
      request.args,
      previousState,
      operationTime,
      this.capabilityAuthority,
    );
    const result = await this.invoke(request.method, [previousState, ...dispatchArgs]);
    if (!result || typeof result !== "object" || !result.state) {
      throw errorWithCode(`Hara method ${request.method} did not return session state`, "KERNEL_CONTRACT");
    }
    let grants;
    try {
      grants = (result.state.capabilities?.grants ?? global.grants ?? []).map(validateCapabilityGrant);
    } catch (error) {
      throw errorWithCode("Hara returned an invalid capability grant", "KERNEL_CONTRACT", { cause: error });
    }
    const nextState = {
      ...result.state,
      capabilities: { grants },
    };
    const effects = validateEffects(request.method, result.effects ?? [], nextState);
    requireCurrentAppApproval(request.method, request.args, nextState);
    await this.kernelRepository.prepareRequest(request.requestId, {
      protocol: KERNEL_PROTOCOL,
      status: "prepared",
      id: request.requestId,
      requestHash,
      clientId: principal.clientId,
      kind: principal.kind,
      method: request.method,
      preparedAt: this.now().toISOString(),
    });

    let nonReplayableEffectAttempted = false;
    try {
      for (const effect of effects) {
        if (NON_REPLAYABLE_EFFECTS.has(effectKey(effect))) nonReplayableEffectAttempted = true;
        await this.executeEffect(effect, {
          principal,
          method: request.method,
          requestId: request.requestId,
          state: nextState,
        });
      }

      const installed = nextState.apps?.installed ?? [];
      const globalChanged = !manifestsEqual(global.installed, installed)
        || !manifestsEqual(global.grants ?? [], grants);
      const nextGlobal = {
        ...global,
        installed,
        grants,
        revision: global.revision + (globalChanged ? 1 : 0),
        receipts: [...global.receipts, {
          id: request.requestId,
          requestHash,
          method: request.method,
          globalRevision: global.revision + (globalChanged ? 1 : 0),
          contextRevision: context.revision + 1,
          committedAt: this.now().toISOString(),
        }].slice(-MAX_RECEIPTS),
        updatedAt: this.now().toISOString(),
      };
      const nextContext = {
        ...context,
        revision: context.revision + 1,
        checkpoint: await this.invoke("app/checkpoint", [nextState]),
        updatedAt: this.now().toISOString(),
      };
      await this.kernelRepository.commit({
        globalEnvelope: nextGlobal,
        contextId: principal.clientId,
        contextEnvelope: nextContext,
        apps: installed,
        grants,
        requestId: request.requestId,
      });
      const snapshot = this.snapshot(nextGlobal, nextContext, nextState);
      await this.broadcast(snapshot).catch(() => {});
      return {
        ok: true,
        ...snapshot,
        result: { state: nextState, effects: [] },
      };
    } catch (error) {
      // Tabs and downloads cannot be compensated. Retain the prepared receipt
      // after either is attempted so the same request is never blindly replayed.
      let failure = error;
      if (!nonReplayableEffectAttempted) {
        await this.kernelRepository.abortRequest(request.requestId).catch(() => {});
      } else {
        failure = errorWithCode(
          "The external effect may have completed before its kernel commit failed; it was not replayed",
          "EFFECT_OUTCOME_UNKNOWN",
          { cause: error },
        );
      }
      const rollback = this.snapshot(global, context, previousState);
      await this.broadcast({ ...rollback, rollback: true }).catch(() => {});
      throw failure;
    }
  }

  async executeEffect(effect, context) {
    const key = effectKey(effect);
    if (key === "storage/save-apps" || key === "storage/save-grants") return;
    if (key === "browser/open-app") {
      const [appId] = effect.args ?? [];
      const approved = context.state.apps?.installed?.find((manifest) => manifest.id === appId);
      const current = getAppManifest(appId);
      if (!approved || !sameManifestApproval(approved, current)) {
        throw errorWithCode("This app requires approval for its current version and capabilities", "APP_APPROVAL_REQUIRED");
      }
      const tab = await this.tabs.create({ url: resolveAppUrl(appId, this.runtime) });
      if (!tab) throw new Error("The browser did not create an app tab");
      return;
    }
    const response = await this.runtime.sendMessage({
      type: "greenways/kernel/effect",
      protocol: KERNEL_PROTOCOL,
      contextId: context.principal.clientId,
      requestId: context.requestId,
      method: context.method,
      effects: [effect],
      tentativeState: context.state,
    });
    if (!response?.ok) {
      throw errorWithCode(response?.error || `The ${key} page effect was not acknowledged`, "CLIENT_EFFECT_FAILED");
    }
  }

  broadcast(snapshot) {
    return this.runtime.sendMessage({
      type: "greenways/kernel/update",
      protocol: KERNEL_PROTOCOL,
      globalInstalled: snapshot.state?.apps?.installed ?? [],
      ...snapshot,
    });
  }
}

export function serializeKernelError(error) {
  return responseError(error);
}
