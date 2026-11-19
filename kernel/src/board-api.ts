// A module's board API, read through the kernel (POST|GET /v1/board-api/<module>/<path>, the board's key): the board reaches a
// module service's own HTTP routes without a network of its own to it (no legacy link). The module declares where
// (module.yaml providers.board: { url: http://<service>:<port>, auth: <one of its secrets> }); the kernel adds that secret as
// the bearer and passes the method, path, query and JSON body through, and the answer back as it came (bounded).
import { request } from "node:http";
import type { Resolver } from "./net.ts";

export type BoardApiDecl = { url: string; auth_secret: string };
const MAX = 4_000_000;

export function createBoardApi({ decl, secret, resolver }: { decl: (module: string) => BoardApiDecl | undefined; secret: (name: string) => string; resolver: Resolver }) {
  return async function call(module: string, method: string, path: string, query: string, body: string | undefined): Promise<{ status: number; body: string }> {
    const d = decl(module);
    if (!d) return { status: 404, body: JSON.stringify({ error: `${module} has no board API` }) };
    if (!/^\/[\w\-/.]*$/.test(path) || path.includes("..")) return { status: 400, body: JSON.stringify({ error: "a plain path" }) };
    const url = `${d.url.replace(/\/+$/, "")}${path}${query}`;
    const to = await resolver.resolve(url);
    return new Promise((ok) => {
      const req = request({ host: to.host, port: to.port, path: to.path, method, timeout: 20_000, headers: { authorization: `Bearer ${secret(d.auth_secret)}`, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on("data", (c: Buffer) => ((n += c.length) <= MAX ? chunks.push(c) : res.destroy()));
        res.on("end", () => ok({ status: res.statusCode ?? 502, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", () => ok({ status: 502, body: JSON.stringify({ error: `${module} broke off its answer` }) }));
      });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", (e) => (resolver.forget(url), ok({ status: 502, body: JSON.stringify({ error: `${module} is unreachable (${e.message})` }) })));
      req.end(body);
    });
  };
}
export type BoardApi = ReturnType<typeof createBoardApi>;
