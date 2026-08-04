import { randomBytes, timingSafeEqual } from "node:crypto";
import { renderAdminPage } from "./admin-page.js";

export const HOME_ADMIN_STATUS_PROTOCOL = "greenways-home-admin-status/1";
export const HOME_ADMIN_PAIRING_PROTOCOL = "greenways-home-admin-pairing/1";
export const HOME_ADMIN_REVOKED_PROTOCOL = "greenways-home-admin-revoked/1";
export const HOME_ADMIN_ERROR_PROTOCOL = "greenways-home-admin-error/1";

const ADMIN_COOKIE = "gw_home_admin";
const ADMIN_PREFIX = "/greenways/admin/v1";
const DEVICE_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

class HomeNodeAdminError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "HomeNodeAdminError";
    this.status = status;
    this.code = code;
  }
}

function opaqueSecret(size = 32) {
  return randomBytes(size).toString("base64url");
}

function secureHeaders(extra = {}) {
  return {
    "cache-control": "no-store, max-age=0",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    ...extra,
  };
}

function writeJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, secureHeaders({
    "content-type": "application/json; charset=utf-8",
    ...extraHeaders,
  }));
  response.end(JSON.stringify(body));
}

function writeHtml(response, status, html, headers = {}) {
  response.writeHead(status, secureHeaders({
    "content-type": "text/html; charset=utf-8",
    ...headers,
  }));
  response.end(html);
}

function parseCookies(value = "") {
  const cookies = new Map();
  for (const pair of value.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const content = pair.slice(separator + 1).trim();
    if (name) cookies.set(name, content);
  }
  return cookies;
}

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertLoopback(request) {
  const address = request.socket?.remoteAddress;
  if (!LOOPBACK_ADDRESSES.has(address)) {
    throw new HomeNodeAdminError(403, "loopback-required", "Home Node administration is available on loopback only");
  }
}

function assertExpectedHost(request, origin) {
  if (request.headers.host !== origin.host) {
    throw new HomeNodeAdminError(421, "unexpected-host", "The Home Node control plane rejected this Host header");
  }
}

function guardSession(request, origin, sessionSecret, csrfSecret) {
  assertLoopback(request);
  assertExpectedHost(request, origin);
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new HomeNodeAdminError(403, "same-origin-required", "Home Node administration rejects cross-site requests");
  }
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== origin.origin) {
    throw new HomeNodeAdminError(403, "same-origin-required", "Home Node administration requires its exact loopback origin");
  }
  if (request.method !== "GET" && requestOrigin !== origin.origin) {
    throw new HomeNodeAdminError(403, "same-origin-required", "Home Node mutations require their exact loopback Origin header");
  }
  const session = parseCookies(request.headers.cookie).get(ADMIN_COOKIE);
  if (!sameSecret(session, sessionSecret)) {
    throw new HomeNodeAdminError(401, "admin-session-required", "Open the local Home Node control plane first");
  }
  const csrf = request.headers["x-greenways-csrf"];
  if (!sameSecret(csrf, csrfSecret)) {
    throw new HomeNodeAdminError(403, "csrf-required", "Home Node administration requires its local CSRF token");
  }
}

function cloneServices(services) {
  return services.map((service) => ({
    id: service.id,
    name: service.name,
    kind: service.kind,
    ...(service.version === undefined ? {} : { version: service.version }),
    capabilities: [...service.capabilities],
    status: service.status,
  }));
}

function adminStatus(node) {
  const pairing = node.pairingAvailable() ? {
    available: true,
    issuedAt: node.pairing.issuedAt,
    expiresAt: node.pairing.expiresAt,
  } : { available: false };
  return {
    protocol: HOME_ADMIN_STATUS_PROTOCOL,
    node: {
      id: node.node.id,
      name: node.node.name,
      keyId: node.node.keyId,
      algorithm: node.node.algorithm,
    },
    durability: node.statePath ? "persistent" : "ephemeral",
    pairing,
    browsers: [...node.devices.values()]
      .map((device) => ({
        id: device.id,
        name: device.name,
        pairedAt: device.pairedAt,
        lastSeenAt: device.lastSeenAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    services: cloneServices(node.services),
    serverTime: node.now().toISOString(),
  };
}

function methodNotAllowed(response, allowed) {
  writeJson(response, 405, {
    protocol: HOME_ADMIN_ERROR_PROTOCOL,
    error: "method-not-allowed",
    message: "This Home Node administrator route does not accept that method",
  }, { allow: allowed });
}

function restoreMap(target, entries) {
  target.clear();
  for (const [key, value] of entries) target.set(key, value);
}

function revokeBrowser(node, deviceId) {
  if (!DEVICE_ID.test(deviceId)) {
    throw new HomeNodeAdminError(400, "invalid-device-id", "Browser device ID is invalid");
  }
  const device = node.devices.get(deviceId);
  if (!device) {
    throw new HomeNodeAdminError(404, "unknown-device", "That browser is not paired with this Home Node");
  }
  const devicesBefore = [...node.devices.entries()];
  const noncesBefore = [...node.usedNonces.entries()];
  node.devices.delete(deviceId);
  for (const key of node.usedNonces.keys()) {
    if (key.startsWith(`${deviceId}:`)) node.usedNonces.delete(key);
  }
  try {
    node.persistState?.();
  } catch (error) {
    restoreMap(node.devices, devicesBefore);
    restoreMap(node.usedNonces, noncesBefore);
    throw new HomeNodeAdminError(503, "state-unavailable", "The browser could not be revoked durably");
  }
  return {
    protocol: HOME_ADMIN_REVOKED_PROTOCOL,
    device: { id: device.id, name: device.name },
    revokedAt: node.now().toISOString(),
  };
}

export function createHomeNodeAdmin({ node, getOrigin }) {
  const sessionSecret = opaqueSecret();
  const csrfSecret = opaqueSecret();

  function matches(pathname) {
    return pathname === "/" || pathname === "/admin" || pathname.startsWith(`${ADMIN_PREFIX}/`);
  }

  async function handle({ request, response, url }) {
    if (!matches(url.pathname)) return false;
    try {
      const origin = new URL(getOrigin());
      assertLoopback(request);
      assertExpectedHost(request, origin);

      if ((url.pathname === "/" || url.pathname === "/admin") && request.method === "GET") {
        const nonce = opaqueSecret(18);
        writeHtml(response, 200, renderAdminPage({ node, csrf: csrfSecret, nonce }), {
          "content-security-policy": [
            "default-src 'none'",
            "base-uri 'none'",
            "connect-src 'self'",
            "form-action 'none'",
            "frame-ancestors 'none'",
            `script-src 'nonce-${nonce}'`,
            `style-src 'nonce-${nonce}'`,
          ].join("; "),
          "set-cookie": `${ADMIN_COOKIE}=${sessionSecret}; Path=/; HttpOnly; SameSite=Strict`,
        });
        return true;
      }

      guardSession(request, origin, sessionSecret, csrfSecret);

      if (url.pathname === `${ADMIN_PREFIX}/status`) {
        if (request.method !== "GET") {
          methodNotAllowed(response, "GET");
          return true;
        }
        writeJson(response, 200, adminStatus(node));
        return true;
      }

      if (url.pathname === `${ADMIN_PREFIX}/pairing`) {
        if (request.method !== "POST") {
          methodNotAllowed(response, "POST");
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
          methodNotAllowed(response, "POST");
          return true;
        }
        let deviceId;
        try {
          deviceId = decodeURIComponent(revoke[1]);
        } catch {
          throw new HomeNodeAdminError(400, "invalid-device-id", "Browser device ID is invalid");
        }
        writeJson(response, 200, revokeBrowser(node, deviceId));
        return true;
      }

      throw new HomeNodeAdminError(404, "admin-not-found", "Home Node administrator endpoint was not found");
    } catch (error) {
      const status = error instanceof HomeNodeAdminError ? error.status : 500;
      const code = error instanceof HomeNodeAdminError ? error.code : "internal-error";
      const message = status === 500
        ? "The Home Node control plane could not complete the request"
        : error.message;
      if (!response.headersSent) {
        writeJson(response, status, {
          protocol: HOME_ADMIN_ERROR_PROTOCOL,
          error: code,
          message,
        });
      } else {
        response.destroy();
      }
      return true;
    }
  }

  return Object.freeze({ handle, matches });
}
