// A quiet routine run (spec §4): a routine's job that ended done having only closed or parked its own task: every record it filed
// is a task_finish or task_wait call, and it created no task. Recorded in its job.ended fact (jobs.ts), and the board's Activity
// tab leaves it out, so a routine that found nothing to do doesn't fill the agent's timeline.
import type { DatabaseSync } from "node:sqlite";

const CLOSING = ["task_finish", "task_wait"];

/** Whether a job is a quiet routine run. `requester`: its agent's id; `at`: its start (ms). */
export function quietRun(db: DatabaseSync, job: { id: string; task: string; at: number; routine?: string | null; state: string; requester: string }): boolean {
  if (!job.routine || job.state !== "done") return false;
  const since = new Date(job.at).toISOString();
  const filed = db.prepare("SELECT kind, args FROM records WHERE json_extract(requester, '$.agent') = ? AND created_at >= ?").all(job.requester, since) as { kind: string; args: string }[];
  const closing = filed.every((r) => {
    if (r.kind !== "conn.tool") return false;
    const a = JSON.parse(r.args) as { connection?: string; tool?: string };
    return a.connection === "paperclip_tasks" && CLOSING.includes(String(a.tool));
  });
  // A task it created under its own (a delegation) is a task.created fact naming it as parent.
  const created = db.prepare("SELECT 1 FROM facts WHERE type = 'task.created' AND at >= ? AND json_extract(data, '$.parent') = ? LIMIT 1").get(since, job.task);
  return closing && !created;
}
