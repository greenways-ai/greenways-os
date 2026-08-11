import { randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import {
  RespCommandDecoder,
  respError,
  respJson,
  respSimple,
} from "./resp.js";

export const DEVTOOLS_BRIDGE_PROTOCOL = "greenways-devtools-bridge/0-alpha";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HOST = "127.0.0.1";
const REQUEST_TIMEOUT = 30_000;

function exactToken(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function portNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1024 || value > 65535) {
    throw new Error("DevTools RESP port must be between 1024 and 65535");
  }
  return value;
}

function jsonArgs(value) {
  let args;
  try {
    args = JSON.parse(value ?? "[]");
  } catch {
    throw new Error("GW.CALL arguments must be a JSON array");
  }
  if (!Array.isArray(args)) throw new Error("GW.CALL arguments must be a JSON array");
  return args;
}

export class DevtoolsRespHost {
  constructor({ sendNative, createServer = net.createServer, requestTimeoutMs = REQUEST_TIMEOUT } = {}) {
    if (typeof sendNative !== "function") throw new TypeError("RESP host requires a native-message sender");
    if (typeof createServer !== "function") throw new TypeError("RESP host requires a TCP server factory");
    this.sendNative = sendNative;
    this.createServer = createServer;
    this.requestTimeoutMs = requestTimeoutMs;
    this.server = null;
    this.sockets = new Set();
    this.pending = new Map();
    this.token = null;
    this.port = null;
  }

  async configure({ address, port, token }) {
    if (this.server) throw new Error("DevTools RESP host is already configured");
    if (address !== HOST) throw new Error("DevTools RESP host may bind only to 127.0.0.1");
    if (typeof token !== "string" || !TOKEN.test(token)) throw new Error("DevTools RESP session token is invalid");
    this.port = portNumber(port);
    this.token = token;
    this.server = this.createServer((socket) => this.accept(socket));
    this.server.on("error", (error) => this.fail(error));
    await new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen({ host: HOST, port: this.port, exclusive: true });
    });
    await this.sendNative({
      protocol: DEVTOOLS_BRIDGE_PROTOCOL,
      type: "ready",
      address: HOST,
      port: this.port,
      clients: 0,
    });
  }

  accept(socket) {
    socket.setNoDelay(true);
    socket.setTimeout(0);
    const session = { authenticated: false, decoder: new RespCommandDecoder(), queue: Promise.resolve() };
    this.sockets.add(socket);
    this.status();
    socket.on("data", (chunk) => {
      let commands;
      try {
        commands = session.decoder.push(chunk);
      } catch (error) {
        socket.write(respError(error.message));
        socket.destroy();
        return;
      }
      for (const command of commands) {
        session.queue = session.queue
          .then(() => this.execute(socket, session, command))
          .catch((error) => {
            if (!socket.destroyed) socket.write(respError(error?.message || String(error)));
          });
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.status();
    });
  }

  async execute(socket, session, values) {
    const [source, ...args] = values;
    const command = String(source || "").toUpperCase();
    if (command === "PING") {
      socket.write(respSimple(args[0] ?? "PONG"));
      return;
    }
    if (command === "QUIT") {
      socket.end(respSimple("OK"));
      return;
    }
    if (command === "AUTH") {
      if (args.length !== 1 || !exactToken(args[0], this.token)) {
        session.authenticated = false;
        socket.write(respError("invalid session token"));
        return;
      }
      session.authenticated = true;
      socket.write(respSimple("OK"));
      return;
    }
    if (!session.authenticated) {
      socket.write(respError("NOAUTH use AUTH with the DevTools session token"));
      return;
    }

    let request;
    if (command === "GW.STATUS" && args.length === 0) request = { command: "status" };
    else if (command === "GW.MODULES" && args.length === 0) request = { command: "modules" };
    else if (command === "GW.SERVICES" && args.length === 0) request = { command: "services" };
    else if (command === "GW.EVAL" && args.length === 2) {
      request = { command: "eval", payload: { namespace: args[0], source: args[1] } };
    } else if (command === "GW.CALL" && (args.length === 1 || args.length === 2)) {
      request = { command: "call", payload: { method: args[0], args: jsonArgs(args[1]) } };
    } else {
      throw new Error("supported commands: PING, AUTH, GW.STATUS, GW.MODULES, GW.SERVICES, GW.EVAL, GW.CALL, QUIT");
    }
    socket.write(respJson(await this.request(request)));
  }

  request({ command, payload }) {
    const id = `resp/${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Greenways kernel request timed out"));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      Promise.resolve(this.sendNative({
        protocol: DEVTOOLS_BRIDGE_PROTOCOL,
        type: "request",
        id,
        command,
        payload,
      })).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  response(message) {
    const pending = this.pending.get(message?.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(Object.assign(new Error(message.error || "Greenways kernel request failed"), { code: message.code }));
    return true;
  }

  status() {
    return Promise.resolve(this.sendNative({
      protocol: DEVTOOLS_BRIDGE_PROTOCOL,
      type: "status",
      clients: this.sockets.size,
    })).catch(() => {});
  }

  fail(error) {
    return Promise.resolve(this.sendNative({
      protocol: DEVTOOLS_BRIDGE_PROTOCOL,
      type: "error",
      error: error?.message || String(error),
    })).catch(() => {});
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const pending of this.pending.values()) pending.reject(new Error("DevTools RESP host is shutting down"));
    this.pending.clear();
    const server = this.server;
    this.server = null;
    this.token = null;
    this.port = null;
    if (!server || !server.listening) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }
}
