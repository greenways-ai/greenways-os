import {
  McpPairingError,
  mcpChallengeIdForConnection,
  normalizeMcpPairingChallengeId,
  normalizeMcpPairingClaimId,
  normalizeMcpPairingConnectionId,
  normalizeMcpPairingSession,
} from "./mcp-pairing.js";
import { normalizeConnection } from "./protocol.js";
import { unwrapMcpPairingStoreRpc } from "./pairing-store-rpc.js";

export class CloudflareMcpPairingRepository {
  constructor(namespace) {
    if (!namespace || typeof namespace.getByName !== "function") {
      throw new TypeError("MCP Cloudflare pairing repository requires a Durable Object namespace");
    }
    this.namespace = namespace;
  }

  stub(id) {
    const stub = this.namespace.getByName(id);
    if (!stub || typeof stub !== "object") {
      throw new McpPairingError(500, "pairing-recovery", "MCP pairing Durable Object stub is unavailable");
    }
    return stub;
  }

  async invoke(id, method, value) {
    const stub = this.stub(id);
    if (typeof stub[method] !== "function") {
      throw new McpPairingError(
        500,
        "pairing-recovery",
        `MCP pairing Durable Object method is unavailable: ${method}`,
      );
    }
    let response;
    try {
      response = await stub[method](value);
    } catch (cause) {
      if (cause instanceof McpPairingError) throw cause;
      throw new McpPairingError(
        503,
        "pairing-store-unavailable",
        "MCP pairing storage is unavailable",
        { cause },
      );
    }
    return unwrapMcpPairingStoreRpc(response);
  }

  async putSession(sessionValue) {
    const session = normalizeMcpPairingSession(sessionValue);
    return normalizeMcpPairingSession(await this.invoke(session.id, "put", session));
  }

  async getSession(idValue) {
    const id = normalizeMcpPairingChallengeId(idValue, 500);
    const value = await this.invoke(id, "read", id);
    if (value === null) return null;
    const session = normalizeMcpPairingSession(value);
    if (session.id !== id) {
      throw new McpPairingError(500, "pairing-recovery", "MCP pairing Durable Object identity changed");
    }
    return session;
  }

  async claimSession(idValue, root, claimIdValue, connectionValue) {
    const id = normalizeMcpPairingChallengeId(idValue, 500);
    const claimId = normalizeMcpPairingClaimId(claimIdValue, 500);
    const connection = normalizeConnection(connectionValue);
    return normalizeMcpPairingSession(await this.invoke(id, "claim", {
      id,
      root,
      claimId,
      connection,
    }));
  }

  async releaseSession(idValue, claimIdValue, connectionIdValue) {
    const id = normalizeMcpPairingChallengeId(idValue, 500);
    const claimId = normalizeMcpPairingClaimId(claimIdValue, 500);
    const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
    return this.invoke(id, "release", { id, claimId, connectionId });
  }

  async consumeSession(idValue, claimIdValue, connectionIdValue) {
    const id = normalizeMcpPairingChallengeId(idValue, 500);
    const claimId = normalizeMcpPairingClaimId(claimIdValue, 500);
    const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
    return normalizeMcpPairingSession(await this.invoke(id, "consume", {
      id,
      claimId,
      connectionId,
    }));
  }

  async getConnection(connectionIdValue) {
    const connectionId = normalizeMcpPairingConnectionId(connectionIdValue, 500);
    const challengeId = mcpChallengeIdForConnection(connectionId);
    const value = await this.invoke(challengeId, "connection", connectionId);
    return value === null ? null : normalizeConnection(value);
  }

  async get(connectionIdValue) {
    return this.getConnection(connectionIdValue);
  }
}
