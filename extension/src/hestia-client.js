import { canonical, sha256 } from "./protocol.js";

export const IDENTITY_RESOLVER = "https://id.greenways.ai";

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Hestia must use HTTP or HTTPS");
  return url.origin;
}

export async function requestOriginAccess(origin, permissions = globalThis.chrome?.permissions) {
  const pattern = `${normalizeOrigin(origin)}/*`;
  if (!permissions) return true;
  if (await permissions.contains({ origins: [pattern] })) return true;
  const granted = await permissions.request({ origins: [pattern] });
  if (!granted) throw new Error("Hestia access was not granted");
  return true;
}

export class HestiaClient {
  constructor({ origin, request = fetch }) {
    this.origin = normalizeOrigin(origin);
    this.request = request;
  }

  async discover() {
    const response = await this.request(`${this.origin}/.well-known/hestia`);
    if (!response.ok) throw new Error(`Hestia discovery failed: ${response.status}`);
    const manifest = await response.json();
    if (manifest.protocol !== "hestia-node/1") throw new Error("Unsupported Hestia node");
    return manifest;
  }

  async append(actions, { deviceToken }) {
    const response = await this.request(`${this.origin}/greenways/v1/actions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Hestia ${deviceToken}` },
      body: JSON.stringify({ protocol: "greenways-sync/1", actions })
    });
    if (!response.ok) throw new Error(`Hestia sync failed: ${response.status}`);
    return response.json();
  }
}

export async function resolveIdentity(identity, { request = fetch, resolver = IDENTITY_RESOLVER } = {}) {
  const response = await request(`${resolver}/v1/identities/${encodeURIComponent(identity)}`);
  if (!response.ok) throw new Error(`Identity resolution failed: ${response.status}`);
  const card = await response.json();
  if (card.protocol !== "greenways-identity-resolution/1") throw new Error("Invalid identity resolution");
  const { resolutionRoot, ...body } = card;
  if (resolutionRoot !== await sha256(canonical(body))) throw new Error("Identity resolution was modified");
  return card;
}
