import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { DevtoolsRespHost, DEVTOOLS_BRIDGE_PROTOCOL } from "../src/bridge-host.js";
import { RespCommandDecoder } from "../src/resp.js";

const token = "A".repeat(43);

function resp(...args) {
  return Buffer.from(`*${args.length}\r\n${args.map((arg) => `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`).join("")}`);
}

function readReplies(socket, count) {
  return new Promise((resolve, reject) => {
    let source = Buffer.alloc(0);
    const replies = [];
    const consume = () => {
      while (source.length) {
        const prefix = String.fromCharCode(source[0]);
        const line = source.indexOf("\r\n");
        if (line < 0) return;
        if (prefix === "+" || prefix === "-") {
          replies.push(source.subarray(0, line + 2).toString());
          source = source.subarray(line + 2);
        } else if (prefix === "$") {
          const length = Number(source.subarray(1, line).toString());
          if (source.length < line + 2 + length + 2) return;
          replies.push(source.subarray(0, line + 2 + length + 2).toString());
          source = source.subarray(line + 2 + length + 2);
        } else {
          reject(new Error("unexpected RESP response"));
          return;
        }
        if (replies.length === count) {
          socket.off("data", onData);
          resolve(replies);
          return;
        }
      }
    };
    const onData = (chunk) => { source = Buffer.concat([source, chunk]); consume(); };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

test("binds only to loopback, authenticates, and forwards kernel requests", async () => {
  let host;
  const native = [];
  host = new DevtoolsRespHost({
    sendNative: async (message) => {
      native.push(message);
      if (message.type === "request") {
        queueMicrotask(() => host.response({
          protocol: DEVTOOLS_BRIDGE_PROTOCOL,
          type: "response",
          id: message.id,
          ok: true,
          result: { command: message.command, payload: message.payload ?? null },
        }));
      }
    },
  });
  await host.configure({ address: "127.0.0.1", port: 46389, token });
  const socket = net.createConnection({ host: "127.0.0.1", port: 46389 });
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  const pending = readReplies(socket, 4);
  socket.write(Buffer.concat([
    resp("GW.STATUS"),
    resp("AUTH", "wrong"),
    resp("AUTH", token),
    resp("GW.EVAL", "gw.devtools", "(+ 20 22)"),
  ]));
  const replies = await pending;
  assert.match(replies[0], /NOAUTH/);
  assert.match(replies[1], /invalid session token/);
  assert.equal(replies[2], "+OK\r\n");
  assert.match(replies[3], /"command":"eval"/);
  assert.ok(native.some(({ type }) => type === "ready"));
  assert.ok(native.some(({ type, command }) => type === "request" && command === "eval"));
  socket.destroy();
  await host.close();
});

test("rejects non-loopback configuration", async () => {
  const host = new DevtoolsRespHost({ sendNative: async () => {} });
  await assert.rejects(host.configure({ address: "0.0.0.0", port: 46379, token }), /only to 127\.0\.0\.1/);
});
