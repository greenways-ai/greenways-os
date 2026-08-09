import assert from "node:assert/strict";
import test from "node:test";
import {
  TAHTO_MONITOR_ALARM,
  applyTahtoMonitorSample,
  classifyTahtoInspection,
  createTahtoMonitor,
  createTahtoMonitorSample,
} from "../src/tahto-monitor.js";

function inspection(overrides = {}) {
  return {
    health: { status: "ready" },
    status: {
      fabric: {
        metadataProvider: "ready",
        objectUpload: "ready",
        semanticFabric: "ready",
        semanticRoutes: "ready",
        resultVerificationProvider: "ready",
        ...overrides,
      },
    },
  };
}

test("separates ready, not-ready, and degraded component state", () => {
  assert.equal(classifyTahtoInspection(inspection()).state, "ready");
  assert.equal(classifyTahtoInspection(inspection({ semanticRoutes: "not-exposed" })).state, "not-ready");
  assert.equal(classifyTahtoInspection(inspection({ metadataProvider: "degraded" })).state, "degraded");
});

test("opens an incident after two runtime failures and closes it on recovery", () => {
  const sample = (at, state) => ({
    protocol: "greenways-tahto-monitor-sample/1",
    origin: "https://tahto.example",
    checkedAt: at,
    latencyMs: 1,
    source: "background",
    state,
    checks: {},
    error: state === "unreachable" ? "offline" : null,
  });
  let record = applyTahtoMonitorSample(null, sample("2026-08-09T00:00:00.000Z", "unreachable"));
  assert.equal(record.incidents.length, 0);
  record = applyTahtoMonitorSample(record, sample("2026-08-09T00:05:00.000Z", "unreachable"));
  assert.equal(record.incidents.length, 1);
  record = applyTahtoMonitorSample(record, sample("2026-08-09T00:10:00.000Z", "ready"));
  assert.equal(record.incidents[0].closedAt, "2026-08-09T00:10:00.000Z");
});

test("retains at most seven days and 2016 five-minute samples", () => {
  const origin = "https://tahto.example";
  const end = Date.parse("2026-08-09T00:00:00.000Z");
  const previous = {
    samples: Array.from({ length: 2100 }, (_, index) => ({
      checkedAt: new Date(end - (2100 - index) * 5 * 60 * 1000).toISOString(),
    })),
    incidents: [],
  };
  const latest = createTahtoMonitorSample({
    origin,
    checkedAt: new Date(end).toISOString(),
    latencyMs: 1,
    source: "background",
    inspection: inspection(),
  });
  const record = applyTahtoMonitorSample(previous, latest, end);
  assert.equal(record.samples.length, 2016);
  assert.ok(record.samples.every(({ checkedAt }) => Date.parse(checkedAt) >= end - 7 * 24 * 60 * 60 * 1000));
});

test("polls only the selected default node and stores a bounded sample", async () => {
  const writes = [];
  const settings = {
    async get() {
      return {
        protocol: "greenways-tahto-nodes/1",
        defaultOrigin: "https://default.example",
        nodes: [
          { origin: "https://default.example", label: "Default", descriptor: {}, health: {}, status: {}, connectedAt: "2026-08-09T00:00:00.000Z", checkedAt: "2026-08-09T00:00:00.000Z" },
          { origin: "https://other.example", label: "Other", descriptor: {}, health: {}, status: {}, connectedAt: "2026-08-09T00:00:00.000Z", checkedAt: "2026-08-09T00:00:00.000Z" },
        ],
      };
    },
  };
  // The production normalizer validates full node records; isolate monitor routing here.
  const clients = [];
  const records = { async get() { return null; }, async put(value) { writes.push(value); } };
  const monitor = createTahtoMonitor({
    settings,
    records,
    normalizeState: (value) => value,
    clientFactory(origin) {
      clients.push(origin);
      return { async inspect() { return inspection(); } };
    },
    now: () => new Date("2026-08-09T00:05:00.000Z"),
  });
  const result = await monitor.check();
  assert.deepEqual(clients, ["https://default.example"]);
  assert.equal(writes.length, 1);
  assert.equal(result.origin, "https://default.example");
  assert.equal(result.latest.state, "ready");
});

test("schedules one five-minute Chrome alarm", async () => {
  const calls = [];
  const monitor = createTahtoMonitor({ alarms: { async create(...args) { calls.push(args); } } });
  assert.equal(await monitor.schedule(), true);
  assert.deepEqual(calls, [[TAHTO_MONITOR_ALARM, { periodInMinutes: 5 }]]);
});

test("unreachable samples retain only a bounded error", () => {
  const sample = createTahtoMonitorSample({
    origin: "https://tahto.example",
    checkedAt: "2026-08-09T00:00:00.000Z",
    latencyMs: 3,
    source: "manual",
    error: new Error("x".repeat(500)),
  });
  assert.equal(sample.state, "unreachable");
  assert.equal(sample.error.length, 240);
});
