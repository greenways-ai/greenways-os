import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { connectionStateView } from "../src/daemon-connection-surface.js";

test("browser and Desktop share the reviewed connection-state vocabulary", async () => {
  const vocabulary = JSON.parse(await readFile(
    new URL("../../protocol/fixtures/desktop-connection-states.json", import.meta.url),
    "utf8",
  ));
  assert.equal(vocabulary.protocol, "greenways-connection-state-vocabulary/0-alpha");
  for (const state of [...vocabulary.shared, ...vocabulary.browserOnly]) {
    const view = connectionStateView({ state });
    assert.equal(typeof view.label, "string");
    assert.ok(view.label.length > 0, `${state} must have a browser presentation`);
    if (state !== "disconnected") {
      assert.notEqual(
        view.label,
        "Disconnected",
        `${state} must not fall back to the disconnected presentation`,
      );
    }
  }
  assert.deepEqual(vocabulary.desktopOnly, ["desktop-bridge-unavailable"]);
});
