import {
  TAHTO_SETTINGS_KEY,
  TahtoClient,
  normalizeTahtoNodeState,
} from "./tahto-client.js";
import { fabricStore, store } from "./storage.js";

export const TAHTO_MONITOR_PROTOCOL = "greenways-tahto-monitor/0-alpha";
export const TAHTO_MONITOR_ALARM = "greenways:tahto-monitor";
export const TAHTO_MONITOR_PERIOD_MINUTES = 5;
export const TAHTO_MONITOR_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const TAHTO_MONITOR_MAX_SAMPLES = 2016;
export const TAHTO_MONITOR_TIMEOUT_MS = 5000;

const NOT_READY = /(not-ready|not-installed|not-exposed|not-wired|pending|service-pending)/;
const DEGRADED = /(degraded|failed|error|unavailable|invalid)/;

function componentState(value) {
  const status = String(value ?? "").toLowerCase();
  if (DEGRADED.test(status)) return "degraded";
  if (NOT_READY.test(status)) return "not-ready";
  return status.includes("ready") ? "ready" : "not-ready";
}

export function classifyTahtoInspection({ health, status }) {
  const fabric = status?.fabric ?? {};
  const checks = Object.freeze({
    controlPlane: componentState(health?.status),
    metadata: componentState(fabric.metadataProvider),
    objects: componentState(fabric.objectUpload ?? fabric.objectCapability),
    semantic: componentState(fabric.semanticFabric),
    semanticRoutes: componentState(fabric.semanticRoutes),
    verification: componentState(fabric.resultVerificationProvider),
  });
  const states = Object.values(checks);
  const state = states.includes("degraded")
    ? "degraded"
    : states.includes("not-ready") ? "not-ready" : "ready";
  return Object.freeze({ state, checks });
}

function boundedError(error) {
  const message = String(error?.message || error || "Tahto is unreachable");
  return message.slice(0, 240);
}

export function createTahtoMonitorSample({
  origin, checkedAt, latencyMs, source, inspection, diagnostics = null, diagnosticError = null, error,
}) {
  const classified = error
    ? { state: "unreachable", checks: {} }
    : classifyTahtoInspection(inspection);
  return Object.freeze({
    protocol: "greenways-tahto-monitor-sample/0-alpha",
    origin,
    checkedAt,
    latencyMs: Math.max(0, Math.round(latencyMs)),
    source,
    state: classified.state,
    checks: classified.checks,
    diagnostics,
    diagnosticError: diagnosticError ? boundedError(diagnosticError) : null,
    error: error ? boundedError(error) : null,
  });
}

export function applyTahtoMonitorSample(previous, sample, nowMs = Date.parse(sample.checkedAt)) {
  const cutoff = nowMs - TAHTO_MONITOR_RETENTION_MS;
  const samples = [...(previous?.samples ?? []), sample]
    .filter((entry) => Date.parse(entry.checkedAt) >= cutoff)
    .slice(-TAHTO_MONITOR_MAX_SAMPLES);
  const runtimeFailure = sample.state === "degraded" || sample.state === "unreachable";
  const consecutiveFailures = runtimeFailure ? (previous?.consecutiveFailures ?? 0) + 1 : 0;
  const incidents = (previous?.incidents ?? []).map((incident) => ({ ...incident }));
  const open = incidents.findLast?.((incident) => incident.closedAt === null)
    ?? [...incidents].reverse().find((incident) => incident.closedAt === null);
  if (runtimeFailure && consecutiveFailures >= 2 && !open) {
    incidents.push({
      protocol: "greenways-tahto-incident/0-alpha",
      openedAt: sample.checkedAt,
      closedAt: null,
      state: sample.state,
    });
  } else if (sample.state === "ready" && open) {
    open.closedAt = sample.checkedAt;
  }
  return {
    protocol: TAHTO_MONITOR_PROTOCOL,
    id: `tahto-monitor:${sample.origin}`,
    origin: sample.origin,
    latest: sample,
    consecutiveFailures,
    samples,
    incidents: incidents
      .filter((incident) => Date.parse(incident.openedAt) >= cutoff || incident.closedAt === null)
      .slice(-256),
  };
}

async function withTimeout(operation, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function createTahtoMonitor({
  settings = store,
  records = fabricStore,
  alarms = globalThis.chrome?.alarms,
  keyring = null,
  clientFactory = (origin, signal) => new TahtoClient({
    origin,
    keyring,
    request: (url, options) => fetch(url, { ...options, signal }),
  }),
  now = () => new Date(),
  normalizeState = normalizeTahtoNodeState,
  timeoutMs = TAHTO_MONITOR_TIMEOUT_MS,
} = {}) {
  async function record(origin, {
    inspection = null,
    diagnostics = null,
    diagnosticError = null,
    error = null,
    source = "manual",
    latencyMs = 0,
  } = {}) {
    const checkedAt = now().toISOString();
    const sample = createTahtoMonitorSample({
      origin,
      checkedAt,
      latencyMs,
      source,
      inspection,
      diagnostics,
      diagnosticError,
      error,
    });
    const id = `tahto-monitor:${origin}`;
    const next = applyTahtoMonitorSample(await records.get(id), sample, Date.parse(checkedAt));
    await records.put(next);
    return next;
  }

  async function pairedObservation(origin, inspection, signal) {
    let diagnostics = null;
    let diagnosticError = null;
    if (keyring && inspection.descriptor.routes.diagnostics) {
      const device = await keyring.status(origin);
      if (device?.deviceId) {
        try {
          diagnostics = await clientFactory(origin, signal).diagnostics();
        } catch (error) {
          diagnosticError = error;
        }
      }
    }
    return { inspection, diagnostics, diagnosticError };
  }

  async function recordInspection(origin, inspection, { source = "manual", latencyMs = 0 } = {}) {
    const observed = await withTimeout(
      (signal) => pairedObservation(origin, inspection, signal),
      timeoutMs,
    );
    return record(origin, { ...observed, source, latencyMs });
  }

  async function checkOrigin(origin, source = "manual") {
    const started = Date.now();
    try {
      const observed = await withTimeout(
        async (signal) => {
          const client = clientFactory(origin, signal);
          const inspection = await client.inspect();
          return pairedObservation(origin, inspection, signal);
        },
        timeoutMs,
      );
      return record(origin, { ...observed, source, latencyMs: Date.now() - started });
    } catch (error) {
      return record(origin, { error, source, latencyMs: Date.now() - started });
    }
  }

  async function check(source = "background") {
    const state = normalizeState(await settings.get("settings", TAHTO_SETTINGS_KEY));
    const node = state.nodes.find(({ origin }) => origin === state.defaultOrigin);
    return node ? checkOrigin(node.origin, source) : null;
  }

  async function schedule() {
    if (!alarms?.create) return false;
    await alarms.create(TAHTO_MONITOR_ALARM, { periodInMinutes: TAHTO_MONITOR_PERIOD_MINUTES });
    return true;
  }

  return Object.freeze({ check, checkOrigin, record, recordInspection, schedule });
}
