// Immutable provenance (spec §4.2a, §6 "caps follow kernel provenance"): every task a kernel job creates gets a kernel row
// naming the job and the routine cap it carried, so the cap of whatever runs on that task never depends on a control-plane
// field. A job creates tasks only through the paperclip-events plugin's signed `post` action (cp.ts, outcomes.ts), which
// gives each new task this plugin's origin kind (ORIGIN) and the write's tag as its origin id. Before the call the kernel
// records the cap under that origin id (`intend`); the plugin's answer, or the first read of a task carrying that origin
// (`trace`, `settled`), turns it into the task's row, once. A plugin-made task with no intent behind it (the kernel never
// asked for it) is capped "off" and never admitted.
import type { DatabaseSync } from "node:sqlite";
import { AUTONOMY, type Autonomy, type RoutineCap } from "./tier.ts";

import { ORIGIN } from "../../services/paperclip-events/post.js";
/** The origin kind every task the kernel's plugin creates carries (post.js sets it; only that plugin may). */
export { ORIGIN };
type Issue = { id: string; originKind?: string | null; originId?: string | null };
const strictest = (a: RoutineCap | undefined, b: RoutineCap | undefined) => (!a ? b : !b ? a : AUTONOMY.indexOf(b.cap) < AUTONOMY.indexOf(a.cap) ? b : a);

export function createProvenance({ db, cap }: {
  db: DatabaseSync;
  /** A task's routine cap as the kernel traces it now (tier.ts taskRoutineCap, through this provenance); throws (503) when it can't be read now. */
  cap: (task: string) => Promise<RoutineCap | undefined>;
}) {
  db.exec(`CREATE TABLE IF NOT EXISTS provenance (task TEXT PRIMARY KEY, created_by_job TEXT, routine TEXT, routine_cap TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS provenance_ops (origin TEXT PRIMARY KEY, created_by_job TEXT, routine TEXT, routine_cap TEXT NOT NULL, at INTEGER NOT NULL)`);
  const of = (task: string) => db.prepare("SELECT routine, routine_cap FROM provenance WHERE task = ?").get(task) as { routine: string | null; routine_cap: string } | undefined;
  /** The intent under `origin` becomes `task`'s row, once (a task that has one keeps it). */
  function record(task: string, origin: string) {
    // A savepoint: admission reads (and so completes) inside its own transaction.
    db.exec("SAVEPOINT provenance_record");
    try {
      db.prepare("INSERT OR IGNORE INTO provenance (task, created_by_job, routine, routine_cap, at) SELECT ?, created_by_job, routine, routine_cap, ? FROM provenance_ops WHERE origin = ?").run(task, Date.now(), origin);
      db.prepare("DELETE FROM provenance_ops WHERE origin = ?").run(origin);
      db.exec("RELEASE provenance_record");
    } catch (e) { db.exec("ROLLBACK TO provenance_record"); db.exec("RELEASE provenance_record"); throw e; }
  }
  /** The task's row, completing a plugin-made task's intent from its origin id the first time it is read. */
  const row = (i: Issue) => {
    if (!of(i.id) && i.originKind === ORIGIN && i.originId) record(i.id, i.originId);
    return of(i.id);
  };
  return {
    /** A task's provenance as the routine trace reads it (tier.ts origins): its row's cap, "off" for a plugin-made task with no intent, else nothing. */
    trace(issue: Issue): RoutineCap | undefined {
      const r = row(issue);
      if (r) return { cap: r.routine_cap as Autonomy, ...(r.routine ? { routine: r.routine } : {}) };
      return issue.originKind === ORIGIN ? { cap: "off" } : undefined;
    },
    /** Admission's check: a plugin-made task runs only with its row (fail closed). */
    settled: (issue: Issue) => issue.originKind !== ORIGIN || Boolean(row(issue)),
    /**
     * What a task a job creates carries: the strictest of the cap its admission froze and its task's trace now. The job by
     * its id, or the running job of `agent` on `task`; none is "off".
     */
    async carried({ job: id, agent, task }: { job?: string; agent: string; task: string }): Promise<{ job: string | null; cap: RoutineCap }> {
      const job = (id ? db.prepare("SELECT id, routine, routine_cap FROM jobs WHERE id = ? AND agent = ?").get(id, agent) : db.prepare("SELECT id, routine, routine_cap FROM jobs WHERE task = ? AND agent = ? AND state = 'running'").get(task, agent)) as { id: string; routine: string | null; routine_cap: string | null } | undefined;
      if (!job) return { job: null, cap: { cap: "off" } };
      const frozen = job.routine_cap ? { cap: (AUTONOMY.includes(job.routine_cap as Autonomy) ? job.routine_cap : "off") as Autonomy, ...(job.routine ? { routine: job.routine } : {}) } : undefined;
      return { job: job.id, cap: strictest(frozen, await cap(task)) ?? { cap: "full" } };
    },
    /** Who filed a task: undefined when no job did (the owner, a routine, a kernel filer), else the filing job's agent ("" if its job is gone). */
    filedBy(issue: Issue): string | undefined {
      row(issue);
      const job = (db.prepare("SELECT created_by_job FROM provenance WHERE task = ?").get(issue.id) as { created_by_job: string | null } | undefined)?.created_by_job;
      if (!job) return undefined;
      return (db.prepare("SELECT agent FROM jobs WHERE id = ?").get(job) as { agent: string } | undefined)?.agent ?? "";
    },
    /** Before the create: the cap under the write's origin id (its tag), so the task never exists without it. */
    intend(origin: string, c: { job: string | null; cap: RoutineCap }) {
      db.prepare("INSERT OR IGNORE INTO provenance_ops (origin, created_by_job, routine, routine_cap, at) VALUES (?, ?, ?, ?, ?)").run(origin, c.job, c.cap.routine ?? null, c.cap.cap, Date.now());
    },
    /** The plugin's answer: the created task's row. */
    record,
  };
}
export type Provenance = ReturnType<typeof createProvenance>;
