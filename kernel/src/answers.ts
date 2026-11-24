// An owner's answer to an open question is claimed once per wait before it is posted: the board and Telegram both ask here, so
// two taps (or a tap on a question the agent has since replaced) post exactly one comment on the question's own wait. The claim
// holds only while the task's open owner wait is the one that started at `waitSince`; a claimant whose post fails releases it.
// A claim whose wait is still open after LEASE_MS never produced an answer (an answer ends the wait), so it can be taken again.
import type { DatabaseSync } from "node:sqlite";
import type { TaskStateRead } from "./task-state-read.ts";

const LEASE_MS = 60_000;

export function createAnswers({ db, states, now = () => Date.now() }: { db: DatabaseSync; states: Pick<TaskStateRead, "read">; now?: () => number }) {
  db.exec("CREATE TABLE IF NOT EXISTS answer_claims (key TEXT PRIMARY KEY, by TEXT NOT NULL, at INTEGER NOT NULL)");
  /** The task's row and its claim key, or undefined when no owner wait that started at `waitSince` is open. */
  const open = (task: string, waitSince: string) => {
    const s = states.read({ ids: [task] }).tasks[0];
    return s && s.wait_since === waitSince && s.attention.some((a) => a.who === "owner" && a.why === "owner_wait") ? `answer:${s.task ?? task}:${waitSince}` : undefined;
  };
  return {
    claim(task: string, waitSince: string, by: string): "ok" | "stale" | "taken" {
      const key = open(task, waitSince);
      if (!key) return "stale";
      const t = now();
      db.prepare("DELETE FROM answer_claims WHERE key = ? AND at < ?").run(key, t - LEASE_MS);
      return db.prepare("INSERT OR IGNORE INTO answer_claims (key, by, at) VALUES (?, ?, ?)").run(key, by, t).changes ? "ok" : "taken";
    },
    release(task: string, waitSince: string, by: string): void {
      const s = states.read({ ids: [task] }).tasks[0];
      db.prepare("DELETE FROM answer_claims WHERE key = ? AND by = ?").run(`answer:${s?.task ?? task}:${waitSince}`, by);
    },
  };
}
export type Answers = ReturnType<typeof createAnswers>;
