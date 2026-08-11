import {
  MCP_AUTH_CONTEXT_PROTOCOL,
  MCP_READ_SCOPE,
} from "./mcp-transport.js";
import {
  MCP_PAIRING_CHALLENGE_PROTOCOL,
  MCP_PAIRING_SCOPE,
  McpPairingError,
} from "./mcp-pairing.js";

const MAX_FORM_BYTES = 64 * 1024;
const CHALLENGE_ID = /^mcp\/challenge\/[A-Za-z0-9._:-]{8,160}$/;
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function text(value, status = 200, headers = {}) {
  return new Response(value, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      ...headers,
    },
  });
}

function html(value, status = 200, headers = {}) {
  return new Response(value, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      ...headers,
    },
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function oauthHelpers(env, getOAuth) {
  const oauth = getOAuth(env);
  if (!oauth
      || typeof oauth.parseAuthRequest !== "function"
      || typeof oauth.lookupClient !== "function"
      || typeof oauth.completeAuthorization !== "function") {
    throw new Error("Greenways OAuth helpers are unavailable");
  }
  return oauth;
}

function clientName(value) {
  const output = String(value ?? "MCP Client").trim();
  return output.slice(0, 120) || "MCP Client";
}

function publicFailure(error) {
  if (error instanceof McpPairingError) {
    return {
      status: error.status >= 400 && error.status < 600 ? error.status : 400,
      code: error.code,
      message: new Set([
        "invalid-pairing",
        "pairing-too-large",
        "unsupported-scope",
        "oauth-client-mismatch",
        "invalid-oauth-client",
        "pairing-session-missing",
        "pairing-session-used",
        "pairing-challenge-expired",
        "pairing-challenge-mismatch",
        "pairing-assertion-expired",
        "pairing-signature-invalid",
        "pairing-key-mismatch",
        "unsupported-pairing-device",
      ]).has(error.code)
        ? error.message
        : "Greenways MCP authorization could not be completed.",
    };
  }
  return {
    status: 500,
    code: "authorization-unavailable",
    message: "Greenways MCP authorization is unavailable.",
  };
}

function authorizationPage({ challenge, client }) {
  const name = escapeHtml(clientName(client.clientName));
  const uri = client.clientUri ? escapeHtml(client.clientUri) : null;
  const tools = challenge.tools.map((tool) => `<li><code>${escapeHtml(tool)}</code></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="greenways-mcp-pairing-protocol" content="${MCP_PAIRING_CHALLENGE_PROTOCOL}">
  <title>Connect ${name} to Greenways OS</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(680px, calc(100% - 32px)); margin: 32px auto; }
    article { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 18px; padding: 28px; box-shadow: 0 18px 60px color-mix(in srgb, CanvasText 10%, transparent); }
    h1 { margin: 0 0 12px; font-size: clamp(1.7rem, 5vw, 2.6rem); line-height: 1.05; }
    p, li { line-height: 1.55; }
    .client { padding: 14px 16px; border-radius: 12px; background: color-mix(in srgb, CanvasText 6%, transparent); }
    .client strong, .client span { display: block; overflow-wrap: anywhere; }
    ul { columns: 2; padding-left: 22px; }
    form { display: grid; gap: 12px; margin-top: 22px; }
    textarea { box-sizing: border-box; width: 100%; min-height: 110px; resize: vertical; border: 1px solid color-mix(in srgb, CanvasText 24%, transparent); border-radius: 10px; padding: 12px; font: 0.78rem/1.45 ui-monospace, monospace; }
    button { min-height: 44px; border: 0; border-radius: 10px; padding: 0 18px; font-weight: 700; cursor: pointer; color: white; background: #176b52; }
    small { display: block; opacity: .7; line-height: 1.45; }
    @media (max-width: 560px) { article { padding: 20px; } ul { columns: 1; } }
  </style>
</head>
<body>
  <main data-greenways-mcp-pairing="${escapeHtml(challenge.id)}">
    <article>
      <h1>Connect ${name} to Greenways OS</h1>
      <p>This grants read-only access through a revocable Greenways connection. Your controller key stays inside Greenways OS.</p>
      <div class="client">
        <strong>${name}</strong>
        ${uri ? `<span>${uri}</span>` : ""}
        <span>OAuth client: ${escapeHtml(client.clientId)}</span>
      </div>
      <h2>Requested tools</h2>
      <ul>${tools}</ul>
      <form method="post" action="/authorize" autocomplete="off">
        <input type="hidden" name="challengeId" value="${escapeHtml(challenge.id)}">
        <label for="greenways-assertion"><strong>Greenways approval</strong></label>
        <textarea id="greenways-assertion" name="assertion" data-greenways-mcp-assertion required maxlength="24576" spellcheck="false" placeholder="Greenways OS will place its signed approval here."></textarea>
        <button type="submit">Authorize read access</button>
        <small>The signed approval is bound to this client, these tools, this OAuth request, and a short expiry. It cannot be reused.</small>
      </form>
    </article>
    <script id="greenways-mcp-pairing-challenge" type="application/json">${scriptJson(challenge)}</script>
  </main>
</body>
</html>`;
}

function errorPage(failure) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Greenways authorization</title></head>
<body><main><h1>Authorization was not completed</h1><p>${escapeHtml(failure.message)}</p><code>${escapeHtml(failure.code)}</code></main></body>
</html>`;
}

async function parseForm(request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) {
    throw new McpPairingError(413, "pairing-too-large", "MCP pairing form exceeds its byte limit");
  }
  const form = await request.formData();
  const challengeId = form.get("challengeId");
  const assertionText = form.get("assertion");
  if (typeof challengeId !== "string" || !CHALLENGE_ID.test(challengeId)) {
    throw new McpPairingError(400, "invalid-pairing", "MCP pairing challenge ID is invalid");
  }
  if (typeof assertionText !== "string" || !assertionText.trim() || assertionText.length > 24 * 1024) {
    throw new McpPairingError(400, "invalid-pairing", "MCP pairing assertion is invalid");
  }
  let assertion;
  try {
    assertion = JSON.parse(assertionText);
  } catch {
    throw new McpPairingError(400, "invalid-pairing", "MCP pairing assertion must be JSON");
  }
  return { challengeId, assertion: plainObject(assertion, "MCP pairing assertion") };
}

export function createGreenwaysMcpAuthorizationHandler({
  pairingService,
  getOAuth = (env) => env?.OAUTH_PROVIDER,
} = {}) {
  if (!pairingService
      || typeof pairingService.begin !== "function"
      || typeof pairingService.authorize !== "function") {
    throw new TypeError("Greenways MCP authorization requires the pairing service");
  }
  if (typeof getOAuth !== "function") throw new TypeError("Greenways MCP authorization requires OAuth helpers");

  return Object.freeze({
    async fetch(request, env = {}) {
      let url;
      try {
        url = new URL(request.url);
      } catch {
        return text("Invalid request URL", 400);
      }
      if (url.pathname !== "/authorize") return text("Not found", 404);
      try {
        const oauth = oauthHelpers(env, getOAuth);
        if (request.method === "GET") {
          const oauthRequest = await oauth.parseAuthRequest(request);
          const client = await oauth.lookupClient(oauthRequest.clientId);
          if (!client) return text("Unknown OAuth client", 400);
          const challenge = await pairingService.begin({ oauthRequest, clientInfo: client });
          return html(authorizationPage({ challenge, client }));
        }
        if (request.method === "POST") {
          const { challengeId, assertion } = await parseForm(request);
          const paired = await pairingService.authorize({
            challengeId,
            assertion,
            completeAuthorization: async ({ oauthRequest, identity, connection }) => {
              const completion = await oauth.completeAuthorization({
                request: oauthRequest,
                userId: identity.id,
                metadata: {
                  label: `Greenways read access for ${connection.client.name}`,
                  clientName: connection.client.name,
                  identityId: identity.id,
                  connectionId: connection.id,
                },
                scope: [MCP_READ_SCOPE],
                props: {
                  protocol: MCP_AUTH_CONTEXT_PROTOCOL,
                  connectionId: connection.id,
                },
              });
              if (!completion || typeof completion.redirectTo !== "string") {
                throw new Error("OAuth provider did not return a redirect");
              }
              return Object.freeze({ redirectTo: completion.redirectTo });
            },
          });
          return new Response(null, {
            status: 302,
            headers: {
              ...SECURITY_HEADERS,
              Location: paired.oauthResult.redirectTo,
            },
          });
        }
        return text("Method not allowed", 405, { Allow: "GET, POST" });
      } catch (error) {
        const failure = publicFailure(error);
        return html(errorPage(failure), failure.status);
      }
    },
  });
}
