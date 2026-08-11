import { DurableObject } from "cloudflare:workers";
import { executeMcpPairingStoreRpc } from "./pairing-store-rpc.js";
import { SqliteMcpPairingRepository } from "./sqlite-pairing-store.js";
import { executeMcpRequestStoreRpc } from "./request-store-rpc.js";
import { SqliteMcpRequestRepository } from "./sqlite-request-store.js";

export class McpRequestDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.repository = null;
    ctx.blockConcurrencyWhile(async () => {
      this.repository = new SqliteMcpRequestRepository(ctx.storage.sql);
    });
  }

  store() {
    if (!this.repository) throw new Error("MCP request repository is not initialized");
    return this.repository;
  }

  read(requestId) {
    return executeMcpRequestStoreRpc(() => this.store().get(requestId));
  }

  claim(value) {
    return executeMcpRequestStoreRpc(() => this.store().claim(value));
  }

  complete(value) {
    return executeMcpRequestStoreRpc(() => this.store().complete(value));
  }

  release(value) {
    return executeMcpRequestStoreRpc(() => this.store().release(value));
  }
}

export class McpPairingDurableObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.repository = null;
    ctx.blockConcurrencyWhile(async () => {
      this.repository = new SqliteMcpPairingRepository(ctx.storage.sql);
    });
  }

  store() {
    if (!this.repository) throw new Error("MCP pairing repository is not initialized");
    return this.repository;
  }

  put(value) {
    return executeMcpPairingStoreRpc(() => this.store().putSession(value));
  }

  read(challengeId) {
    return executeMcpPairingStoreRpc(() => this.store().getSession(challengeId));
  }

  claim(value) {
    return executeMcpPairingStoreRpc(() => this.store().claimSession(
      value.id,
      value.root,
      value.claimId,
      value.connection,
    ));
  }

  release(value) {
    return executeMcpPairingStoreRpc(() => this.store().releaseSession(
      value.id,
      value.claimId,
      value.connectionId,
    ));
  }

  consume(value) {
    return executeMcpPairingStoreRpc(() => this.store().consumeSession(
      value.id,
      value.claimId,
      value.connectionId,
    ));
  }

  connection(connectionId) {
    return executeMcpPairingStoreRpc(() => this.store().getConnection(connectionId));
  }
}

export default {
  fetch() {
    return new Response("Not found", {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  },
};
