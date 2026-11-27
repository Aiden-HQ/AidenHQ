// The grading module's routes, each behind its own caller's key:
//   POST /grades          the tasks module, as the delegating agent (its caller assertion, aud tasks): file a task's rubric
//   POST /check/rubric    the kernel (grading_check_key): the rubric of a task a module filed (kernel/src/modtasks.ts)
//   POST /board/grades    the board (grading_board_key): the rows of the tasks it shows
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { kernelJwks, verifyCaller, type JWKS } from "./aidenhq-sdk/caller.ts";
import { Conflict, Invalid, parseFiling, type Store } from "./store.ts";

class HttpError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
/** Tools that hand a task to an agent and file its rubric. */
const FILERS = ["task_delegate", "task_create"];

export function createServer({ store, issue, keys, jwks = kernelJwks(), log = () => {} }: {
  store: Store; issue: (ref: string) => Promise<{ id: string; identifier?: string; createdByAgentId?: string | null }>;
  keys: { check: string; board: string }; jwks?: JWKS | (() => Promise<JWKS>); log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  const keyed = (req: http.IncomingMessage, key: string) => {
    const a = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "")), b = Buffer.from(key);
    if (!(b.length > 0 && a.length === b.length && timingSafeEqual(a, b))) throw new HttpError(403, "forbidden");
  };

  /** An agent's delegation: only the agent that delegated the task files its rubric. */
  async function file(req: http.IncomingMessage, body: { issue?: unknown }) {
    const caller = await verifyCaller(req, jwks, "tasks").catch((e: Error) => { throw new HttpError(403, `refused: ${e.message}`); });
    if (!FILERS.includes(String(caller.tool ?? "").split(".").pop()!)) throw new HttpError(403, `only an agent granted ${FILERS.join(" or ")} files a rubric`);
    if (typeof body?.issue !== "string" || !body.issue) throw new Invalid("send {issue, rubric, deliverable}");
    const f = parseFiling(body);
    const i = await issue(body.issue);
    if (i.createdByAgentId !== caller.agent) throw new HttpError(403, "only the agent that delegated a task files its rubric");
    const created = store.file(i.id, `agent:${caller.agent}`, f.rubric, f.deliverable);
    if (created) log("rubric filed", { task: i.identifier, kind: f.deliverable.kind, criteria: f.rubric.length });
    return { created };
  }

  /** A module's filing, vouched for by the kernel (its key), after it checked the module holds kernel.tasks. */
  function fileForModule(b: { task?: { id?: unknown }; module?: unknown }) {
    if (typeof b?.task?.id !== "string" || typeof b.module !== "string") throw new Invalid("send {task, module, rubric, deliverable}");
    const f = parseFiling(b);
    const created = store.file(b.task.id, `module:${b.module}`, f.rubric, f.deliverable);
    if (created) log("rubric filed for a module's task", { task: b.task.id, module: b.module, kind: f.deliverable.kind });
    return { verdict: "ok" };
  }

  /** Every id asked about: its row, or null for none. */
  function board(b: { ids?: unknown }) {
    const ids = b?.ids;
    if (!Array.isArray(ids) || ids.length > 500) throw new Invalid("send {ids} (at most 500)");
    return { grades: Object.fromEntries(ids.map((id) => [String(id), store.get(String(id)) ?? null])) };
  }

  return http.createServer(async (req, res) => {
    const path = String(req.url ?? "").split("?")[0]!;
    const send = (status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body ?? null));
    try {
      if (path === "/healthz") return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      const chunks: Buffer[] = [];
      let n = 0;
      for await (const c of req) { n += c.length; if (n > 1_000_000) throw new HttpError(413, "too large"); chunks.push(c); }
      let body: any;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { throw new HttpError(400, "the body must be JSON"); }
      if (req.method !== "POST") throw new HttpError(404, "no such route");
      if (path === "/grades") return send(200, await file(req, body));
      if (path === "/check/rubric") return (keyed(req, keys.check), send(200, fileForModule(body)));
      if (path === "/board/grades") return (keyed(req, keys.board), send(200, board(body)));
      throw new HttpError(404, "no such route");
    } catch (err) {
      const e = err as Error & { status?: number };
      const status = e instanceof Invalid ? 400 : e instanceof Conflict ? 409 : e instanceof HttpError ? e.status : e.status === 404 ? 404 : 500;
      if (status >= 500) log("grading error", { path, err: String(e.message).slice(0, 300) });
      // The kernel reads a refused module filing as a deny verdict (kernel/src/checks.ts rubric).
      if (!res.headersSent) send(status, path === "/check/rubric" && status < 500 ? { verdict: "deny", reason: e.message } : { error: e.message });
    }
  });
}
