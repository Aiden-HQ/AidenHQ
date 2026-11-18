// A running job's own requests for its task's next turn (POST /v1/jobtools/<cmd>, the in-box `aidenhq reset|engine|cleanup`):
// a fresh session, another engine or model, the workspace removed when the turn ends. The caller is a kernel job's token
// (boxes.ts: `ahqj_` kind job, naming its job); the job is that one, live, on the token's own agent and task, never one the
// body names. Each request is recorded on the job; the next turn's admission reads it once (nextTurn) and checks an engine
// or model against the agent's profile like any other.
import type { DatabaseSync } from "node:sqlite";
import { verifyToken } from "./gateway/token.ts";

export const JOB_TOOLS = ["reset", "engine", "cleanup"] as const;
export type NextTurn = { fresh: boolean; engine: { kind: string; model?: string } | null; cleanup: boolean };

export class JobToolError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "JobToolError"; this.status = status; this.code = code; }
}

const KIND = /^[a-z][a-z0-9-]{0,40}$/;
const MODEL = /^~?[\w.-]{1,60}\/[\w.:-]{1,100}$/;

export function createJobTools({ db, secret, engines, now = Date.now }: {
  db: DatabaseSync;
  /** The kernel's gateway_job_secret, read fresh. */
  secret: () => string;
  /** The engine kinds the compiled registry provides (config/engines.json). */
  engines: () => string[];
  now?: () => number;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS jobtools (job TEXT PRIMARY KEY, fresh INTEGER NOT NULL DEFAULT 0, engine TEXT, cleanup INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)");
  const save = db.prepare(`INSERT INTO jobtools (job, fresh, engine, cleanup, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (job) DO UPDATE SET fresh = MAX(fresh, excluded.fresh), engine = COALESCE(excluded.engine, engine), cleanup = MAX(cleanup, excluded.cleanup), at = excluded.at`);

  /** The live job this token names, on the token's own agent and task. */
  function jobOf(token: string): string {
    const p = verifyToken(secret(), token, now());
    if (p?.k !== "job" || !p.id) throw new JobToolError(401, "unauthorized", "a kernel job's own token is required");
    const r = db.prepare("SELECT agent, task, state FROM jobs WHERE id = ?").get(p.id) as { agent: string; task: string; state: string } | undefined;
    if (!r || r.agent !== p.a || r.task !== p.i || !["admitted", "running"].includes(r.state)) throw new JobToolError(409, "job-ended", "this job has ended");
    return p.id;
  }

  return {
    /** One command from a job's box: what it prints. */
    run(token: string, cmd: string, b: { engine?: unknown; model?: unknown }): string {
      if (!(JOB_TOOLS as readonly string[]).includes(cmd)) throw new JobToolError(404, "no-command", `no command ${cmd} (${JOB_TOOLS.join(", ")})`);
      const job = jobOf(token);
      if (cmd === "reset") return (save.run(job, 1, null, 0, now()), "The next turn starts with a fresh session.");
      if (cmd === "cleanup") return (save.run(job, 0, null, 1, now()), "The workspace is removed when this turn ends.");
      const kind = String(b?.engine ?? ""), model = b?.model == null || b.model === "" ? undefined : String(b.model);
      if (!KIND.test(kind) || !engines().includes(kind)) throw new JobToolError(400, "unknown-engine", `no engine "${kind}" (${engines().join(", ") || "none"})`);
      if (model !== undefined && !MODEL.test(model)) throw new JobToolError(400, "bad-model", `"${model}" isn't a model id (vendor/model)`);
      save.run(job, 0, JSON.stringify({ kind, ...(model ? { model } : {}) }), 0, now());
      return `The next turn runs on ${kind}${model ? ` (${model})` : ""}.`;
    },
    /** What a finished job asked of its task's next turn: read once, then gone. */
    nextTurn(job: string): NextTurn {
      const r = db.prepare("DELETE FROM jobtools WHERE job = ? RETURNING fresh, engine, cleanup").get(job) as { fresh: number; engine: string | null; cleanup: number } | undefined;
      return { fresh: r?.fresh === 1, engine: r?.engine ? JSON.parse(r.engine) : null, cleanup: r?.cleanup === 1 };
    },
  };
}
export type JobTools = ReturnType<typeof createJobTools>;
