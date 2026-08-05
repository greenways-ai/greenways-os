import { HOME_NODE_ADMIN_CLIENT } from "./admin-client.js";
import { HOME_NODE_ADMIN_STYLE } from "./admin-style.js";

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

export function renderAdminPage({ node, csrf, nonce }) {
  const title = escapeHtml(node.node.name);
  const keyId = escapeHtml(node.node.keyId);
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f4f2ec">
  <meta name="gw-csrf" content="${escapeHtml(csrf)}">
  <title>${title} · Greenways Home</title>
  <style nonce="${nonce}">${HOME_NODE_ADMIN_STYLE}</style>
</head>
<body>
  <div class="shell">
    <header class="topbar"><div class="brand"><span class="mark" aria-hidden="true"></span><span><strong>${title}</strong><small>GREENWAYS HOME NODE · LOCAL CONTROL PLANE</small></span></div><button class="theme" type="button" data-theme aria-label="Toggle light and dark theme">◐</button></header>
    <main>
      <section class="hero"><p class="eyebrow">LOOPBACK CONTROL · SIGNED BROWSERS · SERVICES BY GRANT</p><h1>Your browsers,<br><em>gathered at home.</em></h1><p class="lede">Issue one-time pairing codes, inspect the browsers that know this node, and revoke a lost profile without exposing the control plane to your network.</p><div class="trust"><span><b>01</b> Control stays on this machine</span><span><b>02</b> Each browser keeps its own key</span><span><b>03</b> Remote code stays forbidden</span></div></section>
      <section class="metrics" aria-label="Home Node status"><div class="metric"><strong data-browser-count>—</strong><span>paired browsers</span></div><div class="metric"><strong data-service-count>—</strong><span>local services</span></div><div class="metric"><strong data-pairing-state>Closed</strong><span>pairing window</span></div><div class="metric"><strong data-durability>—</strong><span>node state</span></div></section>
      <section class="section"><div class="section-head"><div><p>PAIR A BROWSER</p><h2>Open a ten-minute door.</h2></div><span>Single use · local approval</span></div><div class="panel"><div class="pairing"><div><h3>Issue a new code</h3><p>The previous code is invalidated. Enter the new code in Greenways OS on the browser you are holding.</p></div><div class="actions"><button class="primary" type="button" data-issue>Issue pairing code</button></div></div><div class="code" data-code><span><strong data-code-value>—</strong><small data-code-expiry></small></span><button class="secondary" type="button" data-copy>Copy code</button></div></div></section>
      <section class="section"><div class="section-head"><div><p>PAIRED BROWSERS</p><h2>Known devices.</h2></div><span>Administrative revocation</span></div><div class="list" data-browsers><p class="empty">Loading browser grants…</p></div></section>
      <section class="section"><div class="section-head"><div><p>LOCAL SERVICES</p><h2>Introductions, not executables.</h2></div><span>Inert descriptors only</span></div><div class="list" data-services><p class="empty">Loading service catalog…</p></div></section>
      <section class="section"><div class="section-head"><div><p>NODE IDENTITY</p><h2>The anchor on this machine.</h2></div><span>Restart-stable key</span></div><div class="panel node-card"><div><h3>${title}</h3><p class="node-id" title="${keyId}">${keyId}</p></div><span class="badge">LOCAL AUTHORITY</span></div></section>
      <p class="notice" data-notice role="status">The control plane is bound to loopback and closed to cross-site requests.</p>
    </main>
    <footer><span>Greenways Home Node</span><span>No public account required</span></footer>
  </div>
  <script nonce="${nonce}">${HOME_NODE_ADMIN_CLIENT}</script>
</body>
</html>`;
}
