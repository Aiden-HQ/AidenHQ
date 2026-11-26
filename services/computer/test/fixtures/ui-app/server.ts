// The ui-review engine's fixture app: one HTML shell, a hash router, 60 routes. Neutral copy (acme, example.com).
//   node server.ts [port]      serves it (prints the URL)
//   startFixture(port?)        for tests: { url, writes(), set(key, value), close() }
// Routes (ROUTES): the generated /r01../r54 plus /live (polls every 50 ms, never settles), /scroll (scrolls inside <main>),
// /planted (the measurement plants), /clock ("2m ago" from Date.now()), /danger (Delete and Pay POST: the server counts writes).
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
const shell = (title: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script src="/app.js"></script></body></html>`;

/** The 60 hash routes (app.js renders the same set). */
export const ROUTES: string[] = ["/", "/live", "/scroll", "/planted", "/clock", "/danger", ...Array.from({ length: 54 }, (_, i) => `/r${String(i + 1).padStart(2, "0")}`)];

export type Fixture = { url: string; port: number; writes(): number; set(key: string, value: string): void; close(): Promise<void> };

export async function startFixture(port = 0): Promise<Fixture> {
  let writes = 0;
  const state: Record<string, string> = { "planted-title": "Planted page" };
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "POST") {
      if (path.startsWith("/api/")) writes++;
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (path === "/app.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(`${dir}app.js`));
    if (path === "/style.css") return void res.writeHead(200, { "content-type": "text/css" }).end(readFileSync(`${dir}style.css`));
    if (path === "/api/state") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state));
    if (path === "/api/items") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: 1, name: "Acme order 1001" }, { id: 2, name: "Acme order 1002" }]));
    if (path === "/api/live") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ t: Date.now() }));
    if (path === "/" || path === "/index.html" || !path.includes(".")) return void res.writeHead(200, { "content-type": "text/html" }).end(shell("Acme fixture"));
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
  const p = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${p}`, port: p, writes: () => writes, set: (k, v) => { state[k] = v; },
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await startFixture(Number(process.argv[2] ?? 0));
  console.log(f.url);
}
