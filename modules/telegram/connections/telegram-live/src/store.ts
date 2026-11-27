// One SQLite file, /data/telegram-live.sqlite (WAL), separate from TDLib's folder.
import Database from "better-sqlite3";

export interface Store {
  db: Database.Database;
  /** One better-sqlite3 transaction. */
  tx<T>(fn: () => T): T;
  getKv(k: string): string | undefined;
  setKv(k: string, v: string): void;
}

export function openStore(path: string): Store {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

    -- the exactly-once guard; outgoing feeds the filter's isOwnMessage
    CREATE TABLE IF NOT EXISTS ingested (
      chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, outgoing INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_id, message_id));

    CREATE TABLE IF NOT EXISTS checkpoint (chat_id INTEGER PRIMARY KEY, last_message_id INTEGER NOT NULL);

    -- reply-chain roots
    CREATE TABLE IF NOT EXISTS msg_root (
      chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, root_id INTEGER NOT NULL,
      PRIMARY KEY (chat_id, message_id));

    -- a row is deleted when its drain lands
    CREATE TABLE IF NOT EXISTS outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      target TEXT NOT NULL CHECK (target IN ('warehouse', 'kernel')),
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS outbox_target_seq ON outbox (target, seq);

    CREATE TABLE IF NOT EXISTS backfill (
      chat_id INTEGER PRIMARY KEY, from_message_id INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      flood_until INTEGER, order_key INTEGER);

    -- final ids of executor sends
    CREATE TABLE IF NOT EXISTS agent_sent (
      chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, PRIMARY KEY (chat_id, message_id));

    -- ingest fills final_message_id / error; the executor alone writes the writes table
    CREATE TABLE IF NOT EXISTS agent_pending (
      chat_id INTEGER NOT NULL, temp_message_id INTEGER NOT NULL, write_id TEXT NOT NULL,
      final_message_id INTEGER, error TEXT,
      PRIMARY KEY (chat_id, temp_message_id));

    CREATE TABLE IF NOT EXISTS writes (
      id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('sending', 'done', 'failed', 'unknown')),
      chat_id INTEGER, message_id INTEGER, text TEXT, at INTEGER NOT NULL);

    -- the send rate cap
    CREATE TABLE IF NOT EXISTS send_log (at INTEGER NOT NULL, chat_id INTEGER NOT NULL);
  `);

  const kvGet = db.prepare(`SELECT v FROM kv WHERE k = ?`);
  const kvSet = db.prepare(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`);
  return {
    db,
    tx: <T>(fn: () => T): T => db.transaction(fn)(),
    getKv: (k) => (kvGet.get(k) as { v: string } | undefined)?.v,
    setKv: (k, v) => void kvSet.run(k, v),
  };
}
