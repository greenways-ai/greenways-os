const discovery = {
  protocol: "greenways-identity-service/0-alpha",
  identityEndpoint: "/v1/identities/{identity-id}",
  handleEndpoint: "/v1/handles/{handle}",
  claimEndpoint: "/v1/claims",
  privateKeysAccepted: false,
  globalChain: false,
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": status === 200 ? "public, max-age=60" : "no-store" },
  });
}

export function createIdentityHandler(registry) {
  return async function handle(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/.well-known/greenways-identity") return json(200, discovery);
    const identityMatch = url.pathname.match(/^\/v1\/identities\/(.+)$/);
    if (request.method === "GET" && identityMatch) {
      const result = await registry.resolveIdentity(decodeURIComponent(identityMatch[1]));
      return result ? json(200, result) : json(404, { error: "identity-not-found" });
    }
    const handleMatch = url.pathname.match(/^\/v1\/handles\/(.+)$/);
    if (request.method === "GET" && handleMatch) return json(200, await registry.resolveHandle(decodeURIComponent(handleMatch[1])));
    if (request.method === "POST" && url.pathname === "/v1/claims") {
      try {
        return json(201, await registry.register(await request.json()));
      } catch (error) {
        return json(400, { error: "invalid-identity-claim", detail: error.message });
      }
    }
    return json(404, { error: "not-found" });
  };
}
