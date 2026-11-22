// The code-review service's HTTP API (the board reads it with code_review_api_token; the Reviewer Manager's config tool and
// Aiden's one-offs go through the same routes):
//   GET  /reviews?repo=&status=&limit=   → { runs }
//   GET  /reviews/:id                    → { run, review: Review | null }
//   GET  /reviews?repo=… runs carry engine, model, effort, cost_usd (billed), tokens_in/cached/out, duration_ms and box_at (when its check job got its box; wall time excludes queueing)
//   GET  /reviews/:id                    → { run, review, findings: [{ id, severity, path, line, title, outcome }] }
//   POST /reviews { pr_url, combos?, focus?, full? }  x-aidenhq-caller?  → { runs }   a one-off review of any open or merged PR the
//                                        instance can read, one run per combo (default: the repo's on_open), each posted; with the
//                                        kernel's signed caller (the Reviewer Manager's tool) its agent and task hear the batch's one
//                                        summary, otherwise the owner does (the board)
//   GET  /repos                          → { repos (with today spend), day_usd, day_spent_usd, … }
//   GET  /engines                        → { engines }  each engine's efforts, offered models and default run cap
//   GET  /github/repos?q=                → { repos }   repos the GitHub identity can read (the board's picker)
//   POST /findings/dismiss { repo, number, id, reason, by? } → { dismissed }   the owner dismisses an open finding (the board)
//   GET  /v1/verdict?repo=&pr=&head=     → { verdict: pass|wait, reasons: [{ code, text, unblock? }] }   the github module's merge
//                                        queue, with that module's own token (the kernel says whose), never the board's token
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

/** The reviewer of a request's caller: the kernel's signed assertion, checked by the service (main.ts's verifyCaller). */
export type Ask = (req: IncomingMessage) => Promise<{ requester: string; task?: string } | undefined>;
export function handler(engine: Engine, token: () => string, isGithub: (authorization: string) => Promise<boolean | undefined>, ask: Ask = async () => undefined) {
  const authorized = (req: IncomingMessage) => {
    const want = Buffer.from(token());
    const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
  };
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
      if (route === "POST /reviews") return send(res, 200, { runs: await engine.oneoff(await body(req), await ask(req)) });
      if (route === "GET /repos") return send(res, 200, engine.repos());
      if (route === "POST /findings/dismiss") return send(res, 200, engine.dismiss(await body(req)));
      if (route === "GET /engines") return send(res, 200, { engines: engine.engines() });
      if (route === "GET /github/repos") return send(res, 200, { repos: await engine.available(url.searchParams.get("q") ?? "") });
      return send(res, 404, { error: "not_found", detail: route.slice(0, 100) });
    } catch (e) {
      if (e instanceof RequestError) return send(res, 400, { error: "bad_request", detail: e.message, ...e.extra });
      return send(res, 500, { error: "internal", detail: String((e as Error).message).slice(0, 200) });
    }
  };
}
