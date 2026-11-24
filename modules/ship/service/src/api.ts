// The ship service's small HTTP API: the github module's generation check on ship's writes (the Fleet page and agents use the MCP
// tools in config-tool.ts, not HTTP).
//   GET /v1/generation?repo=&pr=  → { generation, hold }   the github module's token only (the kernel says whose)
//   GET /healthz
import type { IncomingMessage, ServerResponse } from "node:http";
import type { State } from "./state.ts";

const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export function handler(d: { state: State; isModule: (authorization: string, module: string) => Promise<boolean | undefined> }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return send(res, 400, { error: "bad request" }); }
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
    if (route === "GET /healthz") return send(res, 200, { ok: true });
    if (route !== "GET /v1/generation") return send(res, 404, { error: "not_found" });
    const ok = await d.isModule(String(req.headers.authorization ?? ""), "github");
    if (!ok) return send(res, ok === undefined ? 503 : 401, { error: "unauthorized", detail: ok === undefined ? "the kernel couldn't say whose token this is; try again" : "only the github module's token" });
    const repo = (url.searchParams.get("repo") ?? "").toLowerCase(), pr = Number(url.searchParams.get("pr"));
    if (!REPO.test(repo) || !Number.isInteger(pr) || pr < 1) return send(res, 400, { error: "bad_request", detail: "repo (owner/name) and pr" });
    const a = d.state.get(repo, pr);
    return send(res, 200, { generation: a?.generation ?? null, hold: a?.hold ?? null });
  };
}
