import assert from "node:assert/strict";
import test from "node:test";
import {
  SITE_DRIVER_REQUEST_PROTOCOL,
  TRIPO_STUDIO_DRIVER_ID,
  getSiteDriverDescriptor,
  normalizeSiteDriverContentCommand,
  normalizeSiteDriverRequest,
  siteDriverPromptRoot,
  siteDriverSupportsUrl,
} from "../src/site-driver-protocol.js";

const requestId = "site-request/abcdefgh12345678";

test("publishes an exact-origin Tripo Studio site driver", () => {
  const driver = getSiteDriverDescriptor(TRIPO_STUDIO_DRIVER_ID);
  assert.equal(driver.origin, "https://studio.tripo3d.ai");
  assert.equal(driver.contentScript, "dist/tripo-studio-content.js");
  assert.equal(siteDriverSupportsUrl(driver, "https://studio.tripo3d.ai/workspace/generate"), true);
  assert.equal(siteDriverSupportsUrl(driver, "https://studio.tripo3d.ai/workspace/generate/advanced"), true);
  assert.equal(siteDriverSupportsUrl(driver, "https://studio.tripo3d.ai/"), false);
  assert.equal(siteDriverSupportsUrl(driver, "https://evil.example/workspace/generate"), false);
});

test("normalizes typed operations and rejects unbounded browser authority", () => {
  const staged = normalizeSiteDriverRequest({
    protocol: SITE_DRIVER_REQUEST_PROTOCOL,
    driverId: TRIPO_STUDIO_DRIVER_ID,
    operation: "stage-prompt",
    requestId,
    args: { prompt: "  glass mosaic sculpture  " },
  });
  assert.equal(staged.args.prompt, "glass mosaic sculpture");
  assert.throws(() => normalizeSiteDriverRequest({
    ...staged,
    operation: "fetch",
    args: { url: "https://evil.example" },
  }), /Unsupported site-driver operation/);
  assert.throws(() => normalizeSiteDriverRequest({
    protocol: SITE_DRIVER_REQUEST_PROTOCOL,
    driverId: TRIPO_STUDIO_DRIVER_ID,
    operation: "stage-prompt",
    requestId,
    args: { prompt: "ok", url: "https://evil.example" },
  }), /unsupported field url/);
});

test("binds staged prompt roots to driver, request, and exact prompt", async () => {
  const left = await siteDriverPromptRoot({
    driverId: TRIPO_STUDIO_DRIVER_ID,
    requestId,
    prompt: "glass mosaic sculpture",
  });
  const same = await siteDriverPromptRoot({
    driverId: TRIPO_STUDIO_DRIVER_ID,
    requestId,
    prompt: "glass mosaic sculpture",
  });
  const different = await siteDriverPromptRoot({
    driverId: TRIPO_STUDIO_DRIVER_ID,
    requestId,
    prompt: "stone mosaic sculpture",
  });
  assert.equal(left, same);
  assert.notEqual(left, different);
});

test("content commands accept only the reviewed Tripo operation vocabulary", () => {
  const command = normalizeSiteDriverContentCommand({
    protocol: SITE_DRIVER_REQUEST_PROTOCOL,
    driverId: TRIPO_STUDIO_DRIVER_ID,
    operation: "submit",
    requestId,
    args: { promptRoot: `sha256:${"a".repeat(64)}` },
  });
  assert.equal(command.operation, "submit");
  assert.throws(() => normalizeSiteDriverContentCommand({
    ...command,
    operation: "execute-script",
  }), /Unsupported site-driver operation/);
});
