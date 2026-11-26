// The code-review service's HTTP API: only what another module asks of it, each with its own token (the kernel says whose);
// the Reviews page and the Reviewer Manager's tools are the MCP connection (mcp.ts and config-tool.ts):
//   GET  /v1/verdict?repo=&pr=&head=[&base=&association=]
//                                        → { verdict: pass|wait, reasons: [{ code, text, unblock? }], requires_review, tier, policy?,
//                                        reviewed, kind }   the github module's merge queue and ship's approval. tier: { state:
//                                        classified, tier, rule, why } | { state: pending } (no current classification of that head,
//                                        the caller's live base branch differs from what it came from, or the caller's live author
//                                        association shows a loss of access from the member association it was classified with) |
//                                        { state: unwatched }; requires_review: the head's tier has a mandatory combo; policy: the
//                                        head's review policy (a label); kind: completed (the head is covered), exhausted (the
//                                        verdict stands on `reviewed`, an earlier head), skipped, or none (its tier needs no review)
//   POST /reviews { pr_url, task? }      → { runs }   the ship module's ask on a fork it adopted: a one-off review of that PR,
//                                        its summary on `task` (the adoption's)
//   POST /reviews { pr_url, fresh: true, head } → { runs }   ship's gating review of the head (a writer's `aiden review`), when a
//                                        model fix has no review of its own
// Errors are { error, detail }.
//   GET  /healthz
import type { IncomingMessage, ServerResponse } from "node:http";
import { RequestError, type Engine } from "./engine.ts";

const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 64_000) throw new RequestError("the body is too large");
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  throw new RequestError("send a JSON object");
}

export function handler(engine: Engine, isModule: (authorization: string, module: string) => Promise<boolean | undefined>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); } catch { return send(res, 400, { error: "bad request" }); }
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
    if (route === "GET /healthz") return send(res, 200, { ok: true });
    if (route === "GET /v1/verdict") {
      const auth = String(req.headers.authorization ?? "");
      const gh = await isModule(auth, "github");
      const ok = gh || (await isModule(auth, "ship"));
      if (!ok) return send(res, ok === undefined || gh === undefined ? 503 : 401, { error: "unauthorized", detail: ok === undefined || gh === undefined ? "the kernel couldn't say whose token this is; try again" : "only the github or ship module's token" });
      const q = url.searchParams;
      const repo = (q.get("repo") ?? "").toLowerCase(), pr = Number(q.get("pr")), head = q.get("head") ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr < 1 || !/^[0-9a-f]{40}$/.test(head)) return send(res, 400, { error: "bad_request", detail: "repo, pr and head (a 40-character sha)" });
      const live = { ...(q.has("base") ? { base: q.get("base")! } : {}), ...(q.has("association") ? { association: q.get("association")! } : {}) };
      return send(res, 200, { ...engine.verdict(repo, pr, head, live), ...engine.evidence(repo, pr, head) });
    }
    if (route === "POST /reviews") {
      const ok = await isModule(String(req.headers.authorization ?? ""), "ship");
      if (!ok) return send(res, ok === undefined ? 503 : 401, { error: "unauthorized", detail: ok === undefined ? "the kernel couldn't say whose token this is; try again" : "only the ship module's token" });
      try {
        const b = await body(req);
        if (b.fresh === true) return send(res, 200, { runs: await engine.fresh({ pr_url: b.pr_url, head: b.head }) });
        const task = typeof b.task === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(b.task) ? b.task : undefined;
        return send(res, 200, { runs: await engine.oneoff({ pr_url: b.pr_url }, { requester: "Ship", ...(task ? { task } : {}) }) });
      } catch (e) {
        return send(res, e instanceof RequestError ? 400 : 500, { error: e instanceof RequestError ? "bad_request" : "internal", detail: String((e as Error).message).slice(0, 200) });
      }
    }
    return send(res, 404, { error: "not_found", detail: route.slice(0, 100) });
  };
}
