import { canonical, sha256 } from "./protocol.js";
import { SYNC_BATCH_PROTOCOL, orderSyncEntries } from "./sync-protocol.js";

export const IDENTITY_RESOLVER = "https://id.greenways.ai";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function privateRequestOptions(options = {}) {
  const request = {
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    ...options,
  };
  if (!request.signal && globalThis.AbortSignal?.timeout) {
    request.signal = AbortSignal.timeout(15_000);
  }
  return request;
}

export function normalizeHestiaOrigin(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Hestia must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("Hestia origins cannot contain credentials");
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error("Remote Hestia nodes must use HTTPS");
  }
  return url.origin;
}

export async function requestOriginAccess(origin, permissions = globalThis.chrome?.permissions) {
  const pattern = `${normalizeHestiaOrigin(origin)}/*`;
  if (!permissions) return true;
  const granted = await permissions.request({ origins: [pattern] });
  if (!granted) throw new Error("Hestia access was not granted");
  return true;
}

export async function revokeOriginAccess(origin, permissions = globalThis.chrome?.permissions) {
  const pattern = `${normalizeHestiaOrigin(origin)}/*`;
  if (!permissions) return true;
  const request = { origins: [pattern] };
  if (await permissions.remove(request)) return true;
  if (permissions.contains && !await permissions.contains(request)) return true;
  throw new Error("Hestia origin access could not be revoked");
}

export class HestiaClient {
  constructor({ origin, request = fetch }) {
    this.origin = normalizeHestiaOrigin(origin);
    this.request = request;
  }

  async discover() {
    const response = await this.request(
      `${this.origin}/.well-known/hestia`,
      privateRequestOptions(),
    );
    if (!response.ok) throw new Error(`Hestia discovery failed: ${response.status}`);
    const manifest = await response.json();
    if (manifest.protocol !== "hestia-node/0-alpha") throw new Error("Unsupported Hestia node");
    return manifest;
  }

  async append(entries, { deviceToken }) {
    if (typeof deviceToken !== "string" || !deviceToken.trim()) {
      throw new Error("A scoped Hestia device token is required");
    }
    const orderedEntries = orderSyncEntries(entries);
    const response = await this.request(`${this.origin}/greenways/0-alpha/actions`, {
      ...privateRequestOptions(),
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Hestia ${deviceToken}` },
      body: JSON.stringify({ protocol: SYNC_BATCH_PROTOCOL, entries: orderedEntries })
    });
    if (!response.ok) throw new Error(`Hestia sync failed: ${response.status}`);
    const result = await response.json();
    if (!Number.isSafeInteger(result.accepted) || result.accepted !== orderedEntries.length) {
      throw new Error(`Hestia accepted ${result.accepted ?? 0} of ${orderedEntries.length} records; the local outbox was retained`);
    }
    return result;
  }
}

export async function resolveIdentity(identity, { request = fetch, resolver = IDENTITY_RESOLVER } = {}) {
  const response = await request(
    `${resolver}/v1/identities/${encodeURIComponent(identity)}`,
    privateRequestOptions(),
  );
  if (!response.ok) throw new Error(`Identity resolution failed: ${response.status}`);
  const card = await response.json();
  if (card.protocol !== "greenways-identity-resolution/0-alpha") throw new Error("Invalid identity resolution");
  const { resolutionRoot, ...body } = card;
  if (resolutionRoot !== await sha256(canonical(body))) throw new Error("Identity resolution was modified");
  return card;
}
