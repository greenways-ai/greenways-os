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

test("compensates completed effects in reverse order when a later effect fails", async () => {
  const calls = [];
  const effects = new EffectRuntime()
    .register("storage", "save-apps", async () => {
      calls.push("save");
      return async () => { calls.push("restore"); };
    })
    .register("ui", "close-surface", () => {
      calls.push("close");
      throw new Error("surface close failed");
    });

  await assert.rejects(
    effects.run([
      { effect: "storage", method: "save-apps", args: [[]] },
      { effect: "ui", method: "close-surface", args: [] },
    ]),
    /surface close failed/,
  );
  assert.deepEqual(calls, ["save", "close", "restore"]);
});

test("rolls back app activation when its browser launch effect fails", async () => {
  const initial = {
    apps: {
      installed: [{ id: "historia" }],
      active: null,
    },
  };
  const observed = [];
  let session;
  const effects = new EffectRuntime().register("browser", "open-app", ([appId], context) => {
    assert.equal(context.session, session);
    assert.equal(context.session.state.apps.active, appId);
    throw new Error("tab launch failed");
  });
  const invoke = (method, args) => {
    if (method === "app/bootstrap") return initial;
    if (method === "apps/open") {
      const [state, appId] = args;
      return {
        state: { ...state, apps: { ...state.apps, active: appId } },
        effects: [{ effect: "browser", method: "open-app", args: [appId] }],
      };
    }
    throw new Error(`unexpected method ${method}`);
  };

  session = new HaraWorldSession({ invoke, effects });
  session.subscribe((state, { method }) => observed.push([method, state.apps.active]));
  await assert.rejects(session.dispatch("apps/open", ["historia"]), /tab launch failed/);

  assert.equal(session.state.apps.active, null);
  assert.equal(session.state, initial);
  assert.deepEqual(observed, [["app/bootstrap", null]]);
});

test("serializes concurrent transitions so app installs cannot overwrite each other", async () => {
  let releaseFirstEffect;
  const firstEffect = new Promise((resolve) => { releaseFirstEffect = resolve; });
  const effectOrder = [];
  const effects = new EffectRuntime().register("storage", "save-apps", async ([installed]) => {
    effectOrder.push(installed.map(({ id }) => id));
    if (installed.length === 1) await firstEffect;
  });
  const invoke = (method, args) => {
    if (method === "app/bootstrap") return { apps: { installed: [], active: null } };
    const [state, app] = args;
    const installed = [...state.apps.installed, app];
    return {
      state: { ...state, apps: { ...state.apps, installed } },
      effects: [{ effect: "storage", method: "save-apps", args: [installed] }],
    };
  };
  const session = new HaraWorldSession({ invoke, effects });

  const first = session.dispatch("apps/install", [{ id: "historia" }]);
  const second = session.dispatch("apps/install", [{ id: "hara-playground" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(effectOrder, [["historia"]]);
  releaseFirstEffect();
  await Promise.all([first, second]);

  assert.deepEqual(session.state.apps.installed.map(({ id }) => id), ["historia", "hara-playground"]);
  assert.deepEqual(effectOrder, [["historia"], ["historia", "hara-playground"]]);
});

test("finishes a failed transition rollback before running the next dispatch", async () => {
  let failFirstEffect;
  const firstEffect = new Promise((_resolve, reject) => { failFirstEffect = reject; });
  const effects = new EffectRuntime().register("browser", "open-app", async ([appId]) => {
    if (appId === "historia") await firstEffect;
  });
  const invoke = (method, args) => {
    if (method === "app/bootstrap") return { apps: { installed: [], active: null } };
    const [state, appId] = args;
    return {
      state: { ...state, apps: { ...state.apps, active: appId } },
      effects: [{ effect: "browser", method: "open-app", args: [appId] }],
    };
  };
  const session = new HaraWorldSession({ invoke, effects });

  const first = session.dispatch("apps/open", ["historia"]);
  const second = session.dispatch("apps/open", ["hara-playground"]);
  await new Promise((resolve) => setImmediate(resolve));
  failFirstEffect(new Error("Historia did not start"));

  await assert.rejects(first, /Historia did not start/);
  await second;
  assert.equal(session.state.apps.active, "hara-playground");
});
