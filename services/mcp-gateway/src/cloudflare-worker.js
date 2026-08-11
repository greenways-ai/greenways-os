import { DurableObject } from "cloudflare:workers";
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
