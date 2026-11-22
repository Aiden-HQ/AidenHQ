// The router's own state: key-values (dedupe stamps, attention counts, the digest queue) and the messages waiting for a
// channel to come back.
import Database from "better-sqlite3";

export const TOLD_MAX = 1500;
/** Whitespace collapsed to one line, cut to `max` characters by code point (never mid-character). */
export const clip = (t: string, max: number): string => Array.from(t.replace(/\s+/g, " ").trim()).slice(0, max).join("");

/** One ledger entry: `source` is the sending agent's key, or "kernel" for a notice with no agent. */
export type Told = { source: string; task?: string | undefined; kind: string; text: string };
export type ToldRow = Required<Omit<Told, "task">> & { id: number; at: number; task: string | null };

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS waiting (id INTEGER PRIMARY KEY, msg TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS told (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, source TEXT NOT NULL, task TEXT, kind TEXT NOT NULL, text TEXT NOT NULL);`);
  const kvGet = db.prepare(`SELECT v FROM kv WHERE k = ?`);
  const kvSet = db.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`);
  const add = db.prepare(`INSERT INTO waiting (msg) VALUES (?)`);
  const trim = db.prepare(`DELETE FROM waiting WHERE id NOT IN (SELECT id FROM waiting ORDER BY id DESC LIMIT 200)`);
  const list = db.prepare(`SELECT id, msg FROM waiting ORDER BY id`);
  const drop = db.prepare(`DELETE FROM waiting WHERE id = ?`);
  const addTold = db.prepare(`INSERT INTO told (at, source, task, kind, text) VALUES (?, ?, ?, ?, ?)`);
  const pruneTold = db.prepare(`DELETE FROM told WHERE at < ?`);
  const listTold = db.prepare(`SELECT id, at, source, task, kind, text FROM told WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?`);
  return {
    /** The ledger of what the owner was told: one row per message that reached them (a digest item once its digest went out). */
    told: (t: Told, now = Date.now()): void => {
      addTold.run(now, t.source, t.task ?? null, t.kind, clip(t.text, TOLD_MAX));
      pruneTold.run(now - 14 * 86_400_000);
    },
    recentTold: (days: number, limit: number, now = Date.now()) => listTold.all(now - days * 86_400_000, limit) as ToldRow[],
    getKv: (k: string): string | undefined => (kvGet.get(k) as { v: string } | undefined)?.v,
    setKv: (k: string, v: string): void => void kvSet.run(k, v),
    /** A message no channel could take (every one down): sent by the next retry that reaches one. */
    wait: (msg: unknown): void => { add.run(JSON.stringify(msg)); trim.run(); },
    waiting: (): { id: number; msg: unknown }[] => (list.all() as { id: number; msg: string }[]).map((r) => ({ id: r.id, msg: JSON.parse(r.msg) })),
    done: (id: number): void => void drop.run(id),
  };
}
export type Store = ReturnType<typeof openStore>;
