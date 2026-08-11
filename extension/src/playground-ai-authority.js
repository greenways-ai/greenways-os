import { getAppManifest, validateAppManifest } from "./app-catalog.js";
import { sameManifestApproval } from "./app-launch.js";
import { activeCapabilityGrant } from "./core-services.js";
import { store } from "./storage.js";
import { MODEL_GENERATE_CAPABILITY } from "./ai-service.js";
import { PLAYGROUND_APP_ID } from "./playground-ai-protocol.js";

export const PLAYGROUND_CAPABILITY_STATUS_PROTOCOL = "greenways-playground-capability-status/0-alpha";
const KERNEL_GLOBAL_PROTOCOL = "greenways-kernel-global/0-alpha";

function frozenStatus({ installed, eligible, grant, reason }) {
  return Object.freeze({
    protocol: PLAYGROUND_CAPABILITY_STATUS_PROTOCOL,
    appId: PLAYGROUND_APP_ID,
    capability: MODEL_GENERATE_CAPABILITY,
    installed,
    eligible,
    granted: Boolean(grant),
    allowed: Boolean(eligible && grant),
    reason,
    grant: grant ?? null,
  });
}

export class PlaygroundAiAuthority {
  constructor({ repository = store, now = () => new Date() } = {}) {
    if (!repository || typeof repository.get !== "function") {
      throw new TypeError("Playground AI authority requires the Greenways store");
    }
    if (typeof now !== "function") throw new TypeError("Playground AI authority requires a clock");
    this.repository = repository;
    this.now = now;
  }

  async status() {
    const current = getAppManifest(PLAYGROUND_APP_ID);
    if (!current || !current.capabilities.includes(MODEL_GENERATE_CAPABILITY)) {
      return frozenStatus({
        installed: false,
        eligible: false,
        grant: null,
        reason: "catalog-capability-missing",
      });
    }

    const global = await this.repository.get("kernel", "global");
    if (!global || global.protocol !== KERNEL_GLOBAL_PROTOCOL || !Array.isArray(global.installed)) {
      return frozenStatus({
        installed: false,
        eligible: false,
        grant: null,
        reason: "kernel-not-initialized",
      });
    }

    const candidate = global.installed.find(({ id }) => id === PLAYGROUND_APP_ID);
    if (!candidate) {
      return frozenStatus({ installed: false, eligible: false, grant: null, reason: "app-not-installed" });
    }

    let installed;
    try {
      installed = validateAppManifest(candidate);
    } catch {
      return frozenStatus({ installed: true, eligible: false, grant: null, reason: "app-approval-invalid" });
    }
    if (!sameManifestApproval(installed, current)) {
      return frozenStatus({ installed: true, eligible: false, grant: null, reason: "app-approval-stale" });
    }

    let grant = null;
    try {
      grant = activeCapabilityGrant(
        Array.isArray(global.grants) ? global.grants : [],
        installed,
        MODEL_GENERATE_CAPABILITY,
        { now: this.now },
      );
    } catch {
      return frozenStatus({ installed: true, eligible: true, grant: null, reason: "grant-record-invalid" });
    }
    return frozenStatus({
      installed: true,
      eligible: true,
      grant,
      reason: grant ? "allowed" : "grant-required",
    });
  }

  async assert() {
    const status = await this.status();
    if (status.allowed) return status;
    const error = new Error(
      status.installed
        ? "Hara Playground requires an active model/generate grant in Greenways OS"
        : "Hara Playground is not installed in Greenways OS",
    );
    error.code = status.installed ? "CAPABILITY_DENIED" : "APP_NOT_INSTALLED";
    error.status = status;
    throw error;
  }
}
