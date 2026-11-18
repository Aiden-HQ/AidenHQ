// The router's own state: key-values (dedupe stamps, attention counts, the digest queue) and the messages waiting for a
// channel to come back.
import Database from "better-sqlite3";

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS waiting (id INTEGER PRIMARY KEY, msg TEXT NOT NULL);`);
  const kvGet = db.prepare(`SELECT v FROM kv WHERE k = ?`);
  const kvSet = db.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`);
  const add = db.prepare(`INSERT INTO waiting (msg) VALUES (?)`);
  const trim = db.prepare(`DELETE FROM waiting WHERE id NOT IN (SELECT id FROM waiting ORDER BY id DESC LIMIT 200)`);
  const list = db.prepare(`SELECT id, msg FROM waiting ORDER BY id`);
  const drop = db.prepare(`DELETE FROM waiting WHERE id = ?`);
  return {
    getKv: (k: string): string | undefined => (kvGet.get(k) as { v: string } | undefined)?.v,
    setKv: (k: string, v: string): void => void kvSet.run(k, v),
    /** A message no channel could take (every one down): sent by the next retry that reaches one. */
    wait: (msg: unknown): void => { add.run(JSON.stringify(msg)); trim.run(); },
    waiting: (): { id: number; msg: unknown }[] => (list.all() as { id: number; msg: string }[]).map((r) => ({ id: r.id, msg: JSON.parse(r.msg) })),
    done: (id: number): void => void drop.run(id),
  };
}
export type Store = ReturnType<typeof openStore>;
