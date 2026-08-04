/**
 * Greenways OS theme adapter.
 *
 * It follows the @greenways-ai/visual-language auto/light/dark contract while
 * using localStorage on chrome-extension:// pages. A normal click switches
 * directly between day and night; Shift-click restores automatic mode.
 */

const THEME_KEY = "gw-theme";
const THEME_EVENT = "gw-theme-change";
const THEME_PREFERENCES = new Set(["auto", "light", "dark"]);
const root = document.documentElement;
const media = window.matchMedia("(prefers-color-scheme: dark)");

let preference = readPreference();

function parseTheme(value) {
  return THEME_PREFERENCES.has(value) ? value : "auto";
}

function readPreference() {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "auto";
  }
}

function resolveTheme(nextPreference) {
  return nextPreference === "auto"
    ? (media.matches ? "dark" : "light")
    : nextPreference;
}

function persistPreference(nextPreference) {
  try {
    localStorage.setItem(THEME_KEY, nextPreference);
  } catch {
    // A blocked storage area should not prevent the local launcher from opening.
  }
}

function updateThemeColor(resolvedTheme) {
  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute(
    "content",
    resolvedTheme === "dark" ? "#050a08" : "#f4f2ec",
  );
}

function updateButton() {
  const button = document.querySelector("[data-theme-toggle]");
  if (!button) return;

  const resolvedTheme = root.dataset.theme || resolveTheme(preference);
  const nextTheme = resolvedTheme === "dark" ? "light" : "dark";
  const icon = button.querySelector("[data-theme-icon]");
  const label = button.querySelector("[data-theme-label]");

  button.dataset.themePreference = preference;
  button.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
  button.title = `Switch to ${nextTheme} theme. Shift-click to follow the system.`;
  if (icon) icon.textContent = preference === "auto"
    ? "◐"
    : (resolvedTheme === "dark" ? "☾" : "☀");
  if (label) label.textContent = preference === "auto"
    ? "Auto"
    : (resolvedTheme === "dark" ? "Dark" : "Light");
}

function applyTheme(nextPreference = preference, persist = false) {
  preference = parseTheme(nextPreference);
  const resolvedTheme = resolveTheme(preference);

  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolvedTheme;

  if (persist) persistPreference(preference);
  updateThemeColor(resolvedTheme);
  updateButton();

  window.dispatchEvent(new CustomEvent(THEME_EVENT, {
    detail: { preference, resolvedTheme },
  }));

  return { preference, resolvedTheme };
}

function toggleTheme(event) {
  const resolvedTheme = root.dataset.theme || resolveTheme(preference);
  applyTheme(
    event.shiftKey ? "auto" : (resolvedTheme === "dark" ? "light" : "dark"),
    true,
  );
}

function bindThemeControl() {
  const button = document.querySelector("[data-theme-toggle]");
  if (!button || button.dataset.themeBound === "true") {
    updateButton();
    return;
  }
  button.dataset.themeBound = "true";
  button.addEventListener("click", toggleTheme);
  updateButton();
}

media.addEventListener?.("change", () => {
  if (preference === "auto") applyTheme();
});

window.GreenwaysTheme = {
  apply: applyTheme,
  get preference() {
    return preference;
  },
};

applyTheme();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindThemeControl, { once: true });
} else {
  bindThemeControl();
}
