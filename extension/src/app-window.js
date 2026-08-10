export const GREENWAYS_APP_WINDOW_KEY = "greenwaysAppWindowId";
export const GREENWAYS_APP_WINDOW_SIZE = Object.freeze({ width: 920, height: 680 });

function validWindowId(value) {
  return Number.isInteger(value) && value >= 0;
}

export function createAppWindowCoordinator({
  runtime = globalThis.chrome?.runtime,
  windows = globalThis.chrome?.windows,
  tabs = globalThis.chrome?.tabs,
  sessionStorage = globalThis.chrome?.storage?.session,
  storageKey = GREENWAYS_APP_WINDOW_KEY,
} = {}) {
  if (!runtime?.getURL || !tabs?.create) throw new TypeError("App window coordinator requires extension runtime and tabs APIs");

  const launcherUrl = runtime.getURL("src/launcher.html#home");

  async function readWindowId() {
    if (!sessionStorage?.get) return null;
    const record = await sessionStorage.get(storageKey);
    return validWindowId(record?.[storageKey]) ? record[storageKey] : null;
  }

  async function rememberWindowId(windowId) {
    if (sessionStorage?.set && validWindowId(windowId)) {
      await sessionStorage.set({ [storageKey]: windowId });
    }
  }

  async function forgetWindowId() {
    await sessionStorage?.remove?.(storageKey);
  }

  async function focusExisting() {
    const windowId = await readWindowId();
    if (!validWindowId(windowId) || !windows?.get || !windows?.update) return null;
    try {
      await windows.get(windowId);
      return await windows.update(windowId, { focused: true });
    } catch {
      await forgetWindowId();
      return null;
    }
  }

  async function open() {
    const existing = await focusExisting();
    if (existing) return Object.freeze({ mode: "focused", windowId: existing.id });
    if (windows?.create) {
      try {
        const created = await windows.create({
          url: launcherUrl,
          type: "popup",
          focused: true,
          ...GREENWAYS_APP_WINDOW_SIZE,
        });
        if (validWindowId(created?.id)) {
          await rememberWindowId(created.id);
          return Object.freeze({ mode: "window", windowId: created.id });
        }
      } catch {
        await forgetWindowId();
      }
    }
    const tab = await tabs.create({ url: launcherUrl });
    return Object.freeze({ mode: "tab", tabId: tab?.id ?? null });
  }

  windows?.onRemoved?.addListener?.((windowId) => {
    void readWindowId().then((remembered) => {
      if (remembered === windowId) return forgetWindowId();
      return undefined;
    });
  });

  return Object.freeze({ open, focusExisting });
}
