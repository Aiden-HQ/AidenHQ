// The wake inbox (one-way spec §4.2a): every reason to run an agent on a task is one durable row in kernel.db, written by
// one per-task scan. The reconcile poll scans every open task of the polled agents; a Paperclip event (the paperclip-events
// plugin, at most once and with duplicates) only scans its one task sooner. A dispatcher (role kernel.jobs) claims rows and
// turns them into jobs; admission binds `job` (unique, so a wake starts at most one job).
// Keys (never Paperclip's eventId): comment:<commentId>, issue:<issueId>:<updatedAt> (assigned or moved to todo),
// routine-run:<runId> (a routine run's new task, cause routine:<key>: the routine's compiled key, so admission applies its own
// model; routine tasks of a non-always_enqueue routine coalesce here), reopen:<issueId>:<statusVersion> (a comment reopened a finished task),
// wake_at:<module>.<id> (a module's scheduled wake, due at `until`).
// Polled agents: those the modules that claim wakes dispatch (compile's `dispatches`); a module joins on its first claim.
// So nothing is polled until a dispatcher claims, and an agent's first scan only wakes for comments after its dispatcher
// joined or the old executor's last word on the task, whichever is later (the handoff boundary).
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";
import type { Outcomes } from "./outcomes.ts";

/** A comment the kernel posted for a job (outcomes.ts): it never wakes anyone. */
export const SELF_TAG = /<!-- aidenhq:job=/;
// The old executor's own word on a task (the runner posts outcomes with the owner's key and this marker).
const OLD_EXECUTOR = /<!-- aidenhq-runner -->/;
const OPEN = "todo,in_progress,in_review";
const LIVE = "('admitted','running')";
/** A claimed row with no job comes back to its claimer after this (a dispatcher crash, a busy admission). */
export const LEASE_MS = 60_000;

const DDL = `CREATE TABLE IF NOT EXISTS wakes (key TEXT PRIMARY KEY, task TEXT NOT NULL, agent TEXT NOT NULL, cause TEXT NOT NULL,
  at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, job TEXT UNIQUE, until INTEGER);
CREATE INDEX IF NOT EXISTS wakes_task ON wakes (task, state);
CREATE TABLE IF NOT EXISTS wake_tasks (task TEXT PRIMARY KEY, agent TEXT, status TEXT, comment TEXT);
CREATE TABLE IF NOT EXISTS wake_dispatchers (module TEXT PRIMARY KEY, since INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS dispatch_since (agent TEXT PRIMARY KEY, at INTEGER NOT NULL);`;

export interface Wake { key: string; task: string; agent: string; cause: string; at: number; state: string; claimed_by: string | null; job: string | null; until: number | null }
type Issue = { id: string; status?: string; assigneeAgentId?: string | null; updatedAt?: string; createdAt?: string; statusVersion?: number; originKind?: string | null; originId?: string | null; companyId?: string };
type Comment = { id: string; body?: string; authorAgentId?: string | null; createdAt?: string; deletedAt?: string | null };
type Log = (msg: string, f?: Record<string, unknown>) => void;
const ms = (t?: string) => (t ? Date.parse(t) || 0 : 0);

export function createWakes({ db, owner, post, dispatches, routineKey = () => undefined, log = () => {}, now = Date.now }: {
  db: DatabaseSync;
  /** The control plane as the owner (only reads). */
  owner: Api;
  /** Writes as the task's agent (outcomes.ts): a coalesced routine task is cancelled by its own agent. */
  post: Outcomes["post"];
  /** Whether a module dispatches an agent (jobs.ts dispatchesFrom), and the agents it dispatches (ids). */
  dispatches: { may: (module: string, agent: string) => boolean; agents: (module: string) => string[] };
  /** A Paperclip routine's compiled key (grants `routine_keys`, setup): none for a routine setup didn't make. */
  routineKey?: (routine: string) => string | undefined;
  log?: Log; now?: () => number;
}) {
  db.exec(DDL);
  const q = (sql: string) => db.prepare(sql);
  const insert = (key: string, task: string, agent: string, cause: string, at: number, until: number | null = null) => {
    const r = q("INSERT OR IGNORE INTO wakes (key, task, agent, cause, at, until) VALUES (?, ?, ?, ?, ?, ?)").run(key, task, agent, cause, at, until);
    if (r.changes) log("wake", { key, task, cause });
  };
  /** The polled agents, each with when its dispatcher joined. */
  const polled = () => {
    const out = new Map<string, number>();
    for (const r of q("SELECT module, since FROM wake_dispatchers ORDER BY since").all() as { module: string; since: number }[]) for (const a of dispatches.agents(r.module)) if (!out.has(a)) out.set(a, r.since);
    return out;
  };
  /** When the inbox took an agent over (dispatch_since): kept from the first time it was polled. */
  const since = (agent: string, joined: number) => {
    q("INSERT OR IGNORE INTO dispatch_since (agent, at) VALUES (?, ?)").run(agent, joined);
    return (q("SELECT at FROM dispatch_since WHERE agent = ?").get(agent) as { at: number }).at;
  };
  const liveJob = (task: string) => q(`SELECT id, at FROM jobs WHERE task = ? AND state IN ${LIVE} ORDER BY at DESC LIMIT 1`).get(task) as { id: string; at: number } | undefined;
  const lastJob = (task: string) => q("SELECT id, at FROM jobs WHERE task = ? ORDER BY at DESC LIMIT 1").get(task) as { id: string; at: number } | undefined;

  /**
   * A routine run's new task. With agents' wakes off Paperclip never coalesces (spike gaps, C0): every tick, and every
   * catch-up tick after downtime, is a new task. So unless the routine always enqueues, a task arriving while an earlier
   * one of the same routine is open is cancelled here; otherwise its run is the wake. False: try again next poll.
   */
  async function routine(issue: Issue, agent: string, open: Issue[]) {
    const id = encodeURIComponent(String(issue.originId ?? ""));
    const [def, runs] = await Promise.all([owner("GET", `/api/routines/${id}`), owner("GET", `/api/routines/${id}/runs?limit=100`)]);
    const run = Array.isArray(runs.json) ? (runs.json as { id: string; linkedIssueId?: string }[]).find((x) => x.linkedIssueId === issue.id) : undefined;
    if (def.status !== 200 || !run) { log("wake: routine run not found yet", { task: issue.id, routine: issue.originId }); return false; }
    const earlier = open.find((o) => o.id !== issue.id && o.originKind === "routine_execution" && o.originId === issue.originId && (ms(o.createdAt) < ms(issue.createdAt) || (ms(o.createdAt) === ms(issue.createdAt) && o.id < issue.id)));
    if (def.json?.concurrencyPolicy !== "always_enqueue" && earlier) {
      await post({ id: issue.id, agent, task: issue.id }, { kind: "coalesced", status: "cancelled", body: "Cancelled: an earlier run of this routine is still open, so this one is folded into it." });
      log("wake: routine task coalesced", { task: issue.id, into: earlier.id, routine: issue.originId });
      return true;
    }
    const key = routineKey(String(issue.originId ?? ""));
    insert(`routine-run:${run.id}`, issue.id, agent, key ? `routine:${key}` : "routine", ms(issue.updatedAt) || now());
    return true;
  }

  /** One task's wakes: new comments past its cursor, and a move to todo (or a first sight of an unstarted todo task). */
  async function scan(issue: Issue, { reopened = false, open = [] as Issue[] } = {}) {
    const agent = issue.assigneeAgentId;
    const joined = agent ? polled().get(agent) : undefined;
    if (!agent || joined === undefined) return;
    const prev = q("SELECT agent, status, comment FROM wake_tasks WHERE task = ?").get(issue.id) as { agent: string; status: string; comment: string | null } | undefined;
    const path = `/api/issues/${encodeURIComponent(issue.id)}/comments?${prev?.comment ? `order=asc&limit=500&after=${encodeURIComponent(prev.comment)}` : "order=desc&limit=500"}`;
    const r = await owner("GET", path);
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`control plane GET comments → ${r.status}`);
    const all = (r.json as Comment[]).slice().sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
    // First sight: only what came after the dispatcher joined or the agent's (or old executor's) last word on the task.
    const boundary = prev ? 0 : Math.max(since(agent, joined), ...all.filter((c) => c.authorAgentId === agent || OLD_EXECUTOR.test(c.body ?? "") || SELF_TAG.test(c.body ?? "")).map((c) => ms(c.createdAt)));
    for (const c of all) {
      if (c.deletedAt || ms(c.createdAt) <= boundary || c.authorAgentId === agent || SELF_TAG.test(c.body ?? "")) continue;
      insert(`comment:${c.id}`, issue.id, agent, "comment", ms(c.createdAt) || now());
    }
    const status = String(issue.status ?? "");
    const moved = prev ? prev.status !== status || prev.agent !== agent : !lastJob(issue.id);
    if (status === "todo" && (reopened || moved) && !liveJob(issue.id)) {
      const at = ms(issue.updatedAt) || now();
      if (reopened) insert(`reopen:${issue.id}:${issue.statusVersion ?? issue.updatedAt}`, issue.id, agent, "reopen", at);
      else if (!prev && issue.originKind === "routine_execution") { if (!(await routine(issue, agent, open))) return; }
      else insert(`issue:${issue.id}:${issue.updatedAt}`, issue.id, agent, prev?.agent === agent ? "status" : "assigned", at);
    }
    const newest = prev?.comment && !all.length ? prev.comment : all.at(-1)?.id ?? null;
    q("INSERT INTO wake_tasks (task, agent, status, comment) VALUES (?, ?, ?, ?) ON CONFLICT(task) DO UPDATE SET agent = excluded.agent, status = excluded.status, comment = excluded.comment").run(issue.id, agent, status, newest);
  }

  const companies = new Map<string, string>();
  return {
    scan,
    /** The reconcile poll: every open task of every polled agent; and wakes whose jobs ended are done. */
    async poll() {
      q(`UPDATE wakes SET state = 'done' WHERE state = 'claimed' AND job IS NOT NULL AND job NOT IN (SELECT id FROM jobs WHERE state IN ${LIVE})`).run();
      for (const agent of polled().keys()) {
        try {
          if (!companies.has(agent)) {
            const a = await owner("GET", `/api/agents/${encodeURIComponent(agent)}`);
            if (a.status !== 200 || !a.json?.companyId) throw new Error(`control plane GET agent → ${a.status}`);
            companies.set(agent, String(a.json.companyId));
          }
          const l = await owner("GET", `/api/companies/${encodeURIComponent(companies.get(agent)!)}/issues?status=${OPEN}&limit=500&assigneeAgentId=${encodeURIComponent(agent)}`);
          if (l.status !== 200 || !Array.isArray(l.json)) throw new Error(`control plane GET issues → ${l.status}`);
          for (const issue of l.json as Issue[]) await scan(issue, { open: l.json }).catch((e: Error) => log("wake scan failed", { task: issue.id, err: e.message }));
        } catch (e) {
          log("wake poll failed", { agent, err: (e as Error).message });
        }
      }
    },
    /** A Paperclip event (ids only, untrusted): scan the task it names, as the poll would. */
    async event(b: { issueId?: unknown; reopened?: unknown }) {
      if (typeof b.issueId !== "string" || !/^[\w-]{1,100}$/.test(b.issueId)) return { scanned: false };
      const r = await owner("GET", `/api/issues/${encodeURIComponent(b.issueId)}`);
      if (r.status !== 200) return { scanned: false };
      await scan(r.json as Issue, { reopened: b.reopened === true });
      return { scanned: true };
    },
    /** A module's scheduled wake (role kernel.wake) for the task's assignee, due at `at`. */
    async schedule(module: string, b: { task?: unknown; agent?: unknown; at?: unknown; cause?: unknown; id?: unknown }) {
      const task = typeof b.task === "string" ? b.task.slice(0, 100) : "";
      const at = typeof b.at === "number" && Number.isFinite(b.at) ? b.at : now();
      const id = typeof b.id === "string" && /^[\w.-]{1,80}$/.test(b.id) ? b.id : randomBytes(8).toString("hex");
      if (!task) return { error: "send {task, agent?, at?, cause?, id?}" };
      const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}`);
      const issue = r.json as Issue;
      if (r.status !== 200 || !issue.assigneeAgentId) return { error: `no assigned task ${task}` };
      if (b.agent !== undefined && b.agent !== issue.assigneeAgentId) return { error: "the agent isn't the task's assignee" };
      const key = `wake_at:${module}.${id}`;
      insert(key, issue.id, issue.assigneeAgentId, typeof b.cause === "string" ? `scheduled: ${b.cause.slice(0, 200)}` : "scheduled", at, at);
      return { key };
    },
    /**
     * Rows for the module to run, claimed at once (one transaction) and leased for LEASE_MS. Per task: with a live job, its
     * comments newer than the job (to deliver as input, `live_job`) and nothing else; without one, one row that starts the
     * next job. Rows a job already covered (older than its start) are dropped, or done for comments.
     */
    claim(module: string, limit = 20): (Wake & { live_job?: string })[] {
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        q("INSERT OR IGNORE INTO wake_dispatchers (module, since) VALUES (?, ?)").run(module, t);
        const rows = (q("SELECT * FROM wakes WHERE ((state = 'open' AND (until IS NULL OR until <= ?)) OR (state = 'claimed' AND job IS NULL AND claimed_by = ? AND until <= ?)) ORDER BY at, key").all(t, module, t) as unknown as Wake[]).filter((w) => dispatches.may(module, w.agent));
        const set = (w: Wake, state: string, why: string) => { q("UPDATE wakes SET state = ?, until = NULL WHERE key = ?").run(state, w.key); log(`wake ${state}`, { key: w.key, why }); };
        const take = q("UPDATE wakes SET state = 'claimed', claimed_by = ?, until = ? WHERE key = ?");
        const out: (Wake & { live_job?: string })[] = [];
        const started = new Set<string>();
        for (const w of rows) {
          if (out.length >= limit) break;
          const live = liveJob(w.task);
          const comment = w.cause === "comment";
          if (live) {
            if (!comment) set(w, "dropped", `task has the live job ${live.id}`);
            else if (w.at < live.at) set(w, "done", `before the live job ${live.id} started`);
            else { take.run(module, t + LEASE_MS, w.key); out.push({ ...w, state: "claimed", claimed_by: module, until: t + LEASE_MS, live_job: live.id }); }
            continue;
          }
          const last = lastJob(w.task);
          if (last && w.at < last.at) { set(w, comment ? "done" : "dropped", `before the job ${last.id} started`); continue; }
          // One starter per task: a pending one (claimed, no job yet, still leased) or the first here.
          const pending = q("SELECT key FROM wakes WHERE task = ? AND state = 'claimed' AND job IS NULL AND until > ? AND key != ?").get(w.task, t, w.key) as { key: string } | undefined;
          if (started.has(w.task) || pending) { if (!comment) set(w, "dropped", "coalesced into the task's next job"); continue; }
          started.add(w.task);
          take.run(module, t + LEASE_MS, w.key);
          out.push({ ...w, state: "claimed", claimed_by: module, until: t + LEASE_MS });
        }
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    /** The claimer gives a row up for good. */
    drop(module: string, key: string, why: string) {
      const r = q("UPDATE wakes SET state = 'dropped', until = NULL WHERE key = ? AND state = 'claimed' AND claimed_by = ? AND job IS NULL").run(key, module);
      if (r.changes) log("wake dropped", { key, module, why: why.slice(0, 200) });
      return { dropped: r.changes > 0 };
    },
    /**
     * A note on a claimed wake's task that no job will answer (a redirect, a task with no request), posted as the task's agent
     * with the kernel's tag (SELF_TAG: it wakes nobody), once per wake. The task and agent are the wake's, never the caller's.
     */
    async note(module: string, key: string, body: unknown) {
      const w = q("SELECT task, agent FROM wakes WHERE key = ? AND state = 'claimed' AND claimed_by = ? AND job IS NULL").get(key, module) as { task: string; agent: string } | undefined;
      if (!w) return { status: 409, error: `wake ${key} isn't one this module claimed, or a job already answers it` };
      if (typeof body !== "string" || !body.trim()) return { status: 400, error: "send {body}" };
      const id = `w-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
      return post({ id, agent: w.agent, task: w.task }, { kind: "note", body: body.slice(0, 20_000) });
    },
    /** A claimed comment delivered into its live job (the input's ack). */
    delivered(module: string, key: string) {
      return q("UPDATE wakes SET state = 'delivered', until = NULL WHERE key = ? AND state = 'claimed' AND claimed_by = ?").run(key, module).changes > 0;
    },
    get: (key: string) => q("SELECT * FROM wakes WHERE key = ?").get(key) as unknown as Wake | undefined,
  };
}
export type Wakes = ReturnType<typeof createWakes>;
