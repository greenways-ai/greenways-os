if (globalThis.location?.hash === "#manage-hara-playground") {
  await import("./playground-consent.js");
} else {
  await import("./launcher.js");
}
