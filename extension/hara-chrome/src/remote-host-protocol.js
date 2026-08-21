export const EXECUTION_HOST_PROTOCOL = "hara.execution-host/0-alpha";
export const EXECUTION_RESULT_PROTOCOL = "hara.execution-result/0-alpha";
export const LOOPBACK_RELAY_PROTOCOL = "hara.loopback-relay/0-alpha";
export const PURE_PROFILE = "hara.mcp-pure/0-alpha";

export const REMOTE_HOST_OPERATIONS = Object.freeze([
  "runtime.get",
  "sandbox.eval",
  "sandbox.call",
  "sandbox.check",
]);

export const REMOTE_HOST_STATES = Object.freeze(["ready", "degraded", "offline", "revoked"]);
export const REMOTE_HOST_MAX_SOURCE_BYTES = 65_536;
export const REMOTE_HOST_MAX_OUTPUT_BYTES = 1_048_576;
export const REMOTE_HOST_MAX_WALL_MS = 30_000;
export const RELAY_MAX_BODY_BYTES = 1_310_720;
export const RELAY_MAX_POLL_MS = 5_000;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NAMESPACE = /^[^\s/]+(?:\.[^\s/]+)*$/u;
const SYMBOL = /^[^\s/]+$/u;
const CHECK_PROFILES = new Set(["reader", "compile", "namespace", "lint", "test"]);
const EXECUTION_STATUSES = new Set(["completed", "failed", "cancelled", "timed-out"]);
const CANCEL_REASONS = new Set(["client-cancelled", "deadline-exceeded", "relay-closing"]);
const textEncoder = new TextEncoder();

export class RemoteHostProtocolError extends Error {
  constructor(code, message, data = null) {
    super(message);
    this.name = "RemoteHostProtocolError";
    this.code = code;
    this.data = data;
  }
}

function fail(code, message, data = null) {
  throw new RemoteHostProtocolError(code, message, data);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function closedObject(value, label, allowed, required = allowed) {
  if (!isObject(value)) fail("remote/protocol-invalid", `${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail("remote/protocol-unknown-field", `${label} contains unknown field ${key}`, { label, key });
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail("remote/protocol-missing-field", `${label} requires field ${key}`, { label, key });
    }
  }
  return value;
}

function stringValue(value, label, { min = 1, max = 4_096, pattern = null } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    fail("remote/protocol-invalid", `${label} must be a string between ${min} and ${max} characters`);
  }
  if (pattern && !pattern.test(value)) fail("remote/protocol-invalid", `${label} has an invalid format`);
  return value;
}

function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail("remote/protocol-invalid", `${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function finiteNumber(value, label, { min = 0, max = Number.MAX_VALUE } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    fail("remote/protocol-invalid", `${label} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") fail("remote/protocol-invalid", `${label} must be boolean`);
  return value;
}

function literal(value, expected, label) {
  if (value !== expected) fail("remote/protocol-version", `${label} must be ${expected}`);
  return value;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) fail("remote/protocol-invalid", `${label} is unsupported: ${String(value)}`);
  return value;
}

function isoTimestamp(value, label) {
  stringValue(value, label, { max: 64 });
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("remote/protocol-invalid", `${label} must be an ISO-8601 timestamp`);
  }
  return value;
}

function identifier(value, label) {
  return stringValue(value, label, { max: 128, pattern: IDENTIFIER });
}

function digest(value, label) {
  return stringValue(value, label, { min: 71, max: 71, pattern: DIGEST });
}

function requestId(value, label) {
  return stringValue(value, label, { min: 36, max: 36, pattern: UUID });
}

function uniqueStringArray(value, label, { min = 1, max = 16, itemMax = 128 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail("remote/protocol-invalid", `${label} must contain between ${min} and ${max} entries`);
  }
  const result = value.map((entry, index) => stringValue(entry, `${label}[${index}]`, { max: itemMax }));
  if (new Set(result).size !== result.length) fail("remote/protocol-invalid", `${label} must not contain duplicates`);
  return result;
}

function utf8Bytes(value) {
  return textEncoder.encode(value).byteLength;
}

function jsonValue(value, label, depth = 0) {
  if (depth > 32) fail("remote/protocol-invalid", `${label} exceeds the maximum nesting depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("remote/protocol-invalid", `${label} must be finite JSON data`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024) fail("remote/protocol-invalid", `${label} contains too many array entries`);
    value.forEach((entry, index) => jsonValue(entry, `${label}[${index}]`, depth + 1));
    return value;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > 1_024) fail("remote/protocol-invalid", `${label} contains too many object fields`);
    for (const key of keys) {
      stringValue(key, `${label} key`, { max: 256 });
      jsonValue(value[key], `${label}.${key}`, depth + 1);
    }
    return value;
  }
  fail("remote/protocol-invalid", `${label} must be transfer-safe JSON data`);
}

function parseLimits(value, label) {
  closedObject(value, label, ["wallMs", "outputBytes"]);
  integer(value.wallMs, `${label}.wallMs`, { min: 1, max: REMOTE_HOST_MAX_WALL_MS });
  integer(value.outputBytes, `${label}.outputBytes`, { min: 1, max: REMOTE_HOST_MAX_OUTPUT_BYTES });
  return value;
}

function parseHostLimits(value) {
  closedObject(value, "descriptor.limits", ["maxSourceBytes", "maxOutputBytes", "maxWallMs"]);
  integer(value.maxSourceBytes, "descriptor.limits.maxSourceBytes", { min: 1, max: 16_777_216 });
  integer(value.maxOutputBytes, "descriptor.limits.maxOutputBytes", { min: 1, max: 16_777_216 });
  integer(value.maxWallMs, "descriptor.limits.maxWallMs", { min: 1, max: 300_000 });
  return value;
}

export function parseHostDescriptor(value) {
  closedObject(value, "host descriptor", [
    "protocol",
    "hostId",
    "generation",
    "kind",
    "state",
    "backend",
    "runtimeBuild",
    "haraVersion",
    "profiles",
    "operations",
    "limits",
    "observedAt",
  ]);
  literal(value.protocol, EXECUTION_HOST_PROTOCOL, "descriptor.protocol");
  identifier(value.hostId, "descriptor.hostId");
  integer(value.generation, "descriptor.generation");
  oneOf(value.kind, ["test-fixture", "browser-wasm", "native", "jvm"], "descriptor.kind");
  oneOf(value.state, REMOTE_HOST_STATES, "descriptor.state");
  stringValue(value.backend, "descriptor.backend", { max: 128 });
  digest(value.runtimeBuild, "descriptor.runtimeBuild");
  stringValue(value.haraVersion, "descriptor.haraVersion", { max: 128 });
  const profiles = uniqueStringArray(value.profiles, "descriptor.profiles");
  const operations = uniqueStringArray(value.operations, "descriptor.operations");
  for (const operation of operations) oneOf(operation, REMOTE_HOST_OPERATIONS, "descriptor operation");
  if (!profiles.includes(PURE_PROFILE)) fail("remote/host-incompatible", `descriptor must advertise ${PURE_PROFILE}`);
  if (!operations.includes("runtime.get")) fail("remote/host-incompatible", "descriptor must advertise runtime.get");
  parseHostLimits(value.limits);
  isoTimestamp(value.observedAt, "descriptor.observedAt");
  return value;
}

function parseRequestBase(value) {
  literal(value.protocol, EXECUTION_HOST_PROTOCOL, "request.protocol");
  requestId(value.requestId, "request.requestId");
  literal(value.profile, PURE_PROFILE, "request.profile");
  digest(value.sourceDigest, "request.sourceDigest");
  parseLimits(value.limits, "request.limits");
}

export function parseExecutionRequest(value) {
  if (!isObject(value)) fail("remote/protocol-invalid", "execution request must be an object");
  switch (value.operation) {
    case "sandbox.eval": {
      closedObject(value, "eval request", [
        "protocol",
        "requestId",
        "operation",
        "profile",
        "source",
        "sourceDigest",
        "limits",
      ]);
      parseRequestBase(value);
      const source = stringValue(value.source, "request.source", { max: REMOTE_HOST_MAX_SOURCE_BYTES });
      if (utf8Bytes(source) > REMOTE_HOST_MAX_SOURCE_BYTES) fail("remote/limit-exceeded", "request.source exceeds the UTF-8 byte limit");
      return value;
    }
    case "sandbox.call": {
      const allowed = [
        "protocol",
        "requestId",
        "operation",
        "profile",
        "namespace",
        "symbol",
        "arguments",
        "source",
        "sourceDigest",
        "limits",
      ];
      const required = allowed.filter((key) => key !== "source");
      closedObject(value, "call request", allowed, required);
      parseRequestBase(value);
      stringValue(value.namespace, "request.namespace", { max: 256, pattern: NAMESPACE });
      stringValue(value.symbol, "request.symbol", { max: 256, pattern: SYMBOL });
      if (!Array.isArray(value.arguments) || value.arguments.length > 64) {
        fail("remote/protocol-invalid", "request.arguments must contain at most 64 values");
      }
      value.arguments.forEach((entry, index) => jsonValue(entry, `request.arguments[${index}]`));
      if (value.source !== undefined) {
        const source = stringValue(value.source, "request.source", { min: 0, max: REMOTE_HOST_MAX_SOURCE_BYTES });
        if (utf8Bytes(source) > REMOTE_HOST_MAX_SOURCE_BYTES) fail("remote/limit-exceeded", "request.source exceeds the UTF-8 byte limit");
      }
      return value;
    }
    case "sandbox.check": {
      closedObject(value, "check request", [
        "protocol",
        "requestId",
        "operation",
        "profile",
        "source",
        "sourceDigest",
        "checkProfile",
        "limits",
      ]);
      parseRequestBase(value);
      const source = stringValue(value.source, "request.source", { max: REMOTE_HOST_MAX_SOURCE_BYTES });
      if (utf8Bytes(source) > REMOTE_HOST_MAX_SOURCE_BYTES) fail("remote/limit-exceeded", "request.source exceeds the UTF-8 byte limit");
      if (!CHECK_PROFILES.has(value.checkProfile)) fail("remote/protocol-invalid", `unsupported check profile ${String(value.checkProfile)}`);
      return value;
    }
    default:
      fail("remote/operation-unsupported", `unsupported execution operation ${String(value.operation)}`);
  }
}

function parseDiagnostic(value, index) {
  const label = `result.diagnostics[${index}]`;
  closedObject(value, label, ["code", "severity", "message", "path", "line", "column"], ["code", "severity", "message"]);
  stringValue(value.code, `${label}.code`, { max: 128 });
  oneOf(value.severity, ["info", "warning", "error"], `${label}.severity`);
  stringValue(value.message, `${label}.message`, { max: 8_192 });
  if (value.path !== undefined) stringValue(value.path, `${label}.path`, { max: 1_024 });
  if (value.line !== undefined) integer(value.line, `${label}.line`, { min: 1 });
  if (value.column !== undefined) integer(value.column, `${label}.column`, { min: 1 });
}

export function parseExecutionResult(value) {
  closedObject(value, "execution result", [
    "protocol",
    "requestId",
    "runId",
    "status",
    "value",
    "stdout",
    "stderr",
    "diagnostics",
    "runtime",
    "evidence",
  ]);
  literal(value.protocol, EXECUTION_RESULT_PROTOCOL, "result.protocol");
  requestId(value.requestId, "result.requestId");
  identifier(value.runId, "result.runId");
  if (!EXECUTION_STATUSES.has(value.status)) fail("remote/protocol-invalid", `unsupported result status ${String(value.status)}`);
  if (value.value !== null) {
    closedObject(value.value, "result.value", ["text", "json"], ["text"]);
    stringValue(value.value.text, "result.value.text", { min: 0, max: REMOTE_HOST_MAX_OUTPUT_BYTES });
    if (value.value.json !== undefined) jsonValue(value.value.json, "result.value.json");
  }
  stringValue(value.stdout, "result.stdout", { min: 0, max: REMOTE_HOST_MAX_OUTPUT_BYTES });
  stringValue(value.stderr, "result.stderr", { min: 0, max: REMOTE_HOST_MAX_OUTPUT_BYTES });
  if (!Array.isArray(value.diagnostics) || value.diagnostics.length > 256) {
    fail("remote/protocol-invalid", "result.diagnostics must contain at most 256 entries");
  }
  value.diagnostics.forEach(parseDiagnostic);
  closedObject(value.runtime, "result.runtime", ["hostId", "hostGeneration", "backend", "runtimeBuild", "haraVersion"]);
  identifier(value.runtime.hostId, "result.runtime.hostId");
  integer(value.runtime.hostGeneration, "result.runtime.hostGeneration");
  stringValue(value.runtime.backend, "result.runtime.backend", { max: 128 });
  digest(value.runtime.runtimeBuild, "result.runtime.runtimeBuild");
  stringValue(value.runtime.haraVersion, "result.runtime.haraVersion", { max: 128 });
  closedObject(value.evidence, "result.evidence", [
    "profile",
    "sourceDigest",
    "startedAt",
    "completedAt",
    "elapsedMs",
    "cleanup",
  ]);
  literal(value.evidence.profile, PURE_PROFILE, "result.evidence.profile");
  digest(value.evidence.sourceDigest, "result.evidence.sourceDigest");
  isoTimestamp(value.evidence.startedAt, "result.evidence.startedAt");
  isoTimestamp(value.evidence.completedAt, "result.evidence.completedAt");
  if (Date.parse(value.evidence.completedAt) < Date.parse(value.evidence.startedAt)) {
    fail("remote/protocol-invalid", "result.evidence.completedAt cannot precede startedAt");
  }
  finiteNumber(value.evidence.elapsedMs, "result.evidence.elapsedMs");
  oneOf(value.evidence.cleanup, ["completed", "uncertain"], "result.evidence.cleanup");
  return value;
}

export function assertResultBound(result, request, descriptor) {
  parseExecutionResult(result);
  parseExecutionRequest(request);
  parseHostDescriptor(descriptor);
  const checks = [
    [result.requestId, request.requestId, "request ID"],
    [result.runtime.hostId, descriptor.hostId, "host ID"],
    [result.runtime.hostGeneration, descriptor.generation, "host generation"],
    [result.runtime.backend, descriptor.backend, "runtime backend"],
    [result.runtime.runtimeBuild, descriptor.runtimeBuild, "runtime build"],
    [result.runtime.haraVersion, descriptor.haraVersion, "Hara version"],
    [result.evidence.profile, request.profile, "sandbox profile"],
    [result.evidence.sourceDigest, request.sourceDigest, "source digest"],
  ];
  for (const [actual, expected, label] of checks) {
    if (actual !== expected) fail("remote/result-unbound", `terminal result changed the ${label}`);
  }
  const outputBytes = utf8Bytes(JSON.stringify({
    value: result.value,
    stdout: result.stdout,
    stderr: result.stderr,
    diagnostics: result.diagnostics,
  }));
  if (outputBytes > request.limits.outputBytes) {
    fail(
      "remote/limit-exceeded",
      `terminal output exceeds the request bound of ${request.limits.outputBytes} bytes`,
    );
  }
  return result;
}

export function parseRegisterResponse(value) {
  closedObject(value, "register response", [
    "protocol",
    "accepted",
    "hostId",
    "generation",
    "heartbeatTtlMs",
    "pollAfterMs",
  ]);
  literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "register response protocol");
  if (value.accepted !== true) fail("remote/relay-rejected", "relay did not accept registration");
  identifier(value.hostId, "register response hostId");
  integer(value.generation, "register response generation");
  integer(value.heartbeatTtlMs, "register response heartbeatTtlMs", { min: 1, max: 60_000 });
  integer(value.pollAfterMs, "register response pollAfterMs", { min: 1, max: RELAY_MAX_POLL_MS });
  return value;
}

export function parseRelayCommand(value) {
  if (!isObject(value)) fail("remote/protocol-invalid", "relay command must be an object");
  switch (value.kind) {
    case "idle":
      closedObject(value, "idle command", ["protocol", "kind", "retryAfterMs"]);
      literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "idle command protocol");
      integer(value.retryAfterMs, "idle retryAfterMs", { min: 1, max: RELAY_MAX_POLL_MS });
      return value;
    case "execute":
      closedObject(value, "execute command", ["protocol", "kind", "commandId", "request"]);
      literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "execute command protocol");
      identifier(value.commandId, "execute commandId");
      parseExecutionRequest(value.request);
      return value;
    case "cancel":
      closedObject(value, "cancel command", ["protocol", "kind", "commandId", "requestId", "reason"]);
      literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "cancel command protocol");
      identifier(value.commandId, "cancel commandId");
      requestId(value.requestId, "cancel requestId");
      if (!CANCEL_REASONS.has(value.reason)) fail("remote/protocol-invalid", `unsupported cancellation reason ${String(value.reason)}`);
      return value;
    default:
      fail("remote/command-unsupported", `unsupported relay command ${String(value.kind)}`);
  }
}

export function parseAcceptedResponse(value) {
  closedObject(value, "accepted response", ["protocol", "accepted", "duplicate"]);
  literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "accepted response protocol");
  if (value.accepted !== true) fail("remote/relay-rejected", "relay did not accept terminal result");
  booleanValue(value.duplicate, "accepted response duplicate");
  return value;
}

export function parseRelayError(value) {
  closedObject(value, "relay error", ["protocol", "accepted", "error"]);
  literal(value.protocol, LOOPBACK_RELAY_PROTOCOL, "relay error protocol");
  if (value.accepted !== false) fail("remote/protocol-invalid", "relay error accepted must be false");
  closedObject(value.error, "relay error detail", ["code", "message"]);
  stringValue(value.error.code, "relay error code", { max: 128, pattern: IDENTIFIER });
  stringValue(value.error.message, "relay error message", { max: 4_096 });
  return value;
}

export function validateRelayBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("remote/config-invalid", "relay URL must be an absolute URL");
  }
  if (url.protocol !== "http:") fail("remote/config-invalid", "local relay URL must use http");
  if (url.hostname !== "127.0.0.1") fail("remote/config-invalid", "local relay URL must use 127.0.0.1");
  if (!url.port) fail("remote/config-invalid", "local relay URL must include an explicit port");
  integer(Number(url.port), "relay port", { min: 1, max: 65_535 });
  if (url.username || url.password) fail("remote/config-invalid", "relay URL must not contain credentials");
  if (url.pathname !== "/" || url.search || url.hash) {
    fail("remote/config-invalid", "relay URL must contain only the loopback origin and port");
  }
  return url.origin;
}

export function validatePairingToken(value) {
  stringValue(value, "pairing token", { min: 16, max: 512 });
  if (!/^[\x21-\x7e]+$/u.test(value)) fail("remote/config-invalid", "pairing token must contain visible ASCII without whitespace");
  return value;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(",")}}`;
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
