// What the ship module's watch loop (modules/ship/service/src/loop.ts) reads and does on GitHub, through this service with
// ship's own module token (the kernel vouches for it, GET /v1/whoami): the owner's sign-in stays here. Every route is ship's alone:
//   POST /internal/ship/gh       {method, path, body?, deadline?} -> {status, body} | {thrown: {message, cause}}: one GitHub call as
//                                the owner, background, from a fixed list (the loop's reads, check re-runs, update-branch, closing
//                                an abandoned PR and deleting its branch, its comment), on a repo the fleet merges in. No merge.
//   POST /internal/ship/flow     {fn, args} -> Flow's fact for what the loop saw (flow.ts), or `authored`'s answer
//   POST /internal/ship/verdict  {repo, number, head} -> code review's verdict for that head (review-gate.ts; null: not gated)
//   POST /internal/ship/decide   {data, head} -> the merge gate's rule on the loop's view of a PR (merge-gate.ts decide)
//   GET  /internal/ship/openers  -> pr-tasks.json: which task opened each PR
import type { IncomingMessage, ServerResponse } from "node:http";
import { decide } from "./merge-gate.ts";
import { readPrTasks } from "./pr-tasks.ts";
import type { ReviewGate } from "./review-gate.ts";

type Gh = (method: string, path: string, body?: unknown, o?: { background?: boolean; deadline?: number }) => Promise<{ status: number; body: any }>;
type Json = any;
const REPO = "([\\w.-]+/[\\w.-]+)";
/** The GitHub calls the loop makes, and nothing else: [method, path, body check]. The repo is the path's first group. */
const CALLS: [string, RegExp, ((b: Json) => boolean)?][] = [
  ["GET", new RegExp(`^/repos/${REPO}/commits/[0-9a-f]{4,40}/check-runs\\?[\\w=&]*$`)],
  ["GET", new RegExp(`^/repos/${REPO}/actions/jobs/\\d+$`)],
  ["POST", new RegExp(`^/repos/${REPO}/actions/jobs/\\d+/rerun$`)],
  ["POST", new RegExp(`^/repos/${REPO}/actions/runs/\\d+/rerun-failed-jobs$`)],
  ["GET", new RegExp(`^/repos/${REPO}/actions/runs/\\d+/jobs$`)],
  ["GET", new RegExp(`^/repos/${REPO}/pulls/\\d+$`)],
  ["PATCH", new RegExp(`^/repos/${REPO}/pulls/\\d+$`), (b) => JSON.stringify(b) === JSON.stringify({ state: "closed" })],
  ["POST", new RegExp(`^/repos/${REPO}/issues/\\d+/comments$`), (b) => typeof b?.body === "string" && Object.keys(b).length === 1],
  ["DELETE", new RegExp(`^/repos/${REPO}/git/refs/heads/[\\w./-]+$`)],
  ["PUT", new RegExp(`^/repos/${REPO}/pulls/\\d+/update-branch$`)],
  ["GET", new RegExp(`^/repos/${REPO}/compare/[0-9a-f]{4,40}\\.\\.\\.[0-9a-f]{4,40}$`)],
  ["GET", new RegExp(`^/repos/${REPO}/check-runs/\\d+$`)],
];
const FLOW = ["opened", "pushed", "merged", "closed", "checksStarted", "checksCompleted", "authored"] as const;

export function shipRoutes(o: {
  gh: Gh; flow: Record<(typeof FLOW)[number], (...a: any[]) => unknown>; gate: ReviewGate; cacheDir: string;
  /** Whether the fleet works this repo (git-auth.ts mergeable): ship's calls reach no other. */
  allowed: (repo: string) => boolean;
  /** Whether a bearer is the ship module's own token (undefined: the kernel couldn't say now). */
  isShip: (authorization: string) => Promise<boolean | undefined>;
}) {
  // A bearer the kernel vouched for is trusted for five minutes: the loop makes a call per check it reads, each one here.
  const vouched = new Map<string, number>();
  const isShip = async (auth: string) => {
    if ((vouched.get(auth) ?? 0) > Date.now()) return true;
    const ok = await o.isShip(auth);
    if (ok) vouched.set(auth, Date.now() + 5 * 60_000); else vouched.delete(auth);
    return ok;
  };
  const send = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body ?? null));
  /** Serves a /internal/ship/ request; false for any other path. */
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const op = new URL(req.url ?? "/", "http://x").pathname.match(/^\/internal\/ship\/(\w+)$/)?.[1];
    if (!op) return false;
    const ok = await isShip(String(req.headers.authorization ?? ""));
    if (!ok) return send(res, ok === undefined ? 503 : 401, { error: "ship's module token only" }), true;
    try {
      if (op === "openers" && req.method === "GET") return send(res, 200, readPrTasks(o.cacheDir)), true;
      if (req.method !== "POST") return send(res, 405, { error: "POST" }), true;
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > 4_000_000) return send(res, 413, { error: "too large" }), true; }
      const b = JSON.parse(raw || "{}");
      if (op === "gh") {
        const { method, path, body, deadline } = b;
        const call = CALLS.find(([m, re]) => m === method && re.test(String(path)));
        const repo = call ? String(path).match(call[1])![1]! : method === "POST" && path === "/graphql" ? `${b.body?.variables?.owner}/${b.body?.variables?.repo}` : "";
        // A read of the open PRs is the one query (no mutation); every other call is one of CALLS.
        const query = method === "POST" && path === "/graphql" && typeof body?.query === "string" && !/\bmutation\b/i.test(body.query);
        if ((!call && !query) || (call?.[2] && !call[2](body)) || !o.allowed(repo)) return send(res, 403, { error: `ship may not call ${String(method)} ${String(path).slice(0, 200)}` }), true;
        try { return send(res, 200, await o.gh(method, path, body, { background: true, ...(typeof deadline === "number" ? { deadline } : {}) })), true; }
        catch (e) {
          const cause = (e as { need?: { cause?: string } }).need?.cause ?? (e as { cause?: unknown }).cause;
          return send(res, 200, { thrown: { message: String((e as Error).message ?? e).slice(0, 500), ...(typeof cause === "string" ? { cause } : {}) } }), true;
        }
      }
      if (op === "flow") {
        if (!FLOW.includes(b.fn) || !Array.isArray(b.args)) return send(res, 400, { error: `fn: one of ${FLOW.join(", ")}; args: a list` }), true;
        return send(res, 200, { value: (await o.flow[b.fn as (typeof FLOW)[number]](...b.args)) ?? null }), true;
      }
      if (op === "verdict") return send(res, 200, (await o.gate(String(b.repo), Number(b.number), String(b.head))) ?? null), true;
      if (op === "decide") return send(res, 200, decide(b.data, String(b.head))), true;
      return send(res, 404, { error: "no such operation" }), true;
    } catch (e) {
      return send(res, 500, { error: String((e as Error).message ?? e).slice(0, 300) }), true;
    }
  };
}
