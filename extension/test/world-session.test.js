import assert from "node:assert/strict";
import test from "node:test";
import { EffectRuntime, HaraWorldSession } from "../src/world-session.js";

test("runs Hara state transitions before host effects", async () => {
  const seen = [];
  const effects = new EffectRuntime().register("ui", "open-surface", ([surface], { session }) => {
    seen.push([surface, session.state.surface.active]);
  });
  const invoke = (method, args) => {
    if (method === "app/bootstrap") return { surface: { active: null }, studio: { tracks: [] } };
    if (method === "world/touchpoint") {
      const [state, touchpoint] = args;
      return {
        state: { ...state, surface: { active: touchpoint.surface } },
        effects: [{ effect: "ui", method: "open-surface", args: [touchpoint.surface, touchpoint] }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  };
  const session = new HaraWorldSession({ invoke, effects });
  await session.dispatch("world/touchpoint", [{ id: "console", surface: "studio" }]);
  assert.equal(session.state.surface.active, "studio");
  assert.deepEqual(seen, [["studio", "studio"]]);
});

test("rejects unhandled host effects", async () => {
  const effects = new EffectRuntime();
  await assert.rejects(
    effects.run([{ effect: "audio", method: "play", args: [] }]),
    /No host handler for audio\/play/,
  );
});
