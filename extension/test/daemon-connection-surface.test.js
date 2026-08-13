import assert from "node:assert/strict";
import test from "node:test";
import {
  compactConnectionMarkup,
  connectionCardMarkup,
  connectionStateView,
} from "../src/daemon-connection-surface.js";

const disconnected = {
  state: "native-host-unavailable",
  daemon: null,
  actor: null,
  identity: null,
  session: null,
  error: { code: "native-host-unavailable", message: "Install the host." },
};

test("renders explicit installation guidance and no authority fallback", () => {
  const markup = connectionCardMarkup(disconnected, "a".repeat(32));
  assert.match(markup, /greenways-browser-bridge-install/);
  assert.match(markup, /Compatibility runtime/);
  assert.match(markup, /not substituted for daemon authority/);
});

test("renders a compact global connectivity indicator", () => {
  assert.equal(connectionStateView(disconnected).label, "Native host unavailable");
  assert.match(compactConnectionMarkup(disconnected), /Open Connections/);
});
