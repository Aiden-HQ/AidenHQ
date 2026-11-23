import Database from "better-sqlite3";

export function openStore(path: string) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);`);

  const kvGet = db.prepare(`SELECT v FROM kv WHERE k = ?`);
  const kvSet = db.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`);
  const kvDel = db.prepare(`DELETE FROM kv WHERE k = ?`);
  const kvList = db.prepare(`SELECT k, v FROM kv WHERE substr(k, 1, ?) = ? ORDER BY k`);

  return {
    db,
    getKv: (k: string): string | undefined => (kvGet.get(k) as { v: string } | undefined)?.v,
    setKv: (k: string, v: string): void => void kvSet.run(k, v),
    delKv: (k: string): void => void kvDel.run(k),
    listKv: (prefix: string): { k: string; v: string }[] => kvList.all(prefix.length, prefix) as { k: string; v: string }[],
  };
}
export type Store = ReturnType<typeof openStore>;
