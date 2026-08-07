import assert from "node:assert/strict";
import test from "node:test";
import { SiteDriverBroker } from "../src/site-driver-broker.js";
import {
  SITE_DRIVER_REQUEST_PROTOCOL,
  TRIPO_STUDIO_DRIVER_ID,
} from "../src/site-driver-protocol.js";

const requestId = "site-request/abcdefgh12345678";

function storageArea() {
  const data = {};
  return {
    async get(key) { return { [key]: data[key] }; },
    async set(values) { Object.assign(data, values); },
    data,
  };
}

function request(operation, overrides = {}) {
  return {
    protocol: SITE_DRIVER_REQUEST_PROTOCOL,
    driverId: TRIPO_STUDIO_DRIVER_ID,
    operation,
    requestId: ["stage-prompt", "review", "submit"].includes(operation) ? requestId : null,
    tabId: operation === "attach" ? 41 : null,
    args: operation === "stage-prompt"
      ? { prompt: "A glass mosaic sculpture" }
      : operation === "submit"
        ? { confirmationToken: "site-confirmation/abcdefgh12345678" }
        : {},
    ...overrides,
  };
}

test("injects the reviewed content driver and submits one confirmed Studio action", async () => {
  const calls = [];
  let injected = false;
  const tabs = {
    async get(id) {
      assert.equal(id, 41);
      return { id, url: "https://studio.tripo3d.ai/workspace/generate", incognito: false };
    },
    async sendMessage(id, message) {
      calls.push(["message", id, message.command.operation]);
      if (!injected) throw new Error("Could not establish connection. Receiving end does not exist.");
      const { operation, args, requestId: commandRequestId } = message.command;
      if (operation === "probe") return { ok: true, result: { state: "compatible", message: "ready" } };
      if (operation === "stage-prompt") return { ok: true, result: { promptRoot: args.promptRoot } };
      if (operation === "review") return {
        ok: true,
        result: {
          promptRoot: broker.attachments.get(TRIPO_STUDIO_DRIVER_ID).staged.promptRoot,
          canSubmit: true,
          submitLabel: "Generate Model",
          visibleCreditCost: "55 credits",
        },
      };
      if (operation === "submit") return { ok: true, result: { state: "submitted", message: "clicked" } };
      if (operation === "observe") return { ok: true, result: { state: "running", message: "running", progress: 25 } };
      if (operation === "detach") return { ok: true, result: { state: "detached" } };
      throw new Error(`unexpected ${operation} ${commandRequestId}`);
    },
  };
  const scripting = {
    async executeScript(details) {
      calls.push(["inject", details.target.tabId, details.files[0]]);
      injected = true;
    },
  };
  const broker = new SiteDriverBroker({
    tabs,
    scripting,
    sessionStorage: storageArea(),
    now: () => new Date("2026-08-07T00:00:00.000Z"),
    tokenFactory: () => "site-confirmation/abcdefgh12345678",
  });

  const attached = await broker.handle(request("attach"));
  assert.equal(attached.state, "compatible");
  assert.equal(attached.attachment.tabId, 41);

  const staged = await broker.handle(request("stage-prompt"));
  assert.equal(staged.state, "staged");
  assert.match(staged.promptRoot, /^sha256:/);

  const reviewed = await broker.handle(request("review"));
  assert.equal(reviewed.state, "awaiting-confirmation");
  assert.equal(reviewed.visibleCreditCost, "55 credits");

  const submitted = await broker.handle(request("submit"));
  assert.equal(submitted.state, "submitted");
  assert.ok(submitted.attachment.submittedRequestIds.includes(requestId));
  await assert.rejects(broker.handle(request("submit")), /already submitted/);

  const observed = await broker.handle(request("observe", { requestId }));
  assert.equal(observed.state, "running");
  assert.equal(observed.progress, 25);
  assert.deepEqual(calls[0], ["inject", 41, "dist/tripo-studio-content.js"]);
});

test("fails closed for another origin and clears stale attachments", async () => {
  const storage = storageArea();
  const broker = new SiteDriverBroker({
    tabs: {
      async get() { return { id: 41, url: "https://evil.example/workspace/generate", incognito: false }; },
      async sendMessage() { throw new Error("must not message"); },
    },
    scripting: { async executeScript() { throw new Error("must not inject"); } },
    sessionStorage: storage,
  });
  await assert.rejects(broker.handle(request("attach")), /Open Tripo Studio/);
  const status = await broker.handle(request("status", { requestId: null, tabId: null }));
  assert.equal(status.state, "detached");
});
