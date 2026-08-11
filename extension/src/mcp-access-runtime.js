import { GreenwaysKeyring } from "./keyring.js";
import {
  MCP_ACCESS_APP_ID,
  MCP_ACCESS_CAPABILITY,
  MCP_ACCESS_MESSAGE_TYPE,
  MCP_ACCESS_ORIGINS,
  MCP_ACCESS_PROTOCOL,
  MCP_ACCESS_SCRIPT,
  MCP_ACCESS_SCRIPT_ID,
  isApprovedMcpAuthorizationPage,
  normalizeMcpPairingChallenge,
} from "./mcp-access-protocol.js";

export {
  MCP_ACCESS_APP_ID,
  MCP_ACCESS_CAPABILITY,
  MCP_ACCESS_MESSAGE_TYPE,
  MCP_ACCESS_ORIGINS,
  MCP_ACCESS_PROTOCOL,
} from "./mcp-access-protocol.js";

export const MCP_ACCESS_METHODS = Object.freeze([
  "mcp-access/status",
  "mcp-access/set-enabled",
]);

const PAGE_OPERATIONS = new Set(["hello", "approve"]);
const PAGE_MESSAGE_KEYS = new Set(["type", "protocol", "operation", "challenge"]);

function errorWithCode(message, code = "INVALID_REQUEST") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw errorWithCode(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw errorWithCode(`${label} must be a plain object`);
  }
  return value;
}

function closedKeys(value, allowed, label) {
  const input = plainObject(value, label);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw errorWithCode(`${label} contains an unsupported field: ${key}`);
  }
  return input;
}

function normalizePageMessage(value) {
  const input = closedKeys(value, PAGE_MESSAGE_KEYS, "MCP authorization page message");
  if (input.type !== MCP_ACCESS_MESSAGE_TYPE || input.protocol !== MCP_ACCESS_PROTOCOL) {
    throw errorWithCode("MCP authorization page protocol is unsupported");
  }
  const operation = String(input.operation ?? "");
  if (!PAGE_OPERATIONS.has(operation)) {
    throw errorWithCode("MCP authorization page operation is unsupported", "METHOD_DENIED");
  }
  return Object.freeze({ operation, challenge: plainObject(input.challenge, "MCP pairing challenge") });
}

function senderPrincipal(sender, runtime) {
  if (!runtime?.id || sender?.id !== runtime.id) {
    throw errorWithCode("MCP authorization sender is not this extension", "CALLER_DENIED");
  }
  if (sender?.frameId !== 0 || sender?.tab?.incognito || !Number.isInteger(sender?.tab?.id)) {
    throw errorWithCode("MCP authorization requires a normal top-level tab", "CALLER_DENIED");
  }
  if (!isApprovedMcpAuthorizationPage(sender.url)) {
    throw errorWithCode("MCP authorization rejected an unapproved page", "CALLER_DENIED");
  }
  return Object.freeze({
    tabId: sender.tab.id,
    documentId: typeof sender.documentId === "string" ? sender.documentId : null,
    origin: new URL(sender.url).origin,
  });
}

export function createMcpAccessRuntime({
  keyring = new GreenwaysKeyring(),
  scripting = globalThis.chrome?.scripting,
  permissions = globalThis.chrome?.permissions,
  runtime = globalThis.chrome?.runtime,
  assertAuthority = async () => {},
  now = () => new Date(),
} = {}) {
  if (!keyring
      || typeof keyring.status !== "function"
      || typeof keyring.signMcpPairingChallenge !== "function") {
    throw new TypeError("MCP access requires the trusted Greenways Keyring pairing signer");
  }
  if (typeof assertAuthority !== "function") throw new TypeError("MCP access requires an authority gate");
  if (typeof now !== "function") throw new TypeError("MCP access requires a clock");

  async function registrations() {
    if (!scripting?.getRegisteredContentScripts) return [];
    return scripting.getRegisteredContentScripts({ ids: [MCP_ACCESS_SCRIPT_ID] });
  }

  async function hasOriginAccess() {
    if (!permissions?.contains) return false;
    return permissions.contains({ origins: MCP_ACCESS_ORIGINS });
  }

  async function status() {
    const [registered, originAccess, keyringStatus] = await Promise.all([
      registrations(),
      hasOriginAccess().catch(() => false),
      keyring.status(),
    ]);
    return Object.freeze({
      ok: true,
      protocol: MCP_ACCESS_PROTOCOL,
      origin: "https://mcp.greenways.ai",
      scope: "greenways.read",
      enabled: registered.length === 1,
      originAccess,
      controllerReady: Boolean(keyringStatus?.controller),
      controller: keyringStatus?.controller ?? null,
    });
  }

  async function setEnabled(args) {
    await assertAuthority();
    const enabled = args[0];
    if (typeof enabled !== "boolean") {
      throw errorWithCode("MCP authorization adapter enabled state must be boolean");
    }
    if (!scripting?.registerContentScripts || !scripting?.unregisterContentScripts) {
      throw errorWithCode("Chrome scripting is unavailable", "ADAPTER_UNAVAILABLE");
    }
    await scripting.unregisterContentScripts({ ids: [MCP_ACCESS_SCRIPT_ID] }).catch(() => {});
    if (enabled) {
      if (!await hasOriginAccess()) {
        throw errorWithCode("MCP authorization origin access has not been approved", "ORIGIN_PERMISSION_REQUIRED");
      }
      await scripting.registerContentScripts([{
        id: MCP_ACCESS_SCRIPT_ID,
        js: [MCP_ACCESS_SCRIPT],
        matches: MCP_ACCESS_ORIGINS,
        runAt: "document_idle",
        persistAcrossSessions: true,
      }]);
    }
    return status();
  }

  async function handlePageMessage(value, sender) {
    const principal = senderPrincipal(sender, runtime);
    const message = normalizePageMessage(value);
    const challenge = await normalizeMcpPairingChallenge(message.challenge, { now });
    if (message.operation === "hello") {
      const adapterStatus = await status();
      return Object.freeze({
        ok: true,
        protocol: MCP_ACCESS_PROTOCOL,
        operation: "hello",
        challengeId: challenge.id,
        ready: adapterStatus.enabled && adapterStatus.originAccess && adapterStatus.controllerReady,
      });
    }
    await assertAuthority();
    const assertion = await keyring.signMcpPairingChallenge(challenge, {
      device: {
        id: `greenways-browser/${runtime.id}`,
        name: "Greenways OS browser",
        kind: "browser-extension",
      },
      now,
    });
    return Object.freeze({
      ok: true,
      protocol: MCP_ACCESS_PROTOCOL,
      operation: "approve",
      challengeId: challenge.id,
      tabId: principal.tabId,
      documentId: principal.documentId,
      assertion,
    });
  }

  return Object.freeze({
    async call(method, args = []) {
      if (!MCP_ACCESS_METHODS.includes(method)) {
        throw errorWithCode(`Unsupported MCP access method: ${method}`, "METHOD_DENIED");
      }
      if (method === "mcp-access/status") return status();
      return setEnabled(args);
    },
    handlePageMessage,
    status,
  });
}
