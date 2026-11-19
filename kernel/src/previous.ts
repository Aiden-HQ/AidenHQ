// The kernels this one may share rows with (main.ts afterPrevious): back-to-back restarts leave several draining at once, so
// every live earlier pid is kept (kernel.db kernel_pids), not only the latest, and an exited one is pruned.
import type { DatabaseSync } from "node:sqlite";

export const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

/** Records `self` and returns the earlier kernels' pids that are still alive. */
export function recordKernel(db: DatabaseSync, self: number, alive: (pid: number) => boolean = pidAlive): number[] {
  db.exec("CREATE TABLE IF NOT EXISTS kernel_pids (pid INTEGER PRIMARY KEY)");
  // The restart that deploys this keeps the one pid the old table held (the kernel now draining).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'kernel_pid'").get()) db.exec("INSERT OR IGNORE INTO kernel_pids SELECT pid FROM kernel_pid; DROP TABLE kernel_pid");
  const live: number[] = [];
  for (const { pid } of db.prepare("SELECT pid FROM kernel_pids").all() as { pid: number }[]) {
    if (pid === self) continue;
    if (alive(pid)) live.push(pid); else db.prepare("DELETE FROM kernel_pids WHERE pid = ?").run(pid);
  }
  db.prepare("INSERT OR IGNORE INTO kernel_pids (pid) VALUES (?)").run(self);
  return live;
}
