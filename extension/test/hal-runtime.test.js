import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { start } from "../src/hara-vm.mjs";

const resources = {
  "greenways.adaptor": fs.readFileSync(new URL("../../src/greenways/adaptor.hal", import.meta.url), "utf8"),
  "greenways.kernel": fs.readFileSync(new URL("../../src/greenways/kernel.hal", import.meta.url), "utf8"),
};

test("browser VM exposes the HAL kernel through its generated adaptor surface", async () => {
  const runtime = await start({ resources });
  runtime.require("greenways.kernel");
  assert.equal(
    runtime.eval('(get (get greenways.kernel/SURFACE "workflow/transition") "action")'),
    '"@greenways/workflow/transition"',
  );
  assert.equal(
    runtime.eval('(greenways.kernel/dispatch "catalog/search" [[{"name" "apartment"} {"name" "splat-garden"}] "garden"])'),
    '[{"name" "splat-garden"}]',
  );
});
