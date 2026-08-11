import { canonical, normalizeHandle, sha256, verifyAction } from "../../../extension/src/protocol.js";

function publicResolution(identity) {
  return {
    protocol: "greenways-identity-resolution/0-alpha",
    identityId: identity.identityId,
    handle: identity.handle,
    currentKey: { keyId: identity.keyId, publicKey: identity.publicKey },
    keyHistory: identity.keyHistory ?? [],
    serviceEndpoints: identity.serviceEndpoints ?? [],
    authorityClaims: identity.authorityClaims ?? [],
    witnessedCheckpoints: identity.witnessedCheckpoints ?? [],
  };
}

export class IdentityRegistry {
  #identities = new Map();
  #handles = new Map();

  async register(action) {
    if (action?.type !== "@greenways/identity-registered") throw new Error("Identity registration action required");
    const identity = action.payload?.identity;
    if (!identity?.identityId || !identity?.keyId || !identity?.publicKey) throw new Error("Complete public identity card required");
    if (action.actor?.identityId !== identity.identityId || action.actor?.keyId !== identity.keyId) throw new Error("Identity must register itself");
    if (!await verifyAction(action, identity.publicKey)) throw new Error("Invalid identity registration signature");
    const handle = normalizeHandle(identity.handle);
    const existing = this.#identities.get(identity.identityId);
    if (existing && existing.keyId !== identity.keyId) throw new Error("Key replacement requires a signed rotation");
    const stored = { ...identity, handle, registrationRoot: action.root };
    this.#identities.set(stored.identityId, stored);
    const candidates = this.#handles.get(handle) ?? new Set();
    candidates.add(stored.identityId);
    this.#handles.set(handle, candidates);
    return this.resolveIdentity(stored.identityId);
  }

  async resolveIdentity(identityId) {
    const identity = this.#identities.get(identityId);
    if (!identity) return null;
    const body = publicResolution(identity);
    return { ...body, resolutionRoot: await sha256(canonical(body)) };
  }

  async resolveHandle(rawHandle) {
    const handle = normalizeHandle(rawHandle);
    const identities = [...(this.#handles.get(handle) ?? [])];
    const candidates = await Promise.all(identities.map((id) => this.resolveIdentity(id)));
    const body = { protocol: "greenways-handle-resolution/0-alpha", handle, candidates };
    return { ...body, resolutionRoot: await sha256(canonical(body)) };
  }
}
