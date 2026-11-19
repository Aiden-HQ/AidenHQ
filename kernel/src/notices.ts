// The kernel's notices on tasks (a write's Done, Failed, Stale or Rejected: writes.ts onTask.notify), durable. A notice is the
// comment that wakes the agent waiting on it, so it is queued in kernel.db and sent from there: removed once the control plane
// took it, tried again with backoff while it can't (a 5xx, a timeout), dropped and told to the owner when it never will (a 4xx,
// or a day of tries). One sender at a time: a row is leased before its send, so a draining kernel and its successor never both
// post it. A task that is done or cancelled by then gets nothing (a comment would reopen it); a notice for the task's parent
// (`parent`) goes to the parent the task has when it is sent.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";

export type NoticeOpts = { parent?: boolean };
const LEASE_MS = 2 * 60_000;
const MAX_MS = 30 * 60_000;
const GIVE_UP_MS = 24 * 3600_000;
const CLOSED = ["done", "cancelled"];

export function createNotices({ db, api, alert, log = () => {}, now = Date.now }: {
  db: DatabaseSync;
  /** The control plane as the owner (the board key: notices are the kernel's, as the board's approval notices are). */
  api: Api;
  /** A notice that can never be posted: the owner hears of it. */
  alert: (text: string) => void;
  log?: (msg: string, f?: Record<string, unknown>) => void;
  now?: () => number;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS task_notices (key TEXT PRIMARY KEY, task TEXT NOT NULL, body TEXT NOT NULL, parent INTEGER NOT NULL, at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next INTEGER NOT NULL)");
  const permanent = (status: number, what: string) => Object.assign(new Error(`${what}: the control plane answered ${status}`), { permanent: true });

  /** One notice: posted where it belongs, or nothing when that task is gone or closed. Throws to be tried again. */
  async function deliver(r: { task: string; body: string; parent: number }) {
    let task = r.task;
    const read = async (id: string) => {
      const i = await api("GET", `/api/issues/${encodeURIComponent(id)}`);
      if (i.status === 404) return undefined;
      if (i.status !== 200) throw new Error(`reading task ${id}: ${i.status}`);
      return i.json as { status?: string; parentId?: string | null };
    };
    if (r.parent) {
      const parent = (await read(task))?.parentId;
      if (!parent) return;
      task = parent;
    }
    const i = await read(task);
    if (!i || CLOSED.includes(String(i.status))) return;
    const c = await api("POST", `/api/issues/${encodeURIComponent(task)}/comments`, { body: r.body });
    if (c.status === 404) return;
    if (c.status >= 400 && c.status < 500 && c.status !== 429) throw permanent(c.status, `posting on ${task}`);
    if (c.status >= 300) throw new Error(`posting on ${task}: ${c.status}`);
  }

  return {
    /** Queues a notice; the same text for the same task is one notice. */
    queue(task: string, body: string, o: NoticeOpts = {}) {
      const key = createHash("sha256").update(JSON.stringify([task, body, Boolean(o.parent)])).digest("hex").slice(0, 32);
      db.prepare("INSERT OR IGNORE INTO task_notices (key, task, body, parent, at, next) VALUES (?, ?, ?, ?, ?, 0)").run(key, task, body, o.parent ? 1 : 0, now());
    },
    /** Sends every notice that is due (main.ts, every few seconds, and once a notice is queued). */
    async send(): Promise<void> {
      const due = db.prepare("SELECT * FROM task_notices WHERE next <= ? ORDER BY at").all(now()) as { key: string; task: string; body: string; parent: number; at: number; tries: number }[];
      for (const r of due) {
        if (db.prepare("UPDATE task_notices SET next = ? WHERE key = ? AND next <= ?").run(now() + LEASE_MS, r.key, now()).changes !== 1) continue;
        try {
          await deliver(r);
          db.prepare("DELETE FROM task_notices WHERE key = ?").run(r.key);
        } catch (e) {
          const err = String((e as Error).message).slice(0, 300);
          if ((e as { permanent?: boolean }).permanent || now() - r.at > GIVE_UP_MS) {
            db.prepare("DELETE FROM task_notices WHERE key = ?").run(r.key);
            log("task notice dropped", { task: r.task, err });
            alert(`A notice for task ${r.task} couldn't be posted (${err}), so the agent waiting on it wasn't woken:\n\n${r.body.slice(0, 1500)}`);
          } else {
            db.prepare("UPDATE task_notices SET tries = tries + 1, next = ? WHERE key = ?").run(now() + Math.min(MAX_MS, 30_000 * 2 ** r.tries), r.key);
            log("task notice not posted yet", { task: r.task, tries: r.tries + 1, err });
          }
        }
      }
    },
  };
}
export type Notices = ReturnType<typeof createNotices>;
