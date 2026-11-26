// The kernel's notices on tasks (a write's Done, Failed, Stale or Rejected: writes.ts onTask.notify), durable. A notice is the
// comment that wakes the agent waiting on it, so it is queued in kernel.db and sent from there: removed once the control plane
// took it, tried again with backoff while it can't (a 5xx, a timeout), dropped and told to the owner when it never will (a 4xx,
// or a day of tries). Each is posted once: it carries its own tag, and a notice whose post was tried before (a crash or a lost
// answer after the control plane took it) is looked for on the task before it is posted again. One sender at a time: one send
// loop in this process (a call while it runs makes it go round once more; the drain waits for it, `inflight`), and a row is
// leased before its send, so a draining kernel and its successor never both post it. A task's notices go in the order they were
// queued: one not yet posted holds the later ones back. A task that is done or cancelled by then gets nothing (a comment would
// reopen it); a notice for the task's parent (`parent`) goes to the parent the task has when it is sent. A notice with `close`
// closes its task in the same write (status and comment in one PATCH), so the outcome and the close are one delivery.
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";
import { requestedParentOf } from "../../services/shared/requested-parent.ts";

export type NoticeOpts = { parent?: boolean; close?: "done" | "cancelled"; /** Distinguishes two notices with the same text (a wait's reason), so neither shadows the other; never shown. */ tag?: string };
const LEASE_MS = 2 * 60_000;
const MAX_MS = 30 * 60_000;
const GIVE_UP_MS = 24 * 3600_000;
const CLOSED = ["done", "cancelled"];

type Row = { key: string; task: string; body: string; parent: number; at: number; tries: number; next: number; nonce: string | null; close: string | null };

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
  const cols = (db.prepare("PRAGMA table_info(task_notices)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("nonce")) db.exec("ALTER TABLE task_notices ADD COLUMN nonce TEXT");
  if (!cols.includes("close")) db.exec("ALTER TABLE task_notices ADD COLUMN close TEXT");
  // A notice's tag: a random nonce, set before its first post, so nobody else can write a comment that passes for it.
  const tagOf = (nonce: string) => `<!-- aidenhq-kernel-notice:${nonce} -->`;
  const permanent = (status: number, what: string) => Object.assign(new Error(`${what}: the control plane answered ${status}`), { permanent: true });

  /** One notice: posted where it belongs, or nothing when that task is gone or closed. Throws to be tried again. */
  async function deliver(r: Row) {
    let task = r.task;
    const read = async (id: string) => {
      const i = await api("GET", `/api/issues/${encodeURIComponent(id)}`);
      if (i.status === 404) return undefined;
      if (i.status !== 200) throw new Error(`reading task ${id}: ${i.status}`);
      return i.json as { id?: string; status?: string; parentId?: string | null; description?: string | null };
    };
    if (r.parent) {
      // The task's delegator: the task that asked for it, which is its parent unless the control plane placed it elsewhere
      // (requestedParentOf). The queue holds the task, so this is read when the notice is sent, as the parent was.
      const self = await read(task);
      const asked = requestedParentOf(self);
      if (!asked) return;
      // A closed task takes no comment (it would reopen it). The requester hears it while open; a closed or gone requester
      // falls back to the task the control plane placed this one under, which heard every parent notice before this change.
      const open = async (id: string | undefined) => {
        if (!id || id === task) return undefined;
        const i = await read(id);
        return i && !CLOSED.includes(String(i.status)) ? id : undefined;
      };
      const to = (await open(asked)) ?? (self?.parentId && self.parentId !== asked ? await open(self.parentId) : undefined);
      if (!to) {
        // Nobody open is left to hear something the task's agent needs: say it where a person will, never lose it silently.
        alert(`A notice for task ${task} has no open requester (${asked}) to go to:\n\n${r.body.slice(0, 1500)}`);
        return;
      }
      task = to;
    }
    const i = await read(task);
    if (!i || CLOSED.includes(String(i.status))) return;
    // Tried before (a crash, or an answer lost after the control plane took it): posted already if a comment the kernel wrote
    // (a user's, not an agent's) ends with its tag.
    if (r.nonce) {
      const l = await api("GET", `/api/issues/${encodeURIComponent(task)}/comments?order=desc&limit=100`);
      if (l.status !== 200 || !Array.isArray(l.json)) throw new Error(`reading the comments on ${task}: ${l.status}`);
      if (l.json.some((c: { body?: unknown; authorAgentId?: unknown }) => !c.authorAgentId && typeof c.body === "string" && c.body.trimEnd().endsWith(tagOf(r.nonce!)))) return;
    }
    const nonce = r.nonce ?? randomBytes(16).toString("hex");
    db.prepare("UPDATE task_notices SET nonce = ? WHERE key = ?").run(nonce, r.key);
    const tag = tagOf(nonce);
    const c = r.close ? await api("PATCH", `/api/issues/${encodeURIComponent(task)}`, { status: r.close, comment: `${r.body}\n\n${tag}` }) : await api("POST", `/api/issues/${encodeURIComponent(task)}/comments`, { body: `${r.body}\n\n${tag}` });
    if (c.status === 404) return;
    if (c.status >= 400 && c.status < 500 && c.status !== 429) throw permanent(c.status, `posting on ${task}`);
    if (c.status >= 300) throw new Error(`posting on ${task}: ${c.status}`);
  }

  /** One pass over the queue, oldest first; a task with a notice not posted yet (leased, backing off, failed now) waits. */
  async function pass() {
    const rows = db.prepare("SELECT * FROM task_notices ORDER BY at, rowid").all() as Row[];
    const held = new Set<string>();
    for (const r of rows) {
      if (held.has(r.task) || r.next > now() || db.prepare("UPDATE task_notices SET next = ? WHERE key = ? AND next <= ?").run(now() + LEASE_MS, r.key, now()).changes !== 1) { held.add(r.task); continue; }
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
          held.add(r.task);
          db.prepare("UPDATE task_notices SET tries = tries + 1, next = ? WHERE key = ?").run(now() + Math.min(MAX_MS, 30_000 * 2 ** r.tries), r.key);
          log("task notice not posted yet", { task: r.task, tries: r.tries + 1, err });
        }
      }
    }
  }
  let running: Promise<void> | undefined, again = false;

  return {
    /** Queues a notice; the same text for the same task is one notice (unless a `tag` says it is a different one). */
    queue(task: string, body: string, o: NoticeOpts = {}) {
      // An untagged notice's key is exactly what it was before tags existed, so one queued by an older kernel and re-queued by
      // this one is still the same notice (not posted twice).
      const id = o.tag === undefined ? [task, body, Boolean(o.parent)] : [task, body, Boolean(o.parent), o.tag];
      const key = createHash("sha256").update(JSON.stringify(id)).digest("hex").slice(0, 32);
      db.prepare("INSERT OR IGNORE INTO task_notices (key, task, body, parent, at, next, close) VALUES (?, ?, ?, ?, ?, 0, ?)").run(key, task, body, o.parent ? 1 : 0, now(), o.close ?? null);
    },
    /** Sends every notice that is due (main.ts, every few seconds, and once a notice is queued): one loop at a time. */
    send(): Promise<void> {
      if (running) { again = true; return running; }
      running = (async () => { do { again = false; await pass(); } while (again); })().finally(() => { running = undefined; });
      return running;
    },
    /** A send loop is running (a draining kernel waits for it). */
    inflight: () => running !== undefined,
  };
}
export type Notices = ReturnType<typeof createNotices>;
