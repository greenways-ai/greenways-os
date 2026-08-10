const NAVIGATION = Object.freeze([
  Object.freeze({ id: "home", label: "Home", icon: "⌂", href: "launcher.html#home", document: "launcher" }),
  Object.freeze({ id: "apps", label: "Apps", icon: "▦", href: "launcher.html#apps", document: "launcher" }),
  Object.freeze({ id: "connections", label: "Connections", icon: "◎", href: "launcher.html#connections", document: "launcher" }),
  Object.freeze({ id: "general", label: "General", icon: "⚙", href: "launcher.html#general", document: "launcher", group: "Settings" }),
  Object.freeze({ id: "keyring", label: "Keyring", icon: "⌁", href: "launcher.html#keyring", document: "launcher" }),
  Object.freeze({ id: "kernel", label: "Kernel", icon: "λ", href: "devtools.html#kernel", document: "devtools" }),
  Object.freeze({ id: "developer", label: "Developer", icon: "›_", href: "devtools.html#developer", document: "devtools" }),
  Object.freeze({ id: "bridge", label: "RESP Bridge", icon: "⇄", href: "devtools.html#bridge", document: "devtools" }),
  Object.freeze({ id: "about", label: "About", icon: "ⓘ", href: "launcher.html#about", document: "launcher" }),
]);

export const LAUNCHER_ROUTES = Object.freeze(new Set(NAVIGATION.filter(({ document }) => document === "launcher").map(({ id }) => id)));
export const DEVTOOLS_ROUTES = Object.freeze(new Set(NAVIGATION.filter(({ document }) => document === "devtools").map(({ id }) => id)));

export function routeFromHash(hash, routes, fallback) {
  const value = String(hash || "").replace(/^#/, "");
  return routes.has(value) ? value : fallback;
}

export function sidebarMarkup(activeRoute) {
  let currentGroup = null;
  return `<aside class="gw-sidebar">
    <header class="gw-sidebar__brand"><img src="assets/brand/greenways-small.svg" alt=""><span><strong>Greenways OS</strong><small>Local browser system</small></span></header>
    <nav aria-label="Greenways OS">${NAVIGATION.map((item) => {
      const group = item.group && item.group !== currentGroup
        ? `<p class="gw-sidebar__label">${item.group}</p>`
        : "";
      if (item.group) currentGroup = item.group;
      return `${group}<a href="${item.href}" data-route="${item.id}"${activeRoute === item.id ? ' aria-current="page"' : ""}><i aria-hidden="true">${item.icon}</i><span>${item.label}</span></a>`;
    }).join("")}</nav>
    <footer><span class="gw-status-dot"></span><span>Local by default</span></footer>
  </aside>`;
}

export function appShellMarkup({ activeRoute, title, detail, content, state = "Starting", tone = "quiet" }) {
  return `<div class="gw-app-shell">
    ${sidebarMarkup(activeRoute)}
    <section class="gw-workspace">
      <header class="gw-toolbar"><div><h1>${title}</h1>${detail ? `<p>${detail}</p>` : ""}</div><span class="gw-kernel-pill" data-tone="${tone}"><i></i>${state}</span></header>
      <main class="gw-page" data-page="${activeRoute}">${content}</main>
    </section>
  </div>`;
}
