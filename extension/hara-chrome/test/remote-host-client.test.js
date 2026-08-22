import assert from "node:assert/strict";
import { test } from "node:test";

import { createHaraRelayHostClient } from "../src/remote-host-client.js";
import { LOOPBACK_RELAY_PROTOCOL, canonicalJson } from "../src/remote-host-protocol.js";
import {
  TEST_HOST_ID,
  TEST_REQUEST_ID,
  TEST_SOURCE_DIGEST,
  TEST_TOKEN,
  eventually,
  startFakeRelay,
  testDescriptor,
  testRequest,
  testResult,
} from "./remote-host-fixtures.js";

function clientFor(relay, executor, overrides = {}) {
  return createHaraRelayHostClient({
    relayUrl: relay.url,
    pairingToken: TEST_TOKEN,
    descriptor: testDescriptor(),
    executor,
    requestTimeoutMs: 500,
    minBackoffMs: 1,
    maxBackoffMs: 5,
    maxPollWaitMs: 1,
    stopGraceMs: 50,
    random: () => 0,
    ...overrides,
  });
}

function after(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test("outbound client registers, acknowledges one execute command, and submits one bound terminal result", async (t) => {
  const descriptor = testDescriptor();
  const request = testRequest();
  const commandId = `relay:${request.requestId}:execute`;
  let polls = 0;
  let terminalBody = null;
  let executeCalls = 0;
  const relay = await startFakeRelay({
    onPoll(body) {
      polls += 1;
      if (polls === 1) {
        return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "execute", commandId, request };
      }
      return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "idle", retryAfterMs: 1 };
    },
    onResult(body) {
      terminalBody = body;
      return { protocol: LOOPBACK_RELAY_PROTOCOL, accepted: true, duplicate: false };
    },
  });
  t.after(relay.close);

  const client = clientFor(relay, {
    async execute(received) {
      executeCalls += 1;
      assert.deepEqual(received, request);
      return after(25, testResult(received, descriptor));
    },
  });
  t.after(() => client.stop());

  const ready = await client.start();
  assert.equal(ready.connectionState, "ready");
  await eventually(() => terminalBody);

  assert.equal(executeCalls, 1);
  assert.equal(terminalBody.hostId, TEST_HOST_ID);
  assert.equal(terminalBody.generation, descriptor.generation);
  assert.equal(terminalBody.result.requestId, TEST_REQUEST_ID);
  assert.equal(terminalBody.result.diagnostics[0].code, "transport-fixture");
  assert.equal(
    relay.requests.some(({ path, body }) => path === "/v0/host/poll" && body.acknowledgedCommandId === commandId),
    true,
  );
  for (const { body } of relay.requests) assert.equal(JSON.stringify(body).includes(TEST_TOKEN), false);
  assert.equal(JSON.stringify(client.status()).includes(TEST_TOKEN), false);
});

test("identical execute redelivery is acknowledged without starting a second executor", async (t) => {
  const descriptor = testDescriptor();
  const request = testRequest();
  const command = {
    protocol: LOOPBACK_RELAY_PROTOCOL,
    kind: "execute",
    commandId: `relay:${request.requestId}:execute`,
    request,
  };
  let polls = 0;
  let executeCalls = 0;
  let submitted = false;
  const relay = await startFakeRelay({
    onPoll() {
      polls += 1;
      if (polls <= 2) return command;
      return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "idle", retryAfterMs: 1 };
    },
    onResult() {
      submitted = true;
      return { protocol: LOOPBACK_RELAY_PROTOCOL, accepted: true, duplicate: false };
    },
  });
  t.after(relay.close);

  const client = clientFor(relay, {
    async execute(received) {
      executeCalls += 1;
      return after(35, testResult(received, descriptor));
    },
  });
  t.after(() => client.stop());
  await client.start();
  await eventually(() => submitted);
  assert.equal(executeCalls, 1);
  assert.ok(polls >= 2);
});

test("changed command content under one command ID faults closed", async (t) => {
  const request = testRequest();
  const commandId = `relay:${request.requestId}:execute`;
  let polls = 0;
  let executeCalls = 0;
  const relay = await startFakeRelay({
    onPoll() {
      polls += 1;
      if (polls === 1) {
        return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "execute", commandId, request };
      }
      return {
        protocol: LOOPBACK_RELAY_PROTOCOL,
        kind: "execute",
        commandId,
        request: testRequest({ source: "(+ 41 1)", sourceDigest: `sha256:${"3".repeat(64)}` }),
      };
    },
  });
  t.after(relay.close);

  const client = clientFor(relay, {
    execute(_received, { signal }) {
      executeCalls += 1;
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), {
          once: true,
        });
      });
    },
  });
  t.after(() => client.stop());
  await client.start();
  const faulted = await eventually(() => client.status().connectionState === "faulted" && client.status());
  assert.equal(executeCalls, 1);
  assert.equal(faulted.lastError.code, "remote/command-collision");
});

test("a relay cancel command reaches the active executor once and returns a matching cancelled result", async (t) => {
  const descriptor = testDescriptor();
  const request = testRequest();
  let polls = 0;
  let cancelCalls = 0;
  let terminalBody = null;
  const relay = await startFakeRelay({
    onPoll() {
      polls += 1;
      if (polls === 1) {
        return {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "execute",
          commandId: `relay:${request.requestId}:execute`,
          request,
        };
      }
      if (polls === 2) {
        return {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "cancel",
          commandId: `relay:${request.requestId}:cancel`,
          requestId: request.requestId,
          reason: "client-cancelled",
        };
      }
      return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "idle", retryAfterMs: 1 };
    },
    onResult(body) {
      terminalBody = body;
      return { protocol: LOOPBACK_RELAY_PROTOCOL, accepted: true, duplicate: false };
    },
  });
  t.after(relay.close);

  const client = clientFor(relay, {
    execute(received, { signal }) {
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          resolve(testResult(received, descriptor, {
            status: "cancelled",
            value: null,
            diagnostics: [{
              code: "transport-fixture-cancelled",
              severity: "warning",
              message: "Fixture cancellation only.",
            }],
          }));
        }, { once: true });
      });
    },
    async cancel(receivedRequestId, reason) {
      cancelCalls += 1;
      assert.equal(receivedRequestId, request.requestId);
      assert.equal(reason, "client-cancelled");
    },
  });
  t.after(() => client.stop());
  await client.start();
  await eventually(() => terminalBody);

  assert.equal(cancelCalls, 1);
  assert.equal(terminalBody.result.status, "cancelled");
});

test("a lost terminal response reconnects and retries the exact immutable result", async (t) => {
  const descriptor = testDescriptor();
  const request = testRequest();
  let polls = 0;
  let registrations = 0;
  const terminalBodies = [];
  const relay = await startFakeRelay({
    onRegister() {
      registrations += 1;
      return {
        protocol: LOOPBACK_RELAY_PROTOCOL,
        accepted: true,
        hostId: descriptor.hostId,
        generation: descriptor.generation,
        heartbeatTtlMs: 5_000,
        pollAfterMs: 1,
      };
    },
    onPoll() {
      polls += 1;
      if (polls === 1) {
        return {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "execute",
          commandId: `relay:${request.requestId}:execute`,
          request,
        };
      }
      return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "idle", retryAfterMs: 1 };
    },
    onResult(body, { response }) {
      terminalBodies.push(body);
      if (terminalBodies.length === 1) {
        response.destroy();
        return null;
      }
      return { protocol: LOOPBACK_RELAY_PROTOCOL, accepted: true, duplicate: true };
    },
  });
  t.after(relay.close);

  const client = clientFor(relay, {
    async execute(received) {
      return testResult(received, descriptor);
    },
  });
  t.after(() => client.stop());
  await client.start();
  await eventually(() => terminalBodies.length === 2);

  assert.ok(registrations >= 2);
  assert.equal(canonicalJson(terminalBodies[0]), canonicalJson(terminalBodies[1]));
  assert.equal(client.status().pendingTerminal, false);
});

test("stopping aborts active fixture work and clears retained transport state", async (t) => {
  const request = testRequest();
  let cancelCalls = 0;
  let polls = 0;
  const relay = await startFakeRelay({
    onPoll() {
      polls += 1;
      if (polls === 1) {
        return {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "execute",
          commandId: `relay:${request.requestId}:execute`,
          request,
        };
      }
      return { protocol: LOOPBACK_RELAY_PROTOCOL, kind: "idle", retryAfterMs: 1 };
    },
  });
  t.after(relay.close);

  const client = clientFor(relay, {
    execute(_received, { signal }) {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), {
          once: true,
        });
      });
    },
    async cancel(requestId, reason) {
      cancelCalls += 1;
      assert.equal(requestId, TEST_REQUEST_ID);
      assert.equal(reason, "relay-closing");
    },
  });
  await client.start();
  await eventually(() => client.status().activeRequestId === TEST_REQUEST_ID);
  const stopped = await client.stop();

  assert.equal(cancelCalls, 1);
  assert.equal(stopped.connectionState, "stopped");
  assert.equal(stopped.activeRequestId, null);
  assert.equal(stopped.pendingTerminal, false);
  assert.equal(stopped.desiredState, "stopped");
  assert.equal(stopped.lastError?.message?.includes(TEST_TOKEN) ?? false, false);
  assert.equal(TEST_SOURCE_DIGEST.length, 71);
});

test("registration identity changes and authentication failures are fatal without leaking the token", async (t) => {
  const descriptor = testDescriptor();
  const changed = await startFakeRelay({
    onRegister() {
      return {
        protocol: LOOPBACK_RELAY_PROTOCOL,
        accepted: true,
        hostId: descriptor.hostId,
        generation: descriptor.generation + 1,
        heartbeatTtlMs: 5_000,
        pollAfterMs: 1,
      };
    },
  });
  t.after(changed.close);
  const changedClient = clientFor(changed, { async execute() { throw new Error("must not execute"); } });
  await assert.rejects(changedClient.start(), (error) => error.code === "remote/registration-unbound");
  assert.equal(changedClient.status().connectionState, "faulted");
  await changedClient.stop();

  const protectedRelay = await startFakeRelay();
  t.after(protectedRelay.close);
  const wrongToken = "wrong-loopback-token-00000001";
  const unauthorizedClient = createHaraRelayHostClient({
    relayUrl: protectedRelay.url,
    pairingToken: wrongToken,
    descriptor,
    executor: { async execute() { throw new Error("must not execute"); } },
    requestTimeoutMs: 500,
    minBackoffMs: 1,
    maxBackoffMs: 1,
    maxPollWaitMs: 1,
  });
  await assert.rejects(unauthorizedClient.start(), (error) => error.code === "authentication_failed");
  assert.equal(JSON.stringify(unauthorizedClient.status()).includes(wrongToken), false);
  await unauthorizedClient.stop();
});

test("one request ID cannot be rebound to a different execute command ID", async (t) => {
  const request = testRequest();
  let polls = 0;
  const relay = await startFakeRelay({
    onPoll() {
      polls += 1;
      if (polls === 1) {
        return {
          protocol: LOOPBACK_RELAY_PROTOCOL,
          kind: "execute",
          commandId: `relay:${request.requestId}:execute`,
          request,
        };
      }
      return {
        protocol: LOOPBACK_RELAY_PROTOCOL,
        kind: "execute",
        commandId: `relay:${request.requestId}:execute-replacement`,
        request,
      };
    },
  });
  t.after(relay.close);
  const client = clientFor(relay, {
    execute(_received, { signal }) {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" })), {
          once: true,
        });
      });
    },
  });
  t.after(() => client.stop());
  await client.start();
  const faulted = await eventually(() => client.status().connectionState === "faulted" && client.status());
  assert.equal(faulted.lastError.code, "remote/request-command-collision");
});

test("stop permits an explicit clean restart while close is terminal", async (t) => {
  let registrations = 0;
  let closes = 0;
  const relay = await startFakeRelay({
    onRegister(body) {
      registrations += 1;
      return {
        protocol: LOOPBACK_RELAY_PROTOCOL,
        accepted: true,
        hostId: body.descriptor.hostId,
        generation: body.descriptor.generation,
        heartbeatTtlMs: 5_000,
        pollAfterMs: 1,
      };
    },
  });
  t.after(relay.close);
  const client = clientFor(relay, {
    async execute() { throw new Error("must not execute"); },
    async close() { closes += 1; },
  });

  await client.start();
  await client.stop();
  await client.start();
  const closed = await client.close();
  assert.equal(registrations, 2);
  assert.equal(closes, 1);
  assert.equal(closed.connectionState, "closed");
  await assert.rejects(client.start(), (error) => error.code === "remote/closed");
});
