// A running job's own requests for its task's next turn (POST /v1/jobtools/<cmd>, the in-box `aidenhq reset|engine|cleanup`):
// a fresh session, another engine or model, the workspace removed when the turn ends. The caller is a kernel job's token
// (boxes.ts: `ahqj_` kind job, naming its job); the job is that one, live, on the token's own agent and task, never one the
// body names. Each request is recorded on the job. `cleanup` happens when the asking job's box is released (boxes.ts); the
// next turn's admission (admission.ts) applies `reset` and `engine`, checking the engine and model against the agent's grants
// then, and the requests go once that turn has started (taken), so a deferred or failed start keeps them for the next try.
// It also counts a job's prechecks (`aidenhq review`, backplane.ts and main.ts): a reviewer call each, PRECHECKS a job.
import type { DatabaseSync } from "node:sqlite";
import { verifyToken } from "./gateway/token.ts";

export const JOB_TOOLS = ["reset", "engine", "cleanup"] as const;
/** A job's prechecks (`aidenhq review`): each is a reviewer call. */
export const PRECHECKS = 3;
/** A reviewer call's failures (reviews.ts) before any reviewer took the request: none installed, no key, its module refused or
 * unreachable. A timeout or a failed review may have spent: never refunded. */
const NOT_REVIEWED = ["no_reviewer", "no_service_key", "bad_reviewer"];
export type NextTurn = { job: string; fresh: boolean; engine: { kind: string; model?: string } | null; cleanup: boolean };

export class JobToolError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "JobToolError"; this.status = status; this.code = code; }
}

const KIND = /^[a-z][a-z0-9-]{0,40}$/;
const MODEL = /^~?[\w.-]{1,60}\/[\w.:-]{1,100}$/;

export function createJobTools({ db, secret, engines, orgs = () => [], reach = () => false, now = Date.now }: {
  db: DatabaseSync;
  /** The kernel's gateway_job_secret, read fresh. */
  secret: () => string;
  /** The engine kinds the compiled registry provides that run in an agent computer (config/engines.json `box: true`). */
  engines: () => string[];
  /** The agents orgs (one per enabled code host): the only orgs a job's `repo-checkout` may name. */
  orgs?: () => string[];
  /** Whether the code host's merge rules reach this repo (the agents orgs, the product, `maintainer_repos`; never the instance repo, which only Apply writes): the repos a session may push. */
  reach?: (repo: string) => boolean;
  now?: () => number;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS jobtools (job TEXT PRIMARY KEY, fresh INTEGER NOT NULL DEFAULT 0, engine TEXT, cleanup INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS jobtool_reviews (job TEXT PRIMARY KEY, n INTEGER NOT NULL)");
  if (!(db.prepare("PRAGMA table_info(jobtool_reviews)").all() as { name: string }[]).some((c) => c.name === "refunds")) db.exec("ALTER TABLE jobtool_reviews ADD COLUMN refunds INTEGER NOT NULL DEFAULT 0");
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

  /**
   * Why an engine request can't run now, or undefined. `a`: the agent's authority (its engine, the engines and models its grant
   * allows): the kind must be one of its engines that the registry runs in a computer, and a change of engine names its model,
   * one of the agent's models.
   */
  function refusal(e: { kind: string; model?: string }, a: { engine: string; engines: string[]; models: string[] }): string | undefined {
    if (!engines().includes(e.kind) || !a.engines.includes(e.kind)) return `engine "${e.kind}" isn't one this agent may run (${a.engines.filter((k) => engines().includes(k)).join(", ") || "none"})`;
    if (e.kind !== a.engine && e.model === undefined) return `a change of engine names its model too (aidenhq engine ${e.kind} <model>)`;
    if (e.model !== undefined && !a.models.includes(e.model)) return `model ${e.model} isn't one this agent may use (${a.models.join(", ") || "none"})`;
  }

  return {
    /** One command from a job's box: what it prints. */
    run(token: string, cmd: string, b: { engine?: unknown; model?: unknown }): string {
      if (!(JOB_TOOLS as readonly string[]).includes(cmd)) throw new JobToolError(404, "no-command", `no command ${cmd} (${JOB_TOOLS.join(", ")})`);
      const job = jobOf(token);
      if (cmd === "reset") return (save.run(job, 1, null, 0, now()), "The next turn starts with a fresh session.");
      if (cmd === "cleanup") return (save.run(job, 0, null, 1, now()), "The workspace is removed when this turn ends.");
      const kind = String(b?.engine ?? ""), model = b?.model == null || b.model === "" ? undefined : String(b.model);
      if (!KIND.test(kind)) throw new JobToolError(400, "bad-engine", `"${kind}" isn't an engine name`);
      if (model !== undefined && !MODEL.test(model)) throw new JobToolError(400, "bad-model", `"${model}" isn't a model id (vendor/model)`);
      // Told now, against this job's own authority; the next admission checks again against the agent's grants then.
      const r = db.prepare("SELECT authority FROM jobs WHERE id = ?").get(job) as { authority: string | null } | undefined;
      const why = refusal({ kind, ...(model ? { model } : {}) }, r?.authority ? JSON.parse(r.authority) : { engine: "", engines: [], models: [] });
      if (why) throw new JobToolError(400, "not-allowed", why);
      save.run(job, 0, JSON.stringify({ kind, ...(model ? { model } : {}) }), 0, now());
      return `The next turn runs on ${kind}${model ? ` (${model})` : ""}.`;
    },
    /**
     * A job's `repo-checkout`: the code host snapshot to ask for, once this live job holds the `repo-checkout` role (frozen at
     * its admission) and names a repo of an agents org at a full commit sha (none: the default branch).
     */
    checkout(token: string, b: { repo?: unknown; sha?: unknown }): { repo: string; ref: string } {
      const r = db.prepare("SELECT authority FROM jobs WHERE id = ?").get(jobOf(token)) as { authority: string | null } | undefined;
      if (!(r?.authority ? JSON.parse(r.authority).roles ?? [] : []).includes("repo-checkout")) throw new JobToolError(403, "no-role", "repo-checkout needs the repo-checkout role");
      const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(b?.repo ?? "").trim()), allowed = orgs();
      if (!m || /^\.+$/.test(m[1]!) || /^\.+$/.test(m[2]!)) throw new JobToolError(400, "bad-repo", "give the repository as org/name");
      if (!allowed.some((o) => o.toLowerCase() === m[1]!.toLowerCase())) throw new JobToolError(403, "not-allowed", `only repositories in the agents orgs (${allowed.join(", ") || "none configured"})`);
      const sha = String(b?.sha ?? "").trim().toLowerCase();
      if (sha && !/^[0-9a-f]{40}$/.test(sha)) throw new JobToolError(400, "bad-sha", "give the full 40-character commit SHA (e.g. the PR's head), or none for the default branch");
      return { repo: `${m[1]}/${m[2]!.replace(/\.git$/, "")}`, ref: sha || "HEAD" };
    },
    /**
     * A session job's git credential (`git-credential-aidenhq`, `gh`): the repo to ask the code host's `app_token` for, once this
     * live job holds the `session` profile (frozen at its admission) and names a repo the merge rules reach. The token itself
     * is the code host's, narrowed to that repo, and lasts at most an hour (codehost.ts appToken); the owner's never leaves it.
     */
    gitToken(token: string, b: { repo?: unknown }): { repo: string } {
      const r = db.prepare("SELECT authority FROM jobs WHERE id = ?").get(jobOf(token)) as { authority: string | null } | undefined;
      if ((r?.authority ? JSON.parse(r.authority).profile : undefined) !== "session") throw new JobToolError(403, "no-role", "a git token is a session's");
      const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(b?.repo ?? "").trim());
      if (!m || /^\.+$/.test(m[1]!) || /^\.+$/.test(m[2]!)) throw new JobToolError(400, "bad-repo", "give the repository as org/name");
      const repo = `${m[1]}/${m[2]!.replace(/\.git$/, "")}`;
      if (!reach(repo)) throw new JobToolError(403, "not-allowed", `${repo} isn't a repository the code host merges in (the agents orgs, the product, maintainer_repos)`);
      return { repo };
    },
    /**
     * A job's `aidenhq clone`: a repository for an engineer job's box to clone, or to fetch into the clone it has, from the
     * bundle of its default branch (every branch, on this server) the kernel serves under the job's dispatcher's clone grant
     * (codehost.ts bundle): the same repos its task's clones at admission come from (boxes.ts).
     */
    clone(token: string, b: { repo?: unknown; head?: unknown }): { repo: string; module: string; head?: string } {
      const r = db.prepare("SELECT module, authority FROM jobs WHERE id = ?").get(jobOf(token)) as { module: string; authority: string | null } | undefined;
      if ((r?.authority ? JSON.parse(r.authority).profile : undefined) !== "engineer") throw new JobToolError(403, "no-role", "aidenhq clone is an Engineer's");
      const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(b?.repo ?? "").trim());
      if (!m || /^\.+$/.test(m[1]!) || /^\.+$/.test(m[2]!) || m[2]!.endsWith(".git")) throw new JobToolError(400, "bad-repo", "give the repository as <org>/<name>");
      // `head`: one commit of the repo instead of its default branch (a fork PR's head, reachable as refs/pull/<n>/head).
      if (b?.head !== undefined && !(typeof b.head === "string" && /^[0-9a-f]{40}$/.test(b.head))) throw new JobToolError(400, "bad-head", "head is a 40-character commit sha");
      return { repo: `${m[1]}/${m[2]}`, module: r!.module, ...(typeof b?.head === "string" ? { head: b.head } : {}) };
    },
    /**
     * One of this live job's prechecks, counted before its reviewer call: at most PRECHECKS a job. Returns its refund, for a
     * reviewer call that never reached a reviewer (none installed, or its module refused or couldn't be reached before it
     * took the request): that precheck cost nothing. At most PRECHECKS refunds a job, so the reviewer is never asked unbounded.
     */
    review(token: string): (failure: unknown) => void {
      const job = jobOf(token);
      const got = db.prepare("INSERT INTO jobtool_reviews (job, n) VALUES (?, 1) ON CONFLICT (job) DO UPDATE SET n = n + 1 WHERE n < ? RETURNING n").get(job, PRECHECKS);
      if (!got) throw new JobToolError(429, "precheck-limit", `this job has had its ${PRECHECKS} prechecks: publish, and the AI reviewer decides`);
      let refunded = false;
      return (failure) => { if (!refunded && NOT_REVIEWED.includes(String((failure as { type?: unknown })?.type))) (refunded = true, db.prepare("UPDATE jobtool_reviews SET n = n - 1, refunds = refunds + 1 WHERE job = ? AND n > 0 AND refunds < ?").run(job, PRECHECKS)); };
    },
    /** What the task's last ended job asked of its next turn, if anything (read in the admission transaction). */
    pending(task: string): NextTurn | undefined {
      const r = db.prepare(`SELECT t.job, t.fresh, t.engine, t.cleanup FROM jobtools t JOIN jobs j ON j.id = t.job
        WHERE j.task = ? AND j.state NOT IN ('admitted', 'running') ORDER BY t.at DESC LIMIT 1`).get(task) as { job: string; fresh: number; engine: string | null; cleanup: number } | undefined;
      return r && { job: r.job, fresh: r.fresh === 1, engine: r.engine ? JSON.parse(r.engine) : null, cleanup: r.cleanup === 1 };
    },
    /** The task's next turn has started: its ended jobs' requests are spent. */
    taken(task: string) {
      db.prepare("DELETE FROM jobtools WHERE job IN (SELECT id FROM jobs WHERE task = ? AND state NOT IN ('admitted', 'running'))").run(task);
    },
    /** Whether this job asked for its workspace to go when it ends. */
    cleanup: (job: string) => (db.prepare("SELECT cleanup FROM jobtools WHERE job = ?").get(job) as { cleanup: number } | undefined)?.cleanup === 1,
    refusal,
  };
}
export type JobTools = ReturnType<typeof createJobTools>;
