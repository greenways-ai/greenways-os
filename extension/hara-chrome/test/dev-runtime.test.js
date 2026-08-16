import assert from "node:assert/strict";
import { test } from "node:test";
import { startDevelopmentRuntime } from "../scripts/dev-runtime.mjs";

test("development runtime closes Chromium and both bridge listeners once", async () => {
  let bridgeCloses = 0;
  let browserCloses = 0;
  let panelOpens = 0;
  let verifications = 0;
  const lines = [];
  const runtime = await startDevelopmentRuntime({
    respPort: 10001,
    wsPort: 10002,
    token: "test-token",
    log: (line) => lines.push(line),
    startBridgeImpl: async () => ({
      respPort: 10001,
      wsPort: 10002,
      close: async () => { bridgeCloses += 1; },
    }),
    launchExtensionImpl: async () => ({
      closed: new Promise(() => {}),
      openPanel: async ({ respUrl }) => {
        panelOpens += 1;
        assert.equal(respUrl, "ws://127.0.0.1:10002/?token=test-token");
        return { kind: "panel" };
      },
      close: async () => { browserCloses += 1; },
    }),
    verifyRespImpl: async ({ port }) => {
      verifications += 1;
      assert.equal(port, 10001);
      return { value: "42" };
    },
  });

  assert.deepEqual(lines, ["HARA RESP 127.0.0.1:10001"]);
  assert.equal(panelOpens, 1);
  assert.equal(verifications, 1);
  await Promise.all([runtime.close(), runtime.close(), runtime.close()]);
  assert.equal(browserCloses, 1);
  assert.equal(bridgeCloses, 1);
});

test("startup failure closes an already-open bridge", async () => {
  let bridgeCloses = 0;
  await assert.rejects(
    startDevelopmentRuntime({
      respPort: 10003,
      wsPort: 10004,
      log: () => {},
      startBridgeImpl: async () => ({
        respPort: 10003,
        wsPort: 10004,
        close: async () => { bridgeCloses += 1; },
      }),
      launchExtensionImpl: async () => { throw new Error("Chromium failed"); },
    }),
    /Chromium failed/,
  );
  assert.equal(bridgeCloses, 1);
});
