import { randomBytes, timingSafeEqual } from "node:crypto";
import { renderAdminPage } from "./admin-page.js";

export const HOME_ADMIN_STATUS_PROTOCOL = "greenways-home-admin-status/0-alpha";
export const HOME_ADMIN_PAIRING_PROTOCOL = "greenways-home-admin-pairing/0-alpha";
export const HOME_ADMIN_REVOKED_PROTOCOL = "greenways-home-admin-revoked/0-alpha";
export const HOME_ADMIN_ERROR_PROTOCOL = "greenways-home-admin-error/0-alpha";

const ADMIN_SESSION_COOKIE = "gw_home_admin";
const ADMIN_API_PREFIX = "/greenways/admin/v1/";
const DEVICE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const LOOPBACK_ADDRESSES = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

class HomeNodeAdminError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HomeNodeAdminError";
    this.status = status;
    this.code = code;
  }
}

function secret(provider, size) {
  const value = provider(size);
  if (!Buffer.isBuffer(value) || value.length < size) {
    throw new Error("Home Node admin secret provider returned insufficient entropy");
  }
  return value.toString("base64url");
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function parseCookies(value = "") {
  const output = new Map();
  for (const part of value.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    if (name) output.set(name, cookieValue);
  }
  return output;
}

function cloneService(service) {
  return {
    id: service.id,
    name: service.name,
    kind: service.kind,
    ...(service.version === undefined ? {} : { version: service.version }),
    capabilities: [...(service.capabilities ?? [])],
    status: service.status,
  };
}

function cloneBrowser(device) {
  return {
    id: device.id,
    name: device.name,
    pairedAt: device.pairedAt,
    lastSeenAt: device.lastSeenAt,
  };
}

function pairingState(node, now) {
  const available = typeof node.pairingAvailable === "function"
    ? node.pairingAvailable()
    : Boolean(node.pairing && new Date(node.pairing.expiresAt).getTime() >= now().getTime());
  return available
    ? { available: true, expiresAt: node.pairing.expiresAt }
    : { available: false };
}

function adminSnapshot(node, now) {
  return {
    protocol: HOME_ADMIN_STATUS_PROTOCOL,
    node: {
      id: node.node.id,
      name: node.node.name,
      keyId: node.node.keyId,
      algorithm: node.node.algorithm,
    },
    durability: node.statePath ? "persistent" : "ephemeral",
    pairing: pairingState(node, now),
    browsers: [...node.devices.values()]
      .map(cloneBrowser)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    services: [...(node.services ?? [])].map(cloneService),
    serverTime: now().toISOString(),
  };
}

function isLoopbackRequest(request) {
  return LOOPBACK_ADDRESSES.has(request.socket?.remoteAddress ?? "");
}

function expectedUrl(getOrigin) {
  const value = getOrigin();
  if (!value) throw new HomeNodeAdminError(503, "admin-unavailable", "Home Node control plane is not listening yet");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Home Node control-plane origin must use HTTP or HTTPS");
  }
  return url;
}

function guardLoopback(request, getOrigin) {
  const origin = expectedUrl(getOrigin);
  if (!isLoopbackRequest(request)) {
    throw new HomeNodeAdminError(403, "loopback-required", "Home Node administration is available on loopback only");
  }
  if (request.headers.host !== origin.host) {
    throw new HomeNodeAdminError(421, "unexpected-host", "Home Node rejected an unexpected Host header");
  }
  return origin;
}

function guardSession(request, getOrigin, sessionSecret, csrfSecret) {
  const origin = guardLoopback(request, getOrigin);
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== origin.origin) {
    throw new HomeNodeAdminError(403, "same-origin-required", "Home Node administration requires its exact loopback origin");
  }
  if (request.method !== "GET" && requestOrigin !== origin.origin) {
    throw new HomeNodeAdminError(403, "same-origin-required", "Home Node mutations require their exact loopback Origin header");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin") {
    throw new HomeNodeAdminError(403, "same-origin-required", "Cross-site Home Node administration is not allowed");
  }
  const cookies = parseCookies(request.headers.cookie);
  if (!safeEqual(cookies.get(ADMIN_SESSION_COOKIE), sessionSecret)) {
    throw new HomeNodeAdminError(403, "admin-session-required", "Open the local Home Node control plane first");
  }
  const csrf = request.headers["x-greenways-csrf"];
  if (!safeEqual(Array.isArray(csrf) ? csrf[0] : csrf, csrfSecret)) {
    throw new HomeNodeAdminError(403, "csrf-rejected", "Home Node administration rejected the request token");
  }
  return origin;
}

function secureHeaders(contentType) {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function writeJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    ...secureHeaders("application/json; charset=utf-8"),
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function writeAdminError(response, error) {
  const status = error instanceof HomeNodeAdminError ? error.status : 500;
  const code = error instanceof HomeNodeAdminError ? error.code : "internal-error";
  writeJson(response, status, {
    protocol: HOME_ADMIN_ERROR_PROTOCOL,
    error: code,
    message: status === 500
      ? "The Home Node control plane could not complete the request"
      : error.message,
  });
}

function methodNotAllowed(response, allowed) {
  writeJson(response, 405, {
    protocol: HOME_ADMIN_ERROR_PROTOCOL,
    error: "method-not-allowed",
    message: `Use ${allowed.join(" or ")} for this Home Node control-plane route`,
  }, { allow: allowed.join(", ") });
}

function restoreMap(target, snapshot) {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

function revokeBrowser(node, deviceId, now) {
  if (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId) || deviceId.length > 80) {
    throw new HomeNodeAdminError(400, "invalid-device", "Browser device identifier is invalid");
  }
  const device = node.devices.get(deviceId);
  if (!device) throw new HomeNodeAdminError(404, "unknown-device", "Browser device is not paired with this Home Node");

  const devicesBefore = new Map(node.devices);
  const noncesBefore = new Map(node.usedNonces);
  node.devices.delete(deviceId);
  for (const key of node.usedNonces.keys()) {
    if (key.startsWith(`${deviceId}:`)) node.usedNonces.delete(key);
  }
  try {
    node.persistState?.();
  } catch (cause) {
    restoreMap(node.devices, devicesBefore);
    restoreMap(node.usedNonces, noncesBefore);
    const error = new HomeNodeAdminError(503, "state-unavailable", "Browser revocation could not be durably committed");
    error.cause = cause;
    throw error;
  }

  return {
    protocol: HOME_ADMIN_REVOKED_PROTOCOL,
    deviceId,
    deviceName: device.name,
    revokedAt: now().toISOString(),
  };
}

export function createHomeNodeAdmin({
  node,
  getOrigin,
  now = () => new Date(),
  randomBytesProvider = randomBytes,
} = {}) {
  if (!node?.node || !(node.devices instanceof Map) || !(node.usedNonces instanceof Map)) {
    throw new TypeError("Home Node administration requires a Home Node instance");
  }
  if (typeof getOrigin !== "function") throw new TypeError("Home Node administration requires an origin provider");

  const sessionSecret = secret(randomBytesProvider, 32);
  const csrfSecret = secret(randomBytesProvider, 24);

  function matches(pathname) {
    return pathname === "/" || pathname === "/admin" || pathname.startsWith(ADMIN_API_PREFIX);
  }

  async function handle({ request, response, url }) {
    if (!matches(url.pathname)) return false;
    try {
      if (url.pathname === "/" || url.pathname === "/admin") {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return true;
        }
        guardLoopback(request, getOrigin);
        const nonce = secret(randomBytesProvider, 18);
        const page = renderAdminPage({ node, csrf: csrfSecret, nonce });
        response.writeHead(200, {
          ...secureHeaders("text/html; charset=utf-8"),
          "content-security-policy": `default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`,
          "set-cookie": `${ADMIN_SESSION_COOKIE}=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`,
        });
        response.end(page);
        return true;
      }

      guardSession(request, getOrigin, sessionSecret, csrfSecret);
      if (url.pathname === `${ADMIN_API_PREFIX}status`) {
        if (request.method !== "GET") {
          methodNotAllowed(response, ["GET"]);
          return true;
        }
        writeJson(response, 200, adminSnapshot(node, now));
        return true;
      }

      if (url.pathname === `${ADMIN_API_PREFIX}pairing`) {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return true;
        }
        const pairing = node.issuePairingCode();
        writeJson(response, 200, {
          protocol: HOME_ADMIN_PAIRING_PROTOCOL,
          code: pairing.code,
          issuedAt: pairing.issuedAt,
          expiresAt: pairing.expiresAt,
        });
        return true;
      }

      const revoke = url.pathname.match(/^\/greenways\/admin\/v1\/devices\/([^/]+)\/revoke$/);
      if (revoke) {
        if (request.method !== "POST") {
          methodNotAllowed(response, ["POST"]);
          return true;
        }
        let deviceId;
        try {
          deviceId = decodeURIComponent(revoke[1]);
        } catch {
          throw new HomeNodeAdminError(400, "invalid-device", "Browser device identifier is invalid");
        }
        writeJson(response, 200, revokeBrowser(node, deviceId, now));
        return true;
      }

      throw new HomeNodeAdminError(404, "not-found", "Home Node control-plane endpoint was not found");
    } catch (error) {
      writeAdminError(response, error);
      return true;
    }
  }

  return Object.freeze({ handle, matches });
}
