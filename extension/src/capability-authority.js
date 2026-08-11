import {
  APP_CAPABILITIES,
  getAppManifest,
  validateAppManifest,
} from "./app-catalog.js";
import {
  appApprovalIdentity,
  sameManifestApproval,
} from "./app-launch.js";
import { moduleRecordApproval } from "./module-record.js";

export const CAPABILITY_AUTHORITY_PROTOCOL = "greenways-capability-authority/0-alpha";
export const CAPABILITY_DECISION_PROTOCOL = "greenways-capability-decision/0-alpha";

const APP_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CAPABILITIES = new Set(APP_CAPABILITIES);
const CHECK_KEYS = new Set(["appId", "capability"]);

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  for (const key of Object.keys(plainObject(value, label))) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

function appId(value, label = "Capability app id") {
  if (typeof value !== "string" || !APP_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function capabilityId(value) {
  if (typeof value !== "string" || !CAPABILITIES.has(value)) {
    throw new Error(`Capability is not in the Greenways host vocabulary: ${value}`);
  }
  return value;
}

function installedManifests(context) {
  const values = context?.installed;
  if (!Array.isArray(values)) throw new TypeError("Capability authority requires installed app approvals");
  const manifests = values.map((value, index) => validateAppManifest(value, `Installed app approval ${index}`));
  const ids = manifests.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("Installed app approvals contain duplicate ids");
  return manifests;
}

function publicSubject(manifest) {
  const subject = appApprovalIdentity(manifest);
  if (!subject) return null;
  return Object.freeze({
    ...subject,
    capabilities: Object.freeze([...(subject.capabilities ?? [])]),
  });
}

function decision({ manifest, capability, allowed, reason, evidence }) {
  return Object.freeze({
    protocol: CAPABILITY_DECISION_PROTOCOL,
    allowed,
    reason,
    capability,
    subject: manifest ? publicSubject(manifest) : null,
    evidence: evidence ? Object.freeze({ ...evidence }) : null,
  });
}

/**
 * Build the immutable runtime evidence index used by capability checks.
 *
 * Every descriptor in this index is produced only after persistent lock and
 * archive evidence has been re-verified and the fresh namespace generation has
 * successfully registered in the single browser-resident Hara kernel.
 */
export function createVerifiedModuleRuntimeState(installed) {
  if (!Array.isArray(installed)) {
    throw new TypeError("Verified module runtime state requires installed module descriptors");
  }
  const entries = new Map();
  for (const [index, descriptor] of installed.entries()) {
    const input = plainObject(descriptor, `Verified module descriptor ${index}`);
    const id = appId(input.id, `Verified module descriptor ${index} app id`);
    if (typeof input.lockDigest !== "string" || !SHA256.test(input.lockDigest)) {
      throw new Error(`Verified module descriptor ${id} has an invalid lock digest`);
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      throw new Error(`Verified module descriptor ${id} has an invalid generation`);
    }
    const root = `app.${id}.g${input.generation}`;
    if (input.root !== root) {
      throw new Error(`Verified module descriptor ${id} has an invalid namespace root`);
    }
    if (entries.has(id)) {
      throw new Error(`Verified module runtime state contains duplicate app id ${id}`);
    }
    entries.set(id, Object.freeze({
      id,
      lockDigest: input.lockDigest,
      generation: input.generation,
      root,
    }));
  }
  return Object.freeze({
    get(id) {
      return entries.get(id) ?? null;
    },
    list() {
      return Object.freeze([...entries.values()]);
    },
  });
}

/**
 * Host-owned approval gate for capability grants and checks.
 *
 * This verifies only whether the exact installed app is currently eligible to
 * exercise declared authority. Active grants, expiry, revocation, and resource
 * constraints remain owned by the durable capability-grant service.
 */
export class CapabilityAuthority {
  constructor({
    moduleRepository,
    moduleVerification,
    catalog = getAppManifest,
  } = {}) {
    if (!moduleRepository || typeof moduleRepository.get !== "function") {
      throw new TypeError("Capability authority requires a module record repository");
    }
    if (!moduleVerification || typeof moduleVerification.get !== "function") {
      throw new TypeError("Capability authority requires verified module runtime state");
    }
    if (typeof catalog !== "function") throw new TypeError("Capability authority catalog must be a function");
    this.moduleRepository = moduleRepository;
    this.moduleVerification = moduleVerification;
    this.catalog = catalog;
  }

  async inspect(manifest) {
    if (manifest.launch.handler === "hal-module") {
      const stored = await this.moduleRepository.get(manifest.id);
      if (!stored) {
        return Object.freeze({ allowed: false, reason: "module-record-missing", evidence: null });
      }
      let record;
      try {
        record = moduleRecordApproval(stored);
      } catch {
        return Object.freeze({ allowed: false, reason: "module-record-invalid", evidence: null });
      }
      if (!sameManifestApproval(record.manifest, manifest)) {
        return Object.freeze({ allowed: false, reason: "module-approval-mismatch", evidence: null });
      }
      const active = await this.moduleVerification.get(manifest.id);
      if (!active || active.lockDigest !== record.lockDigest) {
        return Object.freeze({ allowed: false, reason: "module-runtime-unverified", evidence: null });
      }
      return Object.freeze({
        allowed: true,
        reason: "verified-module-runtime",
        evidence: Object.freeze({
          kind: "module-runtime",
          protocol: record.protocol,
          lockDigest: record.lockDigest,
          installedAt: record.installedAt,
          generation: Number.isSafeInteger(active.generation) ? active.generation : null,
          root: typeof active.root === "string" ? active.root : null,
        }),
      });
    }

    const current = this.catalog(manifest.id);
    if (!current || !sameManifestApproval(manifest, current)) {
      return Object.freeze({ allowed: false, reason: "catalog-approval-stale", evidence: null });
    }
    return Object.freeze({
      allowed: true,
      reason: "verified-bundled-catalog",
      evidence: Object.freeze({
        kind: "bundled-catalog",
        version: current.version,
        publisherId: current.publisher.id,
      }),
    });
  }

  async check(request, context = {}) {
    closedKeys(request, CHECK_KEYS, "Capability authority request");
    const requestedApp = appId(request.appId);
    const capability = capabilityId(request.capability);
    const manifest = installedManifests(context).find(({ id }) => id === requestedApp);
    if (!manifest) {
      return decision({ manifest: null, capability, allowed: false, reason: "app-not-installed" });
    }
    if (!manifest.capabilities.includes(capability)) {
      return decision({ manifest, capability, allowed: false, reason: "capability-not-declared" });
    }
    const inspection = await this.inspect(manifest);
    return decision({
      manifest,
      capability,
      allowed: inspection.allowed,
      reason: inspection.reason,
      evidence: inspection.evidence,
    });
  }

  async assert(request, context = {}) {
    const result = await this.check(request, context);
    if (result.allowed) return result;
    const error = new Error(`Capability authority denied: ${result.capability} (${result.reason})`);
    error.code = "CAPABILITY_DENIED";
    error.decision = result;
    throw error;
  }
}
