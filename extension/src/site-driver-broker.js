import { randomId } from "./protocol.js";
import {
  SITE_DRIVER_CONTENT_MESSAGE_TYPE,
  SITE_DRIVER_REQUEST_PROTOCOL,
  TRIPO_STUDIO_DRIVER_ID,
  createSiteDriverResult,
  getSiteDriverDescriptor,
  normalizeSiteDriverRequest,
  siteDriverPromptRoot,
  siteDriverSupportsUrl,
} from "./site-driver-protocol.js";

export const SITE_DRIVER_SESSION_PROTOCOL = "greenways-site-driver-session/1";
export const SITE_DRIVER_SESSION_STORAGE_KEY = "greenways/site-driver/attachments";
const CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const MAX_SUBMITTED_REQUESTS = 64;

function requiredApi(value, methods, label) {
  if (!value || methods.some((method) => typeof value[method] !== "function")) {
    throw new Error(`${label} is unavailable`);
  }
  return value;
}

function sessionArea(value = globalThis.chrome?.storage?.session) {
  return requiredApi(value, ["get", "set"], "Chrome session storage");
}

function tabsApi(value = globalThis.chrome?.tabs) {
  return requiredApi(value, ["get", "sendMessage"], "Chrome tabs API");
}

function scriptingApi(value = globalThis.chrome?.scripting) {
  return requiredApi(value, ["executeScript"], "Chrome scripting API");
}

function nowMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Site-driver clock returned an invalid value");
  return milliseconds;
}

function canonicalTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function boundedSubmitted(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string"))].slice(-MAX_SUBMITTED_REQUESTS);
}

function normalizeStoredAttachment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.protocol !== SITE_DRIVER_SESSION_PROTOCOL) return null;
  const descriptor = getSiteDriverDescriptor(value.driverId);
  if (!descriptor || !Number.isSafeInteger(value.tabId) || value.tabId <= 0) return null;
  const staged = value.staged && typeof value.staged === "object" && !Array.isArray(value.staged)
    ? {
        requestId: String(value.staged.requestId ?? ""),
        promptRoot: String(value.staged.promptRoot ?? ""),
        promptLength: Number(value.staged.promptLength ?? 0),
      }
    : null;
  return {
    protocol: SITE_DRIVER_SESSION_PROTOCOL,
    driverId: descriptor.id,
    tabId: value.tabId,
    url: String(value.url ?? ""),
    attachedAt: String(value.attachedAt ?? ""),
    staged: staged?.requestId && staged?.promptRoot ? staged : null,
    submittedRequestIds: boundedSubmitted(value.submittedRequestIds),
  };
}

function publicAttachment(record) {
  if (!record) return null;
  return Object.freeze({
    protocol: SITE_DRIVER_SESSION_PROTOCOL,
    driverId: record.driverId,
    tabId: record.tabId,
    url: record.url,
    attachedAt: record.attachedAt,
    staged: record.staged ? Object.freeze({ ...record.staged }) : null,
    submittedRequestIds: Object.freeze([...record.submittedRequestIds]),
  });
}

export class SiteDriverBroker {
  constructor({
    tabs,
    scripting,
    sessionStorage,
    now = () => new Date(),
    tokenFactory = () => randomId("site-confirmation"),
  } = {}) {
    this.tabs = tabsApi(tabs);
    this.scripting = scriptingApi(scripting);
    this.sessionStorage = sessionArea(sessionStorage);
    if (typeof now !== "function") throw new TypeError("Site-driver clock must be a function");
    if (typeof tokenFactory !== "function") throw new TypeError("Site-driver token factory must be a function");
    this.now = now;
    this.tokenFactory = tokenFactory;
    this.attachments = new Map();
    this.confirmations = new Map();
    this.hydrated = false;
    this.pending = Promise.resolve();
  }

  enqueue(operation) {
    const current = this.pending.then(operation);
    this.pending = current.catch(() => {});
    return current;
  }

  async hydrate() {
    if (this.hydrated) return;
    const stored = await this.sessionStorage.get(SITE_DRIVER_SESSION_STORAGE_KEY);
    const values = stored?.[SITE_DRIVER_SESSION_STORAGE_KEY] ?? [];
    if (Array.isArray(values)) {
      for (const value of values) {
        const record = normalizeStoredAttachment(value);
        if (record) this.attachments.set(record.driverId, record);
      }
    }
    this.hydrated = true;
  }

  async persist() {
    await this.sessionStorage.set({
      [SITE_DRIVER_SESSION_STORAGE_KEY]: [...this.attachments.values()].map((record) => ({
        ...record,
        staged: record.staged ? { ...record.staged } : null,
        submittedRequestIds: [...record.submittedRequestIds],
      })),
    });
  }

  async tabFor(descriptor, tabId) {
    const tab = await this.tabs.get(tabId);
    if (!tab || tab.incognito) throw new Error("The selected Tripo tab is unavailable or incognito");
    const url = tab.url ?? tab.pendingUrl;
    if (!siteDriverSupportsUrl(descriptor, url)) {
      throw new Error(`Open ${descriptor.name} at ${descriptor.routes[0]} before attaching`);
    }
    return { tab, url: new URL(url).href };
  }

  async inject(descriptor, tabId) {
    await this.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [descriptor.contentScript],
    });
  }

  async contentCommand(descriptor, tabId, command, { retry = true } = {}) {
    const message = {
      type: SITE_DRIVER_CONTENT_MESSAGE_TYPE,
      command: {
        protocol: SITE_DRIVER_REQUEST_PROTOCOL,
        driverId: descriptor.id,
        ...command,
      },
    };
    try {
      const response = await this.tabs.sendMessage(tabId, message);
      if (!response?.ok) throw new Error(response?.error || `${descriptor.name} driver command failed`);
      return response.result;
    } catch (error) {
      if (!retry) throw error;
      await this.inject(descriptor, tabId);
      return this.contentCommand(descriptor, tabId, command, { retry: false });
    }
  }

  async currentRecord(driverId) {
    await this.hydrate();
    const record = this.attachments.get(driverId);
    if (!record) throw new Error("Attach a Tripo Studio tab first");
    return record;
  }

  async validateRecord(record) {
    const descriptor = getSiteDriverDescriptor(record.driverId);
    const { url } = await this.tabFor(descriptor, record.tabId);
    if (url !== record.url) {
      record.url = url;
      await this.persist();
    }
    return descriptor;
  }

  async attach(request) {
    const descriptor = getSiteDriverDescriptor(request.driverId);
    const { url } = await this.tabFor(descriptor, request.tabId);
    await this.inject(descriptor, request.tabId);
    const probe = await this.contentCommand(descriptor, request.tabId, {
      operation: "probe",
      requestId: null,
      args: {},
    }, { retry: false });
    if (!["compatible", "logged-out", "degraded"].includes(probe?.state)) {
      throw new Error(probe?.message || `${descriptor.name} page is not compatible with this driver`);
    }
    const timestamp = canonicalTime(nowMilliseconds(this.now));
    const previous = this.attachments.get(descriptor.id);
    const record = {
      protocol: SITE_DRIVER_SESSION_PROTOCOL,
      driverId: descriptor.id,
      tabId: request.tabId,
      url,
      attachedAt: timestamp,
      staged: previous?.tabId === request.tabId ? previous.staged : null,
      submittedRequestIds: previous?.tabId === request.tabId
        ? boundedSubmitted(previous.submittedRequestIds)
        : [],
    };
    this.attachments.set(descriptor.id, record);
    this.confirmations.delete(descriptor.id);
    await this.persist();
    return createSiteDriverResult({
      driverId: descriptor.id,
      operation: "attach",
      state: probe.state,
      message: probe.message,
      attachment: publicAttachment(record),
      probe,
    });
  }

  async status(request) {
    await this.hydrate();
    const record = this.attachments.get(request.driverId) ?? null;
    if (!record) {
      return createSiteDriverResult({
        driverId: request.driverId,
        operation: "status",
        state: "detached",
        message: "No Tripo Studio tab is attached.",
        attachment: null,
      });
    }
    try {
      const descriptor = await this.validateRecord(record);
      const probe = await this.contentCommand(descriptor, record.tabId, {
        operation: "probe",
        requestId: null,
        args: {},
      });
      return createSiteDriverResult({
        driverId: request.driverId,
        operation: "status",
        state: probe.state,
        message: probe.message,
        attachment: publicAttachment(record),
        probe,
      });
    } catch (error) {
      this.attachments.delete(request.driverId);
      this.confirmations.delete(request.driverId);
      await this.persist();
      return createSiteDriverResult({
        driverId: request.driverId,
        operation: "status",
        state: "detached",
        message: error?.message || "The attached Tripo Studio tab is no longer available.",
        attachment: null,
      });
    }
  }

  async stagePrompt(request) {
    const record = await this.currentRecord(request.driverId);
    const descriptor = await this.validateRecord(record);
    const promptRoot = await siteDriverPromptRoot({
      driverId: request.driverId,
      requestId: request.requestId,
      prompt: request.args.prompt,
    });
    const result = await this.contentCommand(descriptor, record.tabId, {
      operation: "stage-prompt",
      requestId: request.requestId,
      args: { prompt: request.args.prompt, promptRoot },
    });
    if (result?.promptRoot !== promptRoot) throw new Error("Tripo Studio did not retain the staged prompt exactly");
    record.staged = {
      requestId: request.requestId,
      promptRoot,
      promptLength: request.args.prompt.length,
    };
    this.confirmations.delete(request.driverId);
    await this.persist();
    return createSiteDriverResult({
      driverId: request.driverId,
      operation: "stage-prompt",
      requestId: request.requestId,
      state: "staged",
      message: "The prompt is staged in Tripo Studio.",
      promptRoot,
      promptLength: request.args.prompt.length,
      attachment: publicAttachment(record),
    });
  }

  async review(request) {
    const record = await this.currentRecord(request.driverId);
    const descriptor = await this.validateRecord(record);
    if (!record.staged || record.staged.requestId !== request.requestId) {
      throw new Error("Stage this exact request before reviewing it");
    }
    if (record.submittedRequestIds.includes(request.requestId)) {
      throw new Error("This Greenways request was already submitted to Tripo Studio");
    }
    const result = await this.contentCommand(descriptor, record.tabId, {
      operation: "review",
      requestId: request.requestId,
      args: {},
    });
    if (result?.promptRoot !== record.staged.promptRoot) {
      throw new Error("The prompt in Tripo Studio changed after it was staged");
    }
    if (!result.canSubmit) throw new Error(result.message || "Tripo Studio is not ready to generate");
    const issuedAt = nowMilliseconds(this.now);
    const confirmation = {
      token: this.tokenFactory(),
      requestId: request.requestId,
      promptRoot: record.staged.promptRoot,
      expiresAt: issuedAt + CONFIRMATION_TTL_MS,
    };
    this.confirmations.set(request.driverId, confirmation);
    return createSiteDriverResult({
      driverId: request.driverId,
      operation: "review",
      requestId: request.requestId,
      state: "awaiting-confirmation",
      message: "Review the staged prompt and confirm one Tripo Studio generation.",
      promptRoot: record.staged.promptRoot,
      confirmationToken: confirmation.token,
      confirmationExpiresAt: canonicalTime(confirmation.expiresAt),
      visibleCreditCost: result.visibleCreditCost ?? null,
      submitLabel: result.submitLabel,
    });
  }

  async submit(request) {
    const record = await this.currentRecord(request.driverId);
    const descriptor = await this.validateRecord(record);
    if (!record.staged || record.staged.requestId !== request.requestId) {
      throw new Error("Stage this exact request before submitting it");
    }
    if (record.submittedRequestIds.includes(request.requestId)) {
      throw new Error("This Greenways request was already submitted to Tripo Studio");
    }
    const confirmation = this.confirmations.get(request.driverId);
    const time = nowMilliseconds(this.now);
    if (!confirmation
        || confirmation.token !== request.args.confirmationToken
        || confirmation.requestId !== request.requestId
        || confirmation.promptRoot !== record.staged.promptRoot
        || confirmation.expiresAt <= time) {
      throw new Error("The Tripo Studio confirmation is missing, stale, or does not match this request");
    }
    const reviewed = await this.contentCommand(descriptor, record.tabId, {
      operation: "review",
      requestId: request.requestId,
      args: {},
    });
    if (!reviewed?.canSubmit || reviewed.promptRoot !== record.staged.promptRoot) {
      throw new Error(reviewed?.message || "Tripo Studio is no longer ready to submit this request");
    }

    // Record the one-shot boundary before activating the paid action. If the
    // browser loses the response after the click, Greenways fails closed and
    // will not risk submitting the same request a second time.
    record.submittedRequestIds = boundedSubmitted([
      ...record.submittedRequestIds,
      request.requestId,
    ]);
    this.confirmations.delete(request.driverId);
    await this.persist();

    let result;
    try {
      result = await this.contentCommand(descriptor, record.tabId, {
        operation: "submit",
        requestId: request.requestId,
        args: { promptRoot: record.staged.promptRoot },
      }, { retry: false });
    } catch (error) {
      throw new Error(
        "Tripo Studio submission outcome is unknown. Greenways will not retry this request; inspect the attached tab before creating a new request.",
        { cause: error },
      );
    }
    return createSiteDriverResult({
      driverId: request.driverId,
      operation: "submit",
      requestId: request.requestId,
      state: result?.state || "submitted",
      message: result?.message || "Tripo Studio generation was submitted once.",
      promptRoot: record.staged.promptRoot,
      attachment: publicAttachment(record),
    });
  }

  async observe(request) {
    const record = await this.currentRecord(request.driverId);
    const descriptor = await this.validateRecord(record);
    const result = await this.contentCommand(descriptor, record.tabId, {
      operation: "observe",
      requestId: request.requestId,
      args: {
        submitted: Boolean(request.requestId
          && record.submittedRequestIds.includes(request.requestId)),
      },
    });
    return createSiteDriverResult({
      driverId: request.driverId,
      operation: "observe",
      requestId: request.requestId,
      state: result?.state || "unknown",
      message: result?.message || "Tripo Studio state was observed.",
      progress: result?.progress ?? null,
      attachment: publicAttachment(record),
    });
  }

  async detach(request) {
    await this.hydrate();
    const record = this.attachments.get(request.driverId);
    if (record) {
      const descriptor = getSiteDriverDescriptor(request.driverId);
      await this.contentCommand(descriptor, record.tabId, {
        operation: "detach",
        requestId: null,
        args: {},
      }).catch(() => {});
    }
    this.attachments.delete(request.driverId);
    this.confirmations.delete(request.driverId);
    await this.persist();
    return createSiteDriverResult({
      driverId: request.driverId,
      operation: "detach",
      state: "detached",
      message: "The Tripo Studio tab was detached.",
      attachment: null,
    });
  }

  async handle(value) {
    const request = normalizeSiteDriverRequest(value);
    return this.enqueue(async () => {
      if (request.operation === "attach") return this.attach(request);
      if (request.operation === "status") return this.status(request);
      if (request.operation === "stage-prompt") return this.stagePrompt(request);
      if (request.operation === "review") return this.review(request);
      if (request.operation === "submit") return this.submit(request);
      if (request.operation === "observe") return this.observe(request);
      if (request.operation === "detach") return this.detach(request);
      throw new Error(`Unsupported site-driver operation: ${request.operation}`);
    });
  }
}

export function createTripoSiteDriverBroker(options = {}) {
  return new SiteDriverBroker(options);
}

export { TRIPO_STUDIO_DRIVER_ID };
