import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LOOPBACK_RELAY_PROTOCOL,
  RemoteHostProtocolError,
  assertResultBound,
  canonicalJson,
  parseExecutionRequest,
  parseExecutionResult,
  parseHostDescriptor,
  parseRelayCommand,
  validatePairingToken,
  validateRelayBaseUrl,
} from "../src/remote-host-protocol.js";
import { testDescriptor, testRequest, testResult } from "./remote-host-fixtures.js";

test("remote Hara protocol accepts the exact closed browser host values", () => {
  const descriptor = testDescriptor();
  const request = testRequest();
  const result = testResult(request, descriptor);

  assert.equal(parseHostDescriptor(descriptor), descriptor);
  assert.equal(parseExecutionRequest(request), request);
  assert.equal(parseExecutionResult(result), result);
  assert.equal(assertResultBound(result, request, descriptor), result);
  assert.equal(parseRelayCommand({
    protocol: LOOPBACK_RELAY_PROTOCOL,
    kind: "execute",
    commandId: `relay:${request.requestId}:execute`,
    request,
  }).kind, "execute");
});

test("unknown fields and changed terminal identity fail closed", () => {
  const descriptor = testDescriptor();
  const request = testRequest();
  assert.throws(
    () => parseHostDescriptor({ ...descriptor, trustedKernel: "ROOT" }),
    (error) => error instanceof RemoteHostProtocolError && error.code === "remote/protocol-unknown-field",
  );
  assert.throws(
    () => assertResultBound(
      testResult(request, descriptor, { runtime: { ...testResult(request, descriptor).runtime, hostGeneration: 8 } }),
      request,
      descriptor,
    ),
    (error) => error instanceof RemoteHostProtocolError && error.code === "remote/result-unbound",
  );
});

test("local relay configuration permits only explicit IPv4 loopback HTTP", () => {
  assert.equal(validateRelayBaseUrl("http://127.0.0.1:8765"), "http://127.0.0.1:8765");
  for (const value of [
    "https://127.0.0.1:8765",
    "http://localhost:8765",
    "http://0.0.0.0:8765",
    "http://[::1]:8765",
    "http://192.168.1.10:8765",
    "http://127.0.0.1",
    "http://user:password@127.0.0.1:8765",
    "http://127.0.0.1:8765/v0",
  ]) {
    assert.throws(() => validateRelayBaseUrl(value), RemoteHostProtocolError, value);
  }
});

test("pairing tokens and canonical command values are bounded and deterministic", () => {
  assert.equal(validatePairingToken("visible-token-00000001"), "visible-token-00000001");
  assert.throws(() => validatePairingToken("short"), RemoteHostProtocolError);
  assert.throws(() => validatePairingToken("token with whitespace"), RemoteHostProtocolError);
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test("UTF-8 source and aggregate terminal output are enforced as byte bounds", () => {
  const descriptor = testDescriptor();
  const oversizedSource = "界".repeat(30_000);
  assert.throws(
    () => parseExecutionRequest(testRequest({ source: oversizedSource })),
    (error) => error instanceof RemoteHostProtocolError && error.code === "remote/limit-exceeded",
  );

  const request = testRequest({ limits: { wallMs: 5_000, outputBytes: 8 } });
  assert.throws(
    () => assertResultBound(testResult(request, descriptor), request, descriptor),
    (error) => error instanceof RemoteHostProtocolError && error.code === "remote/limit-exceeded",
  );
});
