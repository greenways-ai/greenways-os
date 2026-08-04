/*
 * Normalise browser-owned callables before extension modules capture them.
 *
 * Chromium's Window.fetch requires the Window receiver. A module may safely
 * retain this bound function and invoke it later as an object method without
 * triggering an "Illegal invocation" DOMException.
 */
(() => {
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return;
  globalThis.fetch = nativeFetch.bind(globalThis);
})();
