// The watches table (/data/sessions.db): one row per watch a session armed on its own task, and the event log's committed cursor.
// A watch belongs to its task: only that task's caller lists or cancels it (tools.ts).
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type WatchState = "armed" | "fired" | "cancelled";
/** What an event must carry for the watch to fire: the PR's number, and (when set) whether it merged. */
export type Match = { number: number; merged?: boolean };
export type Watch = { id: string; task: string; agent: string; connection: string; kind: string; resource: string; match: Match; note: string; state: WatchState; fired_by: string | null; at: number; notice: string | null; sent: number };
type Row = Omit<Watch, "match"> & { match: string };

export function openWatches(file: string, now: () => number = Date.now) {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY, task TEXT NOT NULL, agent TEXT NOT NULL, connection TEXT NOT NULL, kind TEXT NOT NULL, resource TEXT NOT NULL, match TEXT NOT NULL, note TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('armed','fired','cancelled')), fired_by TEXT, at INTEGER NOT NULL, recheck INTEGER NOT NULL DEFAULT 0, notice TEXT, sent INTEGER NOT NULL DEFAULT 0)`);
  db.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  const watch = (r: Row | undefined): Watch | undefined => (r ? { ...r, match: JSON.parse(r.match) } : undefined);
  const all = (sql: string, ...args: (string | number)[]) => (db.prepare(sql).all(...args) as Row[]).map((r) => watch(r)!);
  return {
    arm(w: Omit<Watch, "state" | "fired_by" | "at" | "notice" | "sent">): Watch {
      db.prepare("INSERT INTO watches (id, task, agent, connection, kind, resource, match, note, state, fired_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'armed', NULL, ?)")
        .run(w.id, w.task, w.agent, w.connection, w.kind, w.resource, JSON.stringify(w.match), w.note, now());
      return this.get(w.id)!;
    },
    get: (id: string) => watch(db.prepare("SELECT * FROM watches WHERE id = ?").get(id) as Row | undefined),
    /** The task's watches, newest last. */
    list: (task: string) => all("SELECT * FROM watches WHERE task = ? ORDER BY at, rowid", task),
    armed: () => all("SELECT * FROM watches WHERE state = 'armed' ORDER BY at, rowid"),
    /**
     * Takes the watch for firing (armed -> fired, with the notice to send), once: false when another path fired it or it was
     * cancelled meanwhile. The notice is sent after, and `sent` marks it delivered; `unsent` are the ones a crash or a refusal left.
     */
    claim(id: string, by: string, notice: string): boolean { return Number(db.prepare("UPDATE watches SET state = 'fired', fired_by = ?, notice = ? WHERE id = ? AND state = 'armed'").run(by, notice, id).changes) === 1; },
    sent(id: string) { db.prepare("UPDATE watches SET sent = 1 WHERE id = ?").run(id); },
    unsent: () => all("SELECT * FROM watches WHERE state = 'fired' AND sent = 0 ORDER BY at, rowid"),
    cancel(id: string) { db.prepare("UPDATE watches SET state = 'cancelled' WHERE id = ? AND state = 'armed'").run(id); },
    /** Armed watches (of one repo, when given) that must be checked against the live state: service start, a gap, a repo's resync. */
    markCheck(repo?: string) { db.prepare(`UPDATE watches SET recheck = 1 WHERE state = 'armed'${repo === undefined ? "" : " AND resource = ?"}`).run(...(repo === undefined ? [] : [repo])); },
    toCheck: () => all("SELECT * FROM watches WHERE state = 'armed' AND recheck = 1 ORDER BY at, rowid"),
    checked(id: string) { db.prepare("UPDATE watches SET recheck = 0 WHERE id = ?").run(id); },
    cancelTask(task: string) { db.prepare("UPDATE watches SET state = 'cancelled' WHERE task = ? AND state = 'armed'").run(task); },
    remove(id: string) { db.prepare("DELETE FROM watches WHERE id = ?").run(id); },
    cursor: () => { const v = (db.prepare("SELECT v FROM meta WHERE k = 'cursor'").get() as { v: string } | undefined)?.v; return v === undefined ? undefined : Number(v); },
    setCursor(n: number) { db.prepare("INSERT INTO meta (k, v) VALUES ('cursor', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(String(n)); },
  };
}
export type Watches = ReturnType<typeof openWatches>;
