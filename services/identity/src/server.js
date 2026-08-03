import { createServer } from "node:http";
import { createIdentityHandler } from "./http.js";
import { IdentityRegistry } from "./registry.js";

const handle = createIdentityHandler(new IdentityRegistry());
const port = Number(process.env.PORT ?? 8787);

createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const webRequest = new Request(`http://${request.headers.host}${request.url}`, {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
  });
  const result = await handle(webRequest);
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`id.greenways.ai development service on http://127.0.0.1:${port}\n`);
});
