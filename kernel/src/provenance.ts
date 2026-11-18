// Immutable provenance (spec §4.2a, §6 "caps follow kernel provenance"): every task a kernel job creates gets a kernel row
// naming the job and the routine cap it carried, so the cap of whatever runs on that task never depends on a control-plane
// field. A job creates tasks only through the paperclip-events plugin's signed `post` action (cp.ts, outcomes.ts), which
// answers the new task's id, so the row is written at creation, once, and never changes. The plugin's tasks carry its origin
// (ORIGIN): one with no row (an answer lost between the plugin's write and the row) is capped "off" for good, never uncapped.
import type { DatabaseSync } from "node:sqlite";
import { AUTONOMY, type Autonomy, type RoutineCap } from "./tier.ts";

/** The origin Paperclip gives every task the kernel's plugin creates (`plugin:<plugin id>`). */
export const ORIGIN = "plugin:aidenhq.events";
type Issue = { id: string; originKind?: string | null };
const strictest = (a: RoutineCap | undefined, b: RoutineCap | undefined) => (!a ? b : !b ? a : AUTONOMY.indexOf(b.cap) < AUTONOMY.indexOf(a.cap) ? b : a);

export function createProvenance({ db, cap }: {
  db: DatabaseSync;
  /** A task's routine cap as the kernel traces it now (tier.ts taskRoutineCap, through this provenance); never throws. */
  cap: (task: string) => Promise<RoutineCap | undefined>;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS provenance (task TEXT PRIMARY KEY, created_by_job TEXT, routine TEXT, routine_cap TEXT NOT NULL, at INTEGER NOT NULL)");
  const of = (task: string) => db.prepare("SELECT routine, routine_cap FROM provenance WHERE task = ?").get(task) as { routine: string | null; routine_cap: string } | undefined;
  return {
    /** A task's provenance as the routine trace reads it (tier.ts origins): its row's cap, "off" for a plugin-made task with no row, else nothing. */
    trace(issue: Issue): RoutineCap | undefined {
      const r = of(issue.id);
      if (r) return { cap: r.routine_cap as Autonomy, ...(r.routine ? { routine: r.routine } : {}) };
      return String(issue.originKind ?? "") === ORIGIN ? { cap: "off" } : undefined;
    },
    /**
     * What a task the job (agent on task) creates carries: the strictest of the cap its admission froze and its task's trace
     * now; no running job for them is "off". Read before the create, written with `record` once the plugin answers.
     */
    async carried(agent: string, task: string): Promise<{ job: string | null; cap: RoutineCap }> {
      const job = db.prepare("SELECT id, routine, routine_cap FROM jobs WHERE task = ? AND agent = ? AND state = 'running'").get(task, agent) as { id: string; routine: string | null; routine_cap: string | null } | undefined;
      if (!job) return { job: null, cap: { cap: "off" } };
      const frozen = job.routine_cap ? { cap: (AUTONOMY.includes(job.routine_cap as Autonomy) ? job.routine_cap : "off") as Autonomy, ...(job.routine ? { routine: job.routine } : {}) } : undefined;
      return { job: job.id, cap: strictest(frozen, await cap(task)) ?? { cap: "full" } };
    },
    /** The created task's row, once: a task that already has one keeps it. */
    record(task: string, c: { job: string | null; cap: RoutineCap }) {
      db.prepare("INSERT OR IGNORE INTO provenance (task, created_by_job, routine, routine_cap, at) VALUES (?, ?, ?, ?, ?)").run(task, c.job, c.cap.routine ?? null, c.cap.cap, Date.now());
    },
  };
}
export type Provenance = ReturnType<typeof createProvenance>;
