// The code-review service's HTTP API (the board reads it with code_review_api_token; the Reviewer Manager's config tool and
// Aiden's one-offs go through the same routes):
//   GET  /reviews?repo=&status=&limit=   → { runs }
//   GET  /reviews/:id                    → { run, review: Review | null }
//   GET  /reviews?repo=… runs carry engine, model, effort, cost_usd (billed), tokens_in/cached/out and duration_ms
//   GET  /reviews/:id                    → { run, review, findings: [{ id, severity, path, line, title, outcome }] }
//   POST /reviews { pr_url, combos?, focus?, full? } → { runs }   a one-off review of any PR the instance can read, one run per
//                                        combo (default: the repo's on_open), each posted
//   GET  /repos                          → { repos (with month spend), month_usd, month_spent_usd, … }
//   GET  /engines                        → { engines }  each engine's efforts, offered models and default run cap
//   GET  /github/repos?q=                → { repos }   repos the GitHub identity can read (the board's picker)
// Errors are { error, detail }.
//   GET  /healthz
import { timingSafeEqual } from "node:crypto";
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

export function handler(engine: Engine, token: () => string) {
  const authorized = (req: IncomingMessage) => {
    const want = token();
    const got = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    return !!want && got.length === want.length && timingSafeEqual(Buffer.from(got), Buffer.from(want));
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname.replace(/\/+$/, "")}`;
    if (route === "GET /healthz") return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 401, { error: "unauthorized", detail: "send the code-review API token" });
    try {
      if (route === "GET /reviews") {
        const q = url.searchParams;
        return send(res, 200, { runs: engine.runs({ repo: q.get("repo") || undefined, status: q.get("status") || undefined, limit: Number(q.get("limit")) || undefined }) });
      }
      const one = /^GET \/reviews\/(cr-[0-9a-f]{12})$/.exec(route);
      if (one) {
        const r = engine.run(one[1]!);
        return r ? send(res, 200, r) : send(res, 404, { error: "not_found", detail: `no review ${one[1]}` });
      }
      if (route === "POST /reviews") return send(res, 200, { runs: await engine.oneoff(await body(req)) });
      if (route === "GET /repos") return send(res, 200, engine.repos());
      if (route === "GET /engines") return send(res, 200, { engines: engine.engines() });
      if (route === "GET /github/repos") return send(res, 200, { repos: await engine.available(url.searchParams.get("q") ?? "") });
      return send(res, 404, { error: "not_found", detail: route.slice(0, 100) });
    } catch (e) {
      if (e instanceof RequestError) return send(res, 400, { error: "bad_request", detail: e.message, ...e.extra });
      return send(res, 500, { error: "internal", detail: String((e as Error).message).slice(0, 200) });
    }
  };
}
