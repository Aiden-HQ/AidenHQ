// The code-review service's HTTP API: only what another service asks of it (the Reviews page and the Reviewer Manager's tools
// are the MCP connection, mcp.ts and config-tool.ts):
//   GET  /v1/verdict?repo=&pr=&head=     → { verdict: pass|wait, reasons: [{ code, text, unblock? }] }   the github module's merge
//                                        queue, with that module's own token (the kernel says whose)
// Errors are { error, detail }.
//   GET  /healthz
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Engine } from "./engine.ts";

const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

export function handler(engine: Engine, isGithub: (authorization: string) => Promise<boolean | undefined>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return send(res, 400, { error: "bad request" }); }
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
    if (route === "GET /healthz") return send(res, 200, { ok: true });
    if (route === "GET /v1/verdict") {
      const ok = await isGithub(String(req.headers.authorization ?? ""));
      if (!ok) return send(res, ok === undefined ? 503 : 401, { error: "unauthorized", detail: ok === undefined ? "the kernel couldn't say whose token this is; try again" : "only the github module's token" });
      const q = url.searchParams;
      const repo = (q.get("repo") ?? "").toLowerCase(), pr = Number(q.get("pr")), head = q.get("head") ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr < 1 || !/^[0-9a-f]{40}$/.test(head)) return send(res, 400, { error: "bad_request", detail: "repo, pr and head (a 40-character sha)" });
      return send(res, 200, engine.verdict(repo, pr, head));
    }
    return send(res, 404, { error: "not_found", detail: route.slice(0, 100) });
  };
}
