// A closed task's workspace goes (W11 of phase 2; the runner's removeClosedWorkspaces): a kernel job's workspace is
// <workDir>/tasks/<identifier> (boxes.ts), kept between the task's runs. Once the task has been done or cancelled for
// CLOSED_DAYS, with no live job, it is removed, as `aidenhq cleanup` would. What was published is in its repository already;
// what wasn't is gone with the task. Never a comment: one would reopen the closed task.
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";

export const CLOSED_DAYS = 3;
const ID = /^[\w.-]{1,100}$/;

export function createWorkspaceSweep({ db, owner, workDir, log = () => {}, now = Date.now }: {
  db: DatabaseSync; owner: Api; workDir: string; log?: (msg: string, f?: Record<string, unknown>) => void; now?: () => number;
}) {
  // A task swept after its last job (`at`: that job's start): a later job on a reopened task makes it a candidate again.
  db.exec("CREATE TABLE IF NOT EXISTS swept (task TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  /** One pass, at most `budgetMs` long: each task a job ran on since it was last swept, with no live job. */
  return async function sweep(budgetMs = 5 * 60_000) {
    const until = now() + budgetMs;
    const tasks = db.prepare(`SELECT j.task, MAX(j.at) AS last FROM jobs j LEFT JOIN swept s ON s.task = j.task GROUP BY j.task
      HAVING last > COALESCE(MAX(s.at), 0) AND SUM(j.state IN ('admitted', 'running')) = 0`).all() as { task: string; last: number }[];
    for (const { task, last } of tasks) {
      if (now() > until) break;
      const r = await owner("GET", `/api/issues/${encodeURIComponent(task)}`).catch(() => undefined);
      if (!r || r.status !== 200) continue;
      const i = r.json as { identifier?: string; status?: string; updatedAt?: string };
      if (!["done", "cancelled"].includes(String(i.status)) || !(Date.parse(String(i.updatedAt)) < now() - CLOSED_DAYS * 86_400_000)) continue;
      const dir = join(workDir, "tasks", String(i.identifier));
      if (ID.test(String(i.identifier)) && existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
        log("closed task's workspace removed", { task: i.identifier });
      }
      db.prepare("INSERT INTO swept (task, at) VALUES (?, ?) ON CONFLICT DO UPDATE SET at = excluded.at").run(task, last);
    }
  };
}
