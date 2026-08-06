import assert from "node:assert/strict";
import test from "node:test";
import { HAL_VIEW_LIMITS, validateHalViewTree } from "../src/hal-surface.js";

test("accepts a bounded host-rendered view tree", () => {
  const output = validateHalViewTree({
    type: "view",
    children: [
      { type: "heading", level: 1, text: "Notes" },
      { type: "text", text: "Private local notes." },
      {
        type: "form",
        action: "notes/create",
        submitLabel: "Create",
        payload: { source: "home" },
        children: [
          { type: "input", name: "title", label: "Title", required: true },
        ],
      },
      { type: "button", label: "Refresh", action: "notes/refresh", payload: null },
    ],
  });
  assert.equal(output.type, "view");
  assert.equal(output.children[2].children[0].kind, "text");
  assert.ok(Object.isFrozen(output));
});

test("rejects HTML, URLs, event handlers, styles, and unknown elements by exact keys", () => {
  for (const node of [
    { type: "html", html: "<script>alert(1)</script>" },
    { type: "text", text: "x", onClick: "evil" },
    { type: "button", label: "x", action: "notes/run", url: "https://evil.example" },
    { type: "section", title: "x", children: [], style: "display:none" },
  ]) {
    assert.throws(() => validateHalViewTree({ type: "view", children: [node] }), /vocabulary|unsupported field/);
  }
});

test("rejects unqualified actions and prototype-shaped payload keys", () => {
  assert.throws(
    () => validateHalViewTree({ type: "view", children: [{ type: "button", label: "Run", action: "run" }] }),
    /namespace-qualified action/,
  );
  const payload = Object.create(null);
  payload.constructor = "bad";
  assert.throws(
    () => validateHalViewTree({ type: "view", children: [{ type: "button", label: "Run", action: "notes/run", payload }] }),
    /forbidden object key/,
  );
});

test("enforces view depth and node limits", () => {
  let nested = { type: "text", text: "leaf" };
  for (let index = 0; index < HAL_VIEW_LIMITS.depth + 2; index += 1) {
    nested = { type: "section", children: [nested] };
  }
  assert.throws(() => validateHalViewTree({ type: "view", children: [nested] }), /exceeds depth/);
  assert.throws(
    () => validateHalViewTree({
      type: "view",
      children: Array.from({ length: HAL_VIEW_LIMITS.nodes }, () => ({ type: "text", text: "x" })),
    }),
    /exceeds 256 nodes/,
  );
  assert.throws(
    () => validateHalViewTree({
      type: "view",
      children: [
        { type: "section", children: Array.from({ length: 130 }, () => ({ type: "text", text: "x" })) },
        { type: "section", children: Array.from({ length: 130 }, () => ({ type: "text", text: "x" })) },
      ],
    }),
    /exceeds 256 nodes/,
  );
});
