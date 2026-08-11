import { createMcpHandler } from "agents/mcp/server";
import { createGreenwaysMcpServer } from "./mcp-server.js";

export function createGreenwaysMcpHandler({
  execute,
  now,
  randomUUID,
  getAuthContext,
  authContext,
  route = "/mcp",
  allowedHostnames,
  allowedOriginHostnames,
  corsOptions = false,
  onerror,
} = {}) {
  return createMcpHandler(
    () => createGreenwaysMcpServer({ execute, now, randomUUID, getAuthContext }),
    {
      route,
      corsOptions,
      allowedHostnames,
      allowedOriginHostnames,
      legacy: "reject",
      onerror,
      authContext,
    },
  );
}
