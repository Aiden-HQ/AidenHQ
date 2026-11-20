// An admitted job as admission.ts records it (agent-1 on task-1, PEN-1, for acme-dispatch; its engine frozen on the row), started
// in `box` by jobs.runAdmitted as boxes.ts starts one.
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export function admitAndRun(db, jobs, cfg, box, kind = "echo") {
  const id = `j-${randomBytes(8).toString("hex")}`;
  db.prepare("INSERT INTO jobs (id, module, agent, task, engine, pid, log, dir, at, jobcaps, observing, live_input, state, authority, identifier) VALUES (?, 'acme-dispatch', 'agent-1', 'task-1', ?, 0, '', '', ?, '[]', 0, 0, 'admitted', ?, 'PEN-1')")
    .run(id, kind, Date.now(), JSON.stringify({ engine: kind, model: "", effort: "", web: true }));
  return jobs.runAdmitted(id, { box, worktree: join(cfg.workDir, "tasks", "PEN-1"), prompt: "hello there", label: "PEN-1" });
}
